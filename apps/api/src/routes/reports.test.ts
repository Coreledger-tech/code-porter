import type { Router } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => {
  return {
    queryMock: vi.fn()
  };
});

vi.mock("../db/client.js", () => {
  return {
    query: queryMock
  };
});

import { reportsRouter } from "./reports.js";

type MockRes = {
  statusCode: number;
  body?: unknown;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
};

function createMockRes(): MockRes {
  return {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    }
  };
}

function findRouteHandler(router: Router, method: "get", path: string) {
  const layer = (router as any).stack.find((item: any) => {
    return item.route?.path === path && item.route?.methods?.[method];
  });

  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }

  return layer.route.stack[0].handle as (req: any, res: any, next: any) => Promise<unknown>;
}

describe("reportsRouter", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("returns pilot report aggregates", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ status: "completed", count: 6 }, { status: "blocked", count: 2 }] })
      .mockResolvedValueOnce({
        rows: [
          { failure_kind: "code_compile_failure", count: 3 },
          { failure_kind: "code_test_failure", count: 2 }
        ]
      })
      .mockResolvedValueOnce({ rows: [{ failure_kind: "code_compile_failure", count: 2 }] })
      .mockResolvedValueOnce({ rows: [{ opened: 5, merged: 3, closed_unmerged: 1, open: 1 }] })
      .mockResolvedValueOnce({ rows: [{ sample_size: 3, p50_hours: 10.5, p90_hours: 20.25 }] })
      .mockResolvedValueOnce({ rows: [{ total_runs: 8, retried_runs: 2 }] })
      .mockResolvedValueOnce({
        rows: [{ project_id: "p1", project_name: "demo", total_runs: 8, blocked_runs: 2, blocked_rate: 0.25 }]
      })
      .mockResolvedValueOnce({ rows: [{ total_apply_runs: 12, cohort_apply_runs: 8 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            keeper_chosen: 4,
            keeper_merged: 2,
            merge_ready: 3,
            superseded_closed_count: 5
          }
        ]
      })
      .mockResolvedValueOnce({
        rows: [
          {
            project_id: "p2",
            project_name: "coverage-demo",
            repo: "coverage-demo",
            run_id: "run-2",
            status: "needs_review",
            selected_build_system: "go",
            build_system_disposition: "excluded_by_policy",
            gradle_project_type: null,
            gradle_wrapper_path: null,
            coverage_outcome: null,
            unsupported_reason: null,
            recommended_next_lane: null,
            failure_kind: "unsupported_build_system",
            blocked_reason: "Go is outside the current pilot lane",
            pr_url: null
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [{ failure_kind: "code_compile_failure" }] });

    const handler = findRouteHandler(reportsRouter(), "get", "/reports/pilot");
    const res = createMockRes();

    await handler({ query: { window: "30d", cohort: "coverage" } }, res, vi.fn());

    expect(res.statusCode).toBe(200);
    expect((res.body as any).window).toBe("30d");
    expect((res.body as any).cohort).toBe("coverage");
    expect((res.body as any).cohortCounts).toEqual({
      totalApplyRuns: 12,
      cohortApplyRuns: 8,
      excludedApplyRuns: 4
    });
    expect((res.body as any).totalsByStatus.completed).toBe(6);
    expect((res.body as any).topFailureKinds[0]).toEqual({
      failureKind: "code_compile_failure",
      count: 3
    });
    expect((res.body as any).prOutcomes.mergeRate).toBeCloseTo(0.6);
    expect((res.body as any).timeToGreen.p50Hours).toBeCloseTo(10.5);
    expect((res.body as any).retryRate.rate).toBeCloseTo(0.25);
    expect((res.body as any).keeperOutcomes).toEqual({
      keeperChosen: 4,
      keeperMerged: 2,
      mergeReady: 3,
      supersededClosedCount: 5
    });
    expect((res.body as any).coverageEntries).toEqual([
      {
        projectId: "p2",
        projectName: "coverage-demo",
        repo: "coverage-demo",
        runId: "run-2",
        selectedBuildSystem: "go",
        buildSystemDisposition: "excluded_by_policy",
        gradleProjectType: null,
        coverageOutcome: "excluded",
        unsupportedReason: "unsupported_build_system_go",
        recommendedNextLane: "go_readiness_lane",
        failureKind: "unsupported_build_system",
        blockedReason: "Go is outside the current pilot lane",
        prUrl: null
      }
    ]);
    expect((res.body as any).coverageSummary).toEqual({
      byOutcome: { excluded: 1 },
      byReason: { unsupported_build_system_go: 1 },
      byRecommendation: { go_readiness_lane: 1 }
    });
    expect((res.body as any).worstOffendersByProject).toHaveLength(1);
    expect((res.body as any).worstOffendersByProject[0]).toMatchObject({
      projectId: "p1",
      topFailureKind: "code_compile_failure"
    });
    expect(queryMock.mock.calls[1]?.[0]).toContain("and r.status <> 'completed'");
    expect(queryMock.mock.calls[1]?.[0]).toContain("manual_review_required");
  });

  it("rejects unsupported window", async () => {
    const handler = findRouteHandler(reportsRouter(), "get", "/reports/pilot");
    const res = createMockRes();

    await handler({ query: { window: "90d" } }, res, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "invalid window, expected one of: 7d, 30d"
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported cohort", async () => {
    const handler = findRouteHandler(reportsRouter(), "get", "/reports/pilot");
    const res = createMockRes();

    await handler({ query: { window: "7d", cohort: "bad" } }, res, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "invalid cohort, expected one of: all, actionable_maven, coverage"
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns empty coverage entries for actionable_maven cohort", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ opened: 0, merged: 0, closed_unmerged: 0, open: 0 }] })
      .mockResolvedValueOnce({ rows: [{ sample_size: 0, p50_hours: null, p90_hours: null }] })
      .mockResolvedValueOnce({ rows: [{ total_runs: 0, retried_runs: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total_apply_runs: 4, cohort_apply_runs: 0 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            keeper_chosen: 0,
            keeper_merged: 0,
            merge_ready: 0,
            superseded_closed_count: 0
          }
        ]
      });

    const handler = findRouteHandler(reportsRouter(), "get", "/reports/pilot");
    const res = createMockRes();

    await handler({ query: { window: "30d", cohort: "actionable_maven" } }, res, vi.fn());

    expect(res.statusCode).toBe(200);
    expect((res.body as any).coverageEntries).toEqual([]);
    expect((res.body as any).coverageSummary).toEqual({
      byOutcome: {},
      byReason: {},
      byRecommendation: {}
    });
  });
});
