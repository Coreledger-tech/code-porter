import type { Router } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  queryMock,
  enqueueCampaignRunMock,
  pauseCampaignMock,
  resumeCampaignMock,
  RunThrottleError,
  CampaignPausedError
} = vi.hoisted(() => {
  class RunThrottleError extends Error {
    limitType: "project" | "global";
    currentInflight: number;
    limit: number;
    retryHint: string;

    constructor(input: {
      limitType: "project" | "global";
      currentInflight: number;
      limit: number;
      retryHint: string;
    }) {
      super("throttled");
      this.limitType = input.limitType;
      this.currentInflight = input.currentInflight;
      this.limit = input.limit;
      this.retryHint = input.retryHint;
    }
  }

  class CampaignPausedError extends Error {
    campaignId: string;
    lifecycleStatus: "paused";

    constructor(campaignId: string) {
      super("paused");
      this.campaignId = campaignId;
      this.lifecycleStatus = "paused";
    }
  }

  return {
    queryMock: vi.fn(),
    enqueueCampaignRunMock: vi.fn(),
    pauseCampaignMock: vi.fn(),
    resumeCampaignMock: vi.fn(),
    RunThrottleError,
    CampaignPausedError
  };
});

vi.mock("../db/client.js", () => {
  return { query: queryMock };
});

vi.mock("../workflow-service.js", () => {
  return {
    enqueueCampaignRun: enqueueCampaignRunMock,
    pauseCampaign: pauseCampaignMock,
    resumeCampaign: resumeCampaignMock,
    RunThrottleError,
    CampaignPausedError
  };
});

import { campaignsRouter } from "./campaigns.js";

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

function findRouteHandler(router: Router, method: "post" | "get", path: string) {
  const layer = (router as any).stack.find((item: any) => {
    return item.route?.path === path && item.route?.methods?.[method];
  });

  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }

  return layer.route.stack[0].handle as (req: any, res: any) => Promise<unknown>;
}

describe("campaignsRouter", () => {
  beforeEach(() => {
    queryMock.mockReset();
    enqueueCampaignRunMock.mockReset();
    pauseCampaignMock.mockReset();
    resumeCampaignMock.mockReset();
  });

  it("rejects campaign creation when project is missing", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const handler = findRouteHandler(campaignsRouter(), "post", "/campaigns");
    const res = createMockRes();

    await handler(
      {
        body: {
          projectId: "project-missing",
          policyId: "default",
          recipePack: "java-maven-core"
        }
      },
      res
    );

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "project not found" });
  });

  it("creates campaign when project and policy exist", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "project-1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "default" }] })
      .mockResolvedValueOnce({ rows: [] });

    const handler = findRouteHandler(campaignsRouter(), "post", "/campaigns");
    const res = createMockRes();

    await handler(
      {
        body: {
          projectId: "project-1",
          policyId: "default",
          recipePack: "java-maven-core",
          targetSelector: "main"
        }
      },
      res
    );

    expect(res.statusCode).toBe(201);
    expect((res.body as any).projectId).toBe("project-1");
    expect((res.body as any).policyId).toBe("default");
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it("starts plan and apply runs", async () => {
    enqueueCampaignRunMock
      .mockResolvedValueOnce({ runId: "run-plan", status: "queued" })
      .mockResolvedValueOnce({ runId: "run-apply", status: "queued" });

    const planHandler = findRouteHandler(campaignsRouter(), "post", "/campaigns/:id/plan");
    const applyHandler = findRouteHandler(campaignsRouter(), "post", "/campaigns/:id/apply");

    const planRes = createMockRes();
    await planHandler({ params: { id: "campaign-1" } }, planRes);

    const applyRes = createMockRes();
    await applyHandler({ params: { id: "campaign-1" } }, applyRes);

    expect(planRes.statusCode).toBe(202);
    expect(planRes.body).toEqual({ runId: "run-plan", status: "queued" });

    expect(applyRes.statusCode).toBe(202);
    expect(applyRes.body).toEqual({
      runId: "run-apply",
      status: "queued"
    });
  });

  it("returns 429 when run start is throttled", async () => {
    enqueueCampaignRunMock.mockRejectedValueOnce(
      new RunThrottleError({
        limitType: "project",
        currentInflight: 2,
        limit: 2,
        retryHint: "Retry later"
      })
    );

    const handler = findRouteHandler(campaignsRouter(), "post", "/campaigns/:id/apply");
    const res = createMockRes();

    await handler({ params: { id: "campaign-1" } }, res);

    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({
      error: "run start throttled by policy",
      limitType: "project",
      currentInflight: 2,
      limit: 2,
      retryHint: "Retry later"
    });
  });

  it("returns 409 when campaign is paused for enqueue", async () => {
    enqueueCampaignRunMock.mockRejectedValueOnce(new CampaignPausedError("campaign-1"));

    const handler = findRouteHandler(campaignsRouter(), "post", "/campaigns/:id/apply");
    const res = createMockRes();

    await handler({ params: { id: "campaign-1" } }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: "campaign is paused",
      campaignId: "campaign-1",
      lifecycleStatus: "paused"
    });
  });

  it("pauses and resumes campaign", async () => {
    pauseCampaignMock.mockResolvedValueOnce({
      campaignId: "campaign-1",
      lifecycleStatus: "paused",
      pausedAt: "2026-02-26T00:00:00.000Z"
    });
    resumeCampaignMock.mockResolvedValueOnce({
      campaignId: "campaign-1",
      lifecycleStatus: "active",
      resumedAt: "2026-02-26T00:01:00.000Z"
    });

    const pauseHandler = findRouteHandler(campaignsRouter(), "post", "/campaigns/:id/pause");
    const resumeHandler = findRouteHandler(campaignsRouter(), "post", "/campaigns/:id/resume");

    const pauseRes = createMockRes();
    await pauseHandler({ params: { id: "campaign-1" } }, pauseRes);
    expect(pauseRes.statusCode).toBe(200);
    expect((pauseRes.body as any).lifecycleStatus).toBe("paused");

    const resumeRes = createMockRes();
    await resumeHandler({ params: { id: "campaign-1" } }, resumeRes);
    expect(resumeRes.statusCode).toBe(200);
    expect((resumeRes.body as any).lifecycleStatus).toBe("active");
  });

  it("returns campaign summary aggregates", async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: "campaign-1",
            project_id: "project-1",
            policy_id: "default",
            recipe_pack: "java-maven-core",
            target_selector: "main",
            lifecycle_status: "active"
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [{ status: "completed", count: 3 }] })
      .mockResolvedValueOnce({ rows: [{ failure_kind: "unknown", count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ p50_sec: 12, p95_sec: 30 }] })
      .mockResolvedValueOnce({ rows: [{ retry_count: 1, cancelled_count: 0 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            run_id: "run-1",
            status: "completed",
            queue_status: "completed",
            started_at: "2026-02-26T00:00:00.000Z",
            finished_at: "2026-02-26T00:00:12.000Z",
            duration_sec: 12,
            pr_url: null
          }
        ]
      });

    const handler = findRouteHandler(campaignsRouter(), "get", "/campaigns/:id/summary");
    const res = createMockRes();

    await handler({ params: { id: "campaign-1" }, query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).campaignId).toBe("campaign-1");
    expect((res.body as any).totalsByStatus.completed).toBe(3);
    expect((res.body as any).recentRuns).toHaveLength(1);
  });
});
