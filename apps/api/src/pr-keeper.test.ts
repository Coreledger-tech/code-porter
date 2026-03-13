import { describe, expect, it } from "vitest";
import {
  buildSupersededComment,
  chooseKeeperCandidate,
  inferChecklist,
  type KeeperCandidate
} from "./pr-keeper.js";

describe("pr-keeper", () => {
  it("chooses the keeper deterministically by checklist, status, churn, and recency", () => {
    const candidates: KeeperCandidate[] = [
      {
        runId: "run-1",
        prNumber: 11,
        prUrl: "https://github.com/acme/demo/pull/11",
        status: "needs_review",
        mergeChecklist: { passed: true, reasons: [] },
        changedFiles: 2,
        changedLines: 20,
        finishedAt: "2026-03-12T08:00:00.000Z"
      },
      {
        runId: "run-2",
        prNumber: 12,
        prUrl: "https://github.com/acme/demo/pull/12",
        status: "completed",
        mergeChecklist: { passed: true, reasons: [] },
        changedFiles: 1,
        changedLines: 8,
        finishedAt: "2026-03-12T09:00:00.000Z"
      },
      {
        runId: "run-3",
        prNumber: 13,
        prUrl: "https://github.com/acme/demo/pull/13",
        status: "completed",
        mergeChecklist: { passed: false, reasons: ["missing verify.json"] },
        changedFiles: 1,
        changedLines: 4,
        finishedAt: "2026-03-12T10:00:00.000Z"
      }
    ];

    expect(chooseKeeperCandidate(candidates).runId).toBe("run-2");
  });

  it("falls back to completed status when legacy summaries lack mergeChecklist", () => {
    expect(inferChecklist({}, "completed")).toEqual({
      passed: true,
      reasons: []
    });
    expect(inferChecklist({}, "needs_review")).toEqual({
      passed: false,
      reasons: []
    });
  });

  it("builds a deterministic superseded comment", () => {
    expect(buildSupersededComment(24)).toBe(
      "Superseded by #24 (keeper for this pilot window)."
    );
  });
});
