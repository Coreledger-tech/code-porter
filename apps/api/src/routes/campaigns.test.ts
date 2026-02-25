import type { Router } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, executeCampaignRunMock } = vi.hoisted(() => {
  return {
    queryMock: vi.fn(),
    executeCampaignRunMock: vi.fn()
  };
});

vi.mock("../db/client.js", () => {
  return { query: queryMock };
});

vi.mock("../workflow-service.js", () => {
  return { executeCampaignRun: executeCampaignRunMock };
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
    executeCampaignRunMock.mockReset();
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
    executeCampaignRunMock
      .mockResolvedValueOnce({ runId: "run-plan", status: "completed" })
      .mockResolvedValueOnce({ runId: "run-apply", status: "needs_review" });

    const planHandler = findRouteHandler(campaignsRouter(), "post", "/campaigns/:id/plan");
    const applyHandler = findRouteHandler(campaignsRouter(), "post", "/campaigns/:id/apply");

    const planRes = createMockRes();
    await planHandler({ params: { id: "campaign-1" } }, planRes);

    const applyRes = createMockRes();
    await applyHandler({ params: { id: "campaign-1" } }, applyRes);

    expect(planRes.statusCode).toBe(202);
    expect(planRes.body).toEqual({ runId: "run-plan", status: "completed" });

    expect(applyRes.statusCode).toBe(202);
    expect(applyRes.body).toEqual({
      runId: "run-apply",
      status: "needs_review"
    });
  });
});
