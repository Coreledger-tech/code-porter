import type { MergeChecklistSummary, RunStatus } from "@code-porter/core/src/models.js";

export interface KeeperCandidate {
  runId: string;
  prNumber: number;
  prUrl: string;
  status: RunStatus;
  mergeChecklist: MergeChecklistSummary;
  changedFiles: number;
  changedLines: number;
  finishedAt?: string | null;
}

const STATUS_RANK: Record<RunStatus, number> = {
  queued: 0,
  running: 0,
  cancelling: 0,
  cancelled: 1,
  failed: 2,
  blocked: 3,
  needs_review: 4,
  completed: 5
};

export function inferChecklist(summary: Record<string, unknown>, status: RunStatus): MergeChecklistSummary {
  const raw =
    summary.mergeChecklist && typeof summary.mergeChecklist === "object"
      ? (summary.mergeChecklist as Record<string, unknown>)
      : null;

  if (raw && typeof raw.passed === "boolean") {
    return {
      passed: raw.passed,
      reasons: Array.isArray(raw.reasons)
        ? raw.reasons.filter((value): value is string => typeof value === "string")
        : []
    };
  }

  return {
    passed: status === "completed",
    reasons: []
  };
}

function finishedAtValue(value?: string | null): number {
  if (!value) {
    return 0;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function compareKeeperCandidates(left: KeeperCandidate, right: KeeperCandidate): number {
  if (left.mergeChecklist.passed !== right.mergeChecklist.passed) {
    return left.mergeChecklist.passed ? -1 : 1;
  }

  const leftRank = STATUS_RANK[left.status] ?? 0;
  const rightRank = STATUS_RANK[right.status] ?? 0;
  if (leftRank !== rightRank) {
    return rightRank - leftRank;
  }

  if (left.changedFiles !== right.changedFiles) {
    return left.changedFiles - right.changedFiles;
  }

  if (left.changedLines !== right.changedLines) {
    return left.changedLines - right.changedLines;
  }

  return finishedAtValue(right.finishedAt) - finishedAtValue(left.finishedAt);
}

export function chooseKeeperCandidate(candidates: KeeperCandidate[]): KeeperCandidate {
  if (candidates.length === 0) {
    throw new Error("Keeper selection requires at least one candidate");
  }

  return [...candidates].sort(compareKeeperCandidates)[0];
}

export function buildSupersededComment(keeperPrNumber: number): string {
  return `Superseded by #${keeperPrNumber} (keeper for this pilot window).`;
}
