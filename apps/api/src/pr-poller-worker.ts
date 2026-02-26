import { createGitHubAuthProvider } from "@code-porter/workspace/src/index.js";
import { query } from "./db/client.js";
import { logError, logInfo, logWarn } from "./observability/logger.js";
import { redactSecrets } from "./observability/redact.js";
import { appendRunEvent } from "./workflow-service.js";

interface PrPollCandidateRow {
  id: string;
  pr_url: string;
  pr_number: number | null;
  pr_state: "open" | "merged" | "closed" | null;
}

interface GitHubPullResponse {
  number?: number;
  state?: "open" | "closed";
  merged_at?: string | null;
  closed_at?: string | null;
  created_at?: string | null;
}

interface PullReference {
  owner: string;
  repo: string;
  pullNumber: number;
}

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

function parsePullReference(prUrl: string): PullReference | null {
  const match = prUrl.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/i
  );
  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
    pullNumber: Number(match[3])
  };
}

function mapPrState(payload: GitHubPullResponse): "open" | "merged" | "closed" {
  if (payload.merged_at) {
    return "merged";
  }

  if (payload.state === "closed") {
    return "closed";
  }

  return "open";
}

export class PrLifecyclePollerWorker {
  private readonly pollMs: number;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly githubApiUrl: string;
  private readonly authProvider = createGitHubAuthProvider();
  private stopping = false;

  constructor(input?: {
    pollMs?: number;
    batchSize?: number;
    timeoutMs?: number;
    githubApiUrl?: string;
  }) {
    this.pollMs = input?.pollMs ?? readNumberEnv("PR_POLL_INTERVAL_MS", 60_000);
    this.batchSize = input?.batchSize ?? readNumberEnv("PR_POLL_BATCH_SIZE", 100);
    this.timeoutMs = input?.timeoutMs ?? readNumberEnv("PR_POLL_TIMEOUT_MS", 3_000);
    this.githubApiUrl =
      input?.githubApiUrl ?? process.env.GITHUB_API_URL?.trim() ?? "https://api.github.com";
  }

  stop(): void {
    this.stopping = true;
  }

  async start(): Promise<void> {
    this.stopping = false;

    logInfo("pr_poller_started", "PR lifecycle poller started", undefined, {
      pollMs: this.pollMs,
      batchSize: this.batchSize,
      timeoutMs: this.timeoutMs
    });

    while (!this.stopping) {
      try {
        const updated = await this.pollOnce();
        if (updated > 0) {
          logInfo("pr_poller_batch", "PR lifecycle poller updated runs", undefined, {
            updated
          });
        }
      } catch (error) {
        logError("pr_poller_loop_error", "PR lifecycle poller loop failed", undefined, {
          error: redactSecrets(error instanceof Error ? error.message : String(error))
        });
      }

      if (!this.stopping) {
        await sleep(this.pollMs);
      }
    }

    logInfo("pr_poller_stopped", "PR lifecycle poller stopped");
  }

  async pollOnce(): Promise<number> {
    const candidates = await query<PrPollCandidateRow>(
      `select id, pr_url, pr_number, pr_state
       from runs
       where pr_url is not null
         and coalesce(pr_state, 'open') = 'open'
         and status in ('completed', 'needs_review', 'blocked', 'failed', 'cancelled')
       order by started_at asc
       limit $1`,
      [this.batchSize]
    );

    if (candidates.rows.length === 0) {
      return 0;
    }

    let token: string;
    try {
      token = await this.authProvider.getToken();
    } catch (error) {
      logWarn("pr_poller_auth_failed", "PR lifecycle poller could not obtain GitHub token", undefined, {
        error: redactSecrets(error instanceof Error ? error.message : String(error))
      });
      return 0;
    }

    let updated = 0;

    for (const row of candidates.rows) {
      const parsed = parsePullReference(row.pr_url);
      if (!parsed) {
        logWarn("pr_poller_invalid_pr_url", "Skipping run with non-GitHub PR URL", { runId: row.id }, {
          prUrl: row.pr_url
        });
        continue;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(
          `${this.githubApiUrl.replace(/\/+$/, "")}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.pullNumber}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "code-porter"
            },
            signal: controller.signal
          }
        );

        if (!response.ok) {
          logWarn("pr_poller_fetch_failed", "Failed to fetch GitHub pull request", { runId: row.id }, {
            status: response.status,
            prUrl: row.pr_url
          });
          continue;
        }

        const payload = (await response.json()) as GitHubPullResponse;
        const mappedState = mapPrState(payload);
        const previousState = row.pr_state ?? "open";
        const prNumber = Number.isInteger(payload.number)
          ? Number(payload.number)
          : row.pr_number ?? parsed.pullNumber;

        const prOpenedAt = payload.created_at ?? null;
        const mergedAt = payload.merged_at ?? null;
        const closedAt = payload.closed_at ?? payload.merged_at ?? null;

        await query(
          `update runs
           set pr_number = coalesce(pr_number, $2),
               pr_state = $3,
               pr_opened_at = coalesce(pr_opened_at, $4::timestamptz),
               merged_at = case
                 when $3 = 'merged' then coalesce(merged_at, $5::timestamptz)
                 else merged_at
               end,
               closed_at = case
                 when $3 in ('merged', 'closed') then coalesce(closed_at, $6::timestamptz, $5::timestamptz)
                 else closed_at
               end,
               last_ci_checked_at = now(),
               summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object('prState', $3)
           where id = $1`,
          [
            row.id,
            prNumber,
            mappedState,
            prOpenedAt,
            mergedAt,
            closedAt
          ]
        );

        updated += 1;

        if (previousState !== mappedState) {
          await appendRunEvent(row.id, {
            level: "info",
            eventType: "lifecycle",
            step: "pr_poll",
            message: `Pull request state changed to ${mappedState}`,
            payload: {
              previousState,
              newState: mappedState,
              prNumber,
              prUrl: row.pr_url
            }
          });
        }
      } catch (error) {
        logWarn("pr_poller_request_error", "Failed to poll pull request status", { runId: row.id }, {
          error: redactSecrets(error instanceof Error ? error.message : String(error)),
          prUrl: row.pr_url
        });
      } finally {
        clearTimeout(timeout);
      }
    }

    return updated;
  }
}
