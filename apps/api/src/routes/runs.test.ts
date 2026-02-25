import type { Router } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => {
  return { queryMock: vi.fn() };
});

vi.mock("../db/client.js", () => {
  return { query: queryMock };
});

import { runsRouter } from "./runs.js";

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

describe("runsRouter", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("returns 404 for missing run", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const handler = findRouteHandler(runsRouter(), "get", "/runs/:id");
    const res = createMockRes();

    await handler({ params: { id: "missing-run" } }, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "run not found" });
  });

  it("returns run details with evidence artifacts", async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: "run-1",
            campaign_id: "campaign-1",
            status: "completed",
            confidence_score: 80,
            evidence_path: "/tmp/evidence/run-1",
            branch_name: "codeporter/campaign-1/run-1",
            summary: { status: "completed" }
          }
        ]
      })
      .mockResolvedValueOnce({
        rows: [{ type: "verify.json", path: "/tmp/evidence/run-1/verify.json" }]
      });

    const handler = findRouteHandler(runsRouter(), "get", "/runs/:id");
    const res = createMockRes();

    await handler({ params: { id: "run-1" } }, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe("run-1");
    expect((res.body as any).evidenceArtifacts).toHaveLength(1);
  });
});
