import type { Router } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, cancelRunMock } = vi.hoisted(() => {
  return { queryMock: vi.fn(), cancelRunMock: vi.fn() };
});

vi.mock("../db/client.js", () => {
  return { query: queryMock };
});

vi.mock("../workflow-service.js", () => {
  return { cancelRun: cancelRunMock };
});

import { runsRouter } from "./runs.js";

type MockRes = {
  statusCode: number;
  body?: unknown;
  redirectLocation?: string;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
  setHeader: (_name: string, _value: string) => void;
  redirect: (code: number, location: string) => MockRes;
  end: () => void;
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
    },
    setHeader() {
      // no-op
    },
    redirect(code: number, location: string) {
      this.statusCode = code;
      this.redirectLocation = location;
      return this;
    },
    end() {
      // no-op
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
    cancelRunMock.mockReset();
  });

  it("returns 404 for missing run", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const handler = findRouteHandler(runsRouter(), "get", "/runs/:id");
    const res = createMockRes();

    await handler({ params: { id: "missing-run" } }, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "run not found" });
  });

  it("returns run details with evidence URL metadata", async () => {
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
            pr_url: "https://github.com/org/repo/pull/1",
            pr_number: 1,
            pr_state: "open",
            pr_opened_at: "2026-02-25T00:00:00.000Z",
            merged_at: null,
            closed_at: null,
            last_ci_state: null,
            last_ci_checked_at: "2026-02-26T00:00:00.000Z",
            summary: { status: "completed" }
          }
        ]
      })
      .mockResolvedValueOnce({
        rows: [
          {
            type: "verify.json",
            path: "/tmp/evidence/run-1/verify.json",
            storage_type: "local_fs",
            bucket: null,
            object_key: null
          },
          {
            type: "evidence.zip",
            path: "/tmp/evidence-exports/run-1/evidence.zip",
            storage_type: "local_fs",
            bucket: null,
            object_key: null
          }
        ]
      })
      .mockResolvedValueOnce({
        rows: [
          {
            status: "running",
            lease_owner: "worker-1",
            leased_at: "2026-02-26T00:00:00.000Z",
            lease_expires_at: "2026-02-26T00:05:00.000Z"
          }
        ]
      })
      .mockResolvedValueOnce({
        rows: [{ step: "verify", created_at: "2026-02-26T00:00:00.000Z" }]
      });

    const handler = findRouteHandler(runsRouter(), "get", "/runs/:id");
    const res = createMockRes();

    await handler(
      {
        params: { id: "run-1" },
        protocol: "http",
        get: () => "localhost:3000"
      },
      res
    );

    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe("run-1");
    expect((res.body as any).prUrl).toBe("https://github.com/org/repo/pull/1");
    expect((res.body as any).prNumber).toBe(1);
    expect((res.body as any).prState).toBe("open");
    expect((res.body as any).prOpenedAt).toBe("2026-02-25T00:00:00.000Z");
    expect((res.body as any).lastCiCheckedAt).toBe("2026-02-26T00:00:00.000Z");
    expect((res.body as any).evidenceZipUrl).toContain("/runs/run-1/evidence.zip");
    expect((res.body as any).evidenceManifestUrl).toContain("/runs/run-1/evidence.manifest");
    expect((res.body as any).evidenceUrlMode).toBe("local_proxy");
    expect((res.body as any).evidenceStorage).toBe("local_fs");
    expect((res.body as any).queueStatus).toBe("running");
    expect((res.body as any).lease).toEqual({
      owner: "worker-1",
      leasedAt: "2026-02-26T00:00:00.000Z",
      leaseExpiresAt: "2026-02-26T00:05:00.000Z"
    });
    expect((res.body as any).currentStep).toBe("verify");
    expect((res.body as any).lastEventAt).toBe("2026-02-26T00:00:00.000Z");
    expect((res.body as any).evidenceArtifacts).toHaveLength(2);

    const eventsHandler = findRouteHandler(runsRouter(), "get", "/runs/:id/events");
    const eventsRes = createMockRes();
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: "run-1",
            campaign_id: "campaign-1",
            status: "running",
            confidence_score: 80,
            evidence_path: "/tmp/evidence/run-1",
            branch_name: "codeporter/campaign-1/run-1",
            pr_url: "https://github.com/org/repo/pull/1",
            pr_number: 1,
            pr_state: "open",
            pr_opened_at: null,
            merged_at: null,
            closed_at: null,
            last_ci_state: null,
            last_ci_checked_at: null,
            summary: { status: "running" }
          }
        ]
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            run_id: "run-1",
            level: "info",
            event_type: "lifecycle",
            step: null,
            message: "Run enqueued",
            payload: {},
            created_at: "2026-02-26T00:00:00.000Z"
          }
        ]
      });

    await eventsHandler({ params: { id: "run-1" }, query: {} }, eventsRes);
    expect(eventsRes.statusCode).toBe(200);
    expect((eventsRes.body as any).runId).toBe("run-1");
    expect((eventsRes.body as any).events).toHaveLength(1);
    expect((eventsRes.body as any).nextAfterId).toBe(1);
  });

  it("returns 404 when evidence zip is missing", async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: "run-1", evidence_path: "/tmp/evidence/run-1" }]
      })
      .mockResolvedValueOnce({ rows: [] });

    const handler = findRouteHandler(runsRouter(), "get", "/runs/:id/evidence.zip");
    const res = createMockRes();

    await handler({ params: { id: "missing-zip" } }, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "evidence zip not found" });
  });

  it("returns 404 when run manifest is missing", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const handler = findRouteHandler(runsRouter(), "get", "/runs/:id/evidence.manifest");
    const res = createMockRes();

    await handler({ params: { id: "missing-run" } }, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "run not found" });
  });

  it("returns 404 for missing run events", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const handler = findRouteHandler(runsRouter(), "get", "/runs/:id/events");
    const res = createMockRes();

    await handler({ params: { id: "missing-run" }, query: {} }, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "run not found" });
  });

  it("cancels a run", async () => {
    cancelRunMock.mockResolvedValueOnce({
      runId: "run-1",
      status: "cancelling",
      queueStatus: "running"
    });

    const handler = findRouteHandler(runsRouter(), "post", "/runs/:id/cancel");
    const res = createMockRes();

    await handler({ params: { id: "run-1" }, body: { reason: "stop" } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      runId: "run-1",
      status: "cancelling",
      queueStatus: "running"
    });
  });

  it("paginates run events using afterId and limit", async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: "run-2",
            campaign_id: "campaign-2",
            status: "running",
            confidence_score: null,
            evidence_path: "/tmp/evidence/run-2",
            branch_name: null,
            pr_url: null,
            pr_number: null,
            pr_state: null,
            pr_opened_at: null,
            merged_at: null,
            closed_at: null,
            last_ci_state: null,
            last_ci_checked_at: null,
            summary: { status: "running" }
          }
        ]
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 5,
            run_id: "run-2",
            level: "info",
            event_type: "step_start",
            step: "scan",
            message: "scan start",
            payload: {},
            created_at: "2026-02-26T00:00:05.000Z"
          },
          {
            id: 6,
            run_id: "run-2",
            level: "info",
            event_type: "step_end",
            step: "scan",
            message: "scan end",
            payload: {},
            created_at: "2026-02-26T00:00:06.000Z"
          }
        ]
      });

    const handler = findRouteHandler(runsRouter(), "get", "/runs/:id/events");
    const res = createMockRes();

    await handler(
      {
        params: { id: "run-2" },
        query: { afterId: "4", limit: "2" }
      },
      res
    );

    expect(res.statusCode).toBe(200);
    expect((res.body as any).events).toHaveLength(2);
    expect((res.body as any).nextAfterId).toBe(6);
  });
});
