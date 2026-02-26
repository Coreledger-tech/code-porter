import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics
} from "prom-client";

const register = new Registry();
collectDefaultMetrics({ register });

const runsEnqueuedTotal = new Counter({
  name: "codeporter_runs_enqueued_total",
  help: "Total runs enqueued",
  labelNames: ["mode"] as const,
  registers: [register]
});

const runOutcomesTotal = new Counter({
  name: "codeporter_run_outcomes_total",
  help: "Total run outcomes by mode and status",
  labelNames: ["mode", "status"] as const,
  registers: [register]
});

const runFailuresTotal = new Counter({
  name: "codeporter_run_failures_total",
  help: "Total run failures by failure kind",
  labelNames: ["failure_kind"] as const,
  registers: [register]
});

const workerClaimsTotal = new Counter({
  name: "codeporter_worker_claims_total",
  help: "Total worker queue claim attempts",
  labelNames: ["result"] as const,
  registers: [register]
});

const queueDepthGauge = new Gauge({
  name: "codeporter_queue_depth",
  help: "Current queued jobs count",
  registers: [register]
});

const verifierRetriesTotal = new Counter({
  name: "codeporter_verifier_retries_total",
  help: "Total verifier retries by build system and retry reason",
  labelNames: ["build_system", "retry_reason"] as const,
  registers: [register]
});

const remediationActionsTotal = new Counter({
  name: "codeporter_remediation_actions_total",
  help: "Total deterministic remediation actions",
  labelNames: ["action", "status"] as const,
  registers: [register]
});

const runDurationSeconds = new Histogram({
  name: "codeporter_run_duration_seconds",
  help: "Run duration in seconds",
  labelNames: ["mode", "status"] as const,
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
  registers: [register]
});

const runsCancelledTotal = new Counter({
  name: "codeporter_runs_cancelled_total",
  help: "Total cancelled runs by mode",
  labelNames: ["mode"] as const,
  registers: [register]
});

const queueRetriesTotal = new Counter({
  name: "codeporter_queue_retries_total",
  help: "Total queue retries by reason",
  labelNames: ["reason"] as const,
  registers: [register]
});

const queueLeaseReclaimsTotal = new Counter({
  name: "codeporter_queue_lease_reclaims_total",
  help: "Total queue lease reclaims",
  registers: [register]
});

export const metrics = {
  incrementRunsEnqueued(mode: string): void {
    runsEnqueuedTotal.inc({ mode });
  },
  incrementRunOutcome(mode: string, status: string): void {
    runOutcomesTotal.inc({ mode, status });
  },
  incrementRunFailure(failureKind: string): void {
    runFailuresTotal.inc({ failure_kind: failureKind || "unknown" });
  },
  incrementWorkerClaim(result: string): void {
    workerClaimsTotal.inc({ result });
  },
  setQueueDepth(depth: number): void {
    queueDepthGauge.set(depth);
  },
  incrementVerifierRetry(buildSystem: string, retryReason: string): void {
    verifierRetriesTotal.inc({
      build_system: buildSystem || "unknown",
      retry_reason: retryReason || "unknown"
    });
  },
  incrementRemediationAction(action: string, status: string): void {
    remediationActionsTotal.inc({ action: action || "unknown", status: status || "unknown" });
  },
  observeRunDuration(mode: string, status: string, seconds: number): void {
    if (Number.isFinite(seconds) && seconds >= 0) {
      runDurationSeconds.observe({ mode, status }, seconds);
    }
  },
  incrementRunsCancelled(mode: string): void {
    runsCancelledTotal.inc({ mode: mode || "unknown" });
  },
  incrementQueueRetry(reason: string): void {
    queueRetriesTotal.inc({ reason: reason || "unknown" });
  },
  incrementQueueLeaseReclaim(): void {
    queueLeaseReclaimsTotal.inc();
  },
  async render(): Promise<string> {
    return register.metrics();
  },
  contentType(): string {
    return register.contentType;
  }
};
