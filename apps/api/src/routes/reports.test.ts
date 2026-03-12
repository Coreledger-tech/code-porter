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
      .mockResolvedValueOnce({ rows: [{ failure_kind: "code_compile_failure" }] });

    const handler = findRouteHandler(reportsRouter(), "get", "/reports/pilot");
    const res = createMockRes();

    await handler({ query: { window: "30d", cohort: "actionable_maven" } }, res, vi.fn());

    expect(res.statusCode).toBe(200);
    expect((res.body as any).window).toBe("30d");
    expect((res.body as any).cohort).toBe("actionable_maven");
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
    expect((res.body as any).worstOffendersByProject).toHaveLength(1);
    expect((res.body as any).worstOffendersByProject[0]).toMatchObject({
      projectId: "p1",
      topFailureKind: "code_compile_failure"
    });
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
});
