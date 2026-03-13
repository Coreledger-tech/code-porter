import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { metrics } from "./observability/metrics.js";
import { logError, logInfo, logWarn } from "./observability/logger.js";
import { redactSecrets } from "./observability/redact.js";
import { query } from "./db/client.js";
import {
  claimNextRunJob,
  completeRunJob,
  extendRunJobLease,
  getRunJobAttempts,
  queueDepth,
  requeueRunJob,
  type ClaimedRunJob
} from "./run-queue.js";
import { appendRunEvent, executeRunById } from "./workflow-service.js";

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function computeBackoffSeconds(input: {
  attemptCount: number;
  baseSeconds: number;
  maxSeconds: number;
}): number {
  const exponent = Math.max(0, input.attemptCount - 1);
  const delay = input.baseSeconds * 2 ** exponent;
  return Math.min(input.maxSeconds, delay);
}

export class AsyncRunWorker {
  private readonly workerId: string;
  private readonly pollMs: number;
  private readonly concurrency: number;
  private readonly leaseSeconds: number;
  private readonly heartbeatSeconds: number;
  private readonly backoffBaseSeconds: number;
  private readonly backoffMaxSeconds: number;
  private running = false;
  private stopping = false;

  constructor(input?: {
    workerId?: string;
    pollMs?: number;
    concurrency?: number;
    leaseSeconds?: number;
    heartbeatSeconds?: number;
    backoffBaseSeconds?: number;
    backoffMaxSeconds?: number;
  }) {
    this.workerId =
      input?.workerId ??
      `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.pollMs = input?.pollMs ?? readNumberEnv("RUN_WORKER_POLL_MS", 1000);
    this.concurrency = input?.concurrency ?? readNumberEnv("RUN_WORKER_CONCURRENCY", 1);
    this.leaseSeconds = input?.leaseSeconds ?? readNumberEnv("RUN_JOB_LEASE_SECONDS", 300);
    this.heartbeatSeconds =
      input?.heartbeatSeconds ?? readNumberEnv("RUN_JOB_HEARTBEAT_SECONDS", 30);
    this.backoffBaseSeconds =
      input?.backoffBaseSeconds ?? readNumberEnv("RUN_JOB_BACKOFF_BASE_SECONDS", 15);
    this.backoffMaxSeconds =
      input?.backoffMaxSeconds ?? readNumberEnv("RUN_JOB_BACKOFF_MAX_SECONDS", 300);
  }

  id(): string {
    return this.workerId;
  }

  async start(): Promise<void> {
    this.stopping = false;
    logInfo("worker_started", "Async run worker started", {
      workerId: this.workerId
    }, {
      pollMs: this.pollMs,
      concurrency: this.concurrency,
      leaseSeconds: this.leaseSeconds,
      heartbeatSeconds: this.heartbeatSeconds,
      backoffBaseSeconds: this.backoffBaseSeconds,
      backoffMaxSeconds: this.backoffMaxSeconds
    });

    while (!this.stopping) {
      this.running = true;
      try {
        await this.processAvailableJobs();
      } catch (error) {
        logError("worker_loop_error", "Worker loop error", { workerId: this.workerId }, {
          error: redactSecrets(error instanceof Error ? error.message : String(error))
        });
      } finally {
        this.running = false;
      }

      if (!this.stopping) {
        await sleep(this.pollMs);
      }
    }

    logInfo("worker_stopped", "Async run worker stopped", { workerId: this.workerId });
  }

  stop(): void {
    this.stopping = true;
  }

  async processAvailableJobs(): Promise<number> {
    const tasks = Array.from({ length: this.concurrency }, () => this.processSingleClaim());
    const results = await Promise.all(tasks);
    const processed = results.filter((count) => count > 0).length;
    metrics.setQueueDepth(await queueDepth());
    return processed;
  }

  private async processSingleClaim(): Promise<number> {
    const claimed = await claimNextRunJob({
      workerId: this.workerId,
      leaseSeconds: this.leaseSeconds
    });

    if (!claimed) {
      metrics.incrementWorkerClaim("empty");
      return 0;
    }

    metrics.incrementWorkerClaim("claimed");
    if (claimed.reclaimed) {
      metrics.incrementQueueLeaseReclaim();
    }

    await this.executeClaimedJob(claimed);
    return 1;
  }

  private async executeClaimedJob(job: ClaimedRunJob): Promise<void> {
    logInfo("worker_claimed", "Worker claimed run job", {
      runId: job.runId,
      campaignId: job.campaignId,
      workerId: this.workerId
    }, {
      attemptCount: job.attemptCount,
      maxAttempts: job.maxAttempts,
      reclaimed: job.reclaimed
    });

    let leaseLost = false;
    const executionAbortController = new AbortController();
    const abortExecution = (reason: string): void => {
      if (!executionAbortController.signal.aborted) {
        executionAbortController.abort(reason);
      }
    };
    const heartbeatHandle = setInterval(async () => {
      try {
        const extended = await extendRunJobLease({
          runId: job.runId,
          workerId: this.workerId,
          leaseSeconds: this.leaseSeconds
        });

        if (!extended) {
          leaseLost = true;
          abortExecution("worker lease lost during run execution");
          clearInterval(heartbeatHandle);
        }
      } catch (error) {
        logWarn("worker_lease_heartbeat_failed", "Lease heartbeat failed", {
          runId: job.runId,
          campaignId: job.campaignId,
          workerId: this.workerId
        }, {
          error: redactSecrets(error instanceof Error ? error.message : String(error))
        });
      }
    }, this.heartbeatSeconds * 1000);

    try {
      const result = await executeRunById(job.runId, this.workerId, {
        signal: executionAbortController.signal
      });
      const queueStatus =
        result.status === "failed"
          ? "failed"
          : result.status === "cancelled"
            ? "cancelled"
            : "completed";

      const completed = await completeRunJob({
        runId: job.runId,
        status: queueStatus,
        lastError:
          queueStatus === "failed" ? "run finished with failed status" : null,
        workerId: this.workerId
      });

      if (!completed) {
        logWarn("worker_complete_skipped", "Skipping completion update because lease ownership changed", {
          runId: job.runId,
          campaignId: job.campaignId,
          workerId: this.workerId
        });
      }

      if (result.status === "cancelled") {
        metrics.incrementRunsCancelled(job.mode);
      }

      logInfo("worker_completed", "Worker completed run job", {
        runId: job.runId,
        campaignId: job.campaignId,
        workerId: this.workerId
      }, {
        runStatus: result.status,
        queueStatus
      });
      return;
    } catch (error) {
      const safeMessage = redactSecrets(
        error instanceof Error ? error.message : "worker execution crashed"
      );

      if (leaseLost) {
        metrics.incrementRunFailure("lease_reclaimed");
        logWarn("worker_lease_lost", "Lease ownership lost while executing run", {
          runId: job.runId,
          campaignId: job.campaignId,
          workerId: this.workerId,
          failureKind: "lease_reclaimed"
        });
        return;
      }

      logError("worker_execute_error", "Worker execution error", {
        runId: job.runId,
        campaignId: job.campaignId,
        workerId: this.workerId,
        failureKind: "worker_crash"
      }, {
        error: safeMessage
      });

      const attempts = await getRunJobAttempts(job.runId);
      const currentAttempts = attempts?.attemptCount ?? job.attemptCount;
      const maxAttempts = attempts?.maxAttempts ?? job.maxAttempts;

      if (currentAttempts < maxAttempts) {
        const delaySeconds = computeBackoffSeconds({
          attemptCount: currentAttempts,
          baseSeconds: this.backoffBaseSeconds,
          maxSeconds: this.backoffMaxSeconds
        });
        const requeued = await requeueRunJob({
          runId: job.runId,
          delaySeconds,
          lastError: safeMessage,
          workerId: this.workerId
        });

        if (requeued) {
          metrics.incrementQueueRetry("worker_crash");
          await appendRunEvent(job.runId, {
            level: "warn",
            eventType: "warning",
            step: "run",
            message: "Worker execution crashed; run requeued",
            payload: {
              attemptCount: currentAttempts,
              maxAttempts,
              delaySeconds
            }
          });
        }

        logWarn("worker_requeued", "Run requeued after worker crash", {
          runId: job.runId,
          campaignId: job.campaignId,
          workerId: this.workerId
        }, {
          attemptCount: currentAttempts,
          maxAttempts,
          delaySeconds,
          requeued
        });
        return;
      }

      await completeRunJob({
        runId: job.runId,
        status: "failed",
        lastError: safeMessage,
        workerId: this.workerId
      });

      await query(
        `update runs
         set status = case
              when status in ('completed', 'needs_review', 'blocked', 'cancelled')
              then status
              else 'failed'
            end,
             summary = case
              when status in ('completed', 'needs_review', 'blocked', 'cancelled')
              then summary
              else jsonb_build_object(
                'status', 'failed',
                'error', $2,
                'failureKind', 'retry_exhausted'
              )
            end,
             finished_at = case
              when status in ('completed', 'needs_review', 'blocked', 'cancelled')
              then finished_at
              else now()
            end
         where id = $1`,
        [job.runId, safeMessage]
      );

      await appendRunEvent(job.runId, {
        level: "error",
        eventType: "error",
        step: "run",
        message: "Worker execution failed after max retry attempts",
        payload: {
          attemptCount: currentAttempts,
          maxAttempts
        }
      });

      metrics.incrementRunFailure("retry_exhausted");
    } finally {
      clearInterval(heartbeatHandle);
    }
  }

  isRunning(): boolean {
    return this.running && !this.stopping;
  }
}
