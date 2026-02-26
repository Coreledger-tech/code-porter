import { describe, expect, it, vi } from "vitest";

const { buildHealthResponseMock, metricsMock } = vi.hoisted(() => {
  return {
    buildHealthResponseMock: vi.fn(),
    metricsMock: {
      render: vi.fn(),
      contentType: vi.fn()
    }
  };
});

vi.mock("./health.js", () => {
  return {
    buildHealthResponse: buildHealthResponseMock
  };
});

vi.mock("./observability/metrics.js", () => {
  return {
    metrics: metricsMock
  };
});

import { createApp } from "./app.js";

type MockRes = {
  statusCode: number;
  body?: unknown;
  headers?: Record<string, string>;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
  send: (body: unknown) => MockRes;
  setHeader: (name: string, value: string) => MockRes;
};

function createMockRes(): MockRes {
  return {
    statusCode: 200,
    headers: {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers = this.headers ?? {};
      this.headers[name] = value;
      return this;
    }
  };
}

describe("createApp", () => {
  it("routes metrics as prometheus text", async () => {
    metricsMock.render.mockResolvedValueOnce("# HELP codeporter_runs_enqueued_total\n");
    metricsMock.contentType.mockReturnValueOnce("text/plain; version=0.0.4");

    const app = createApp();
    const layer = (app as any)._router.stack.find((item: any) => item.route?.path === "/metrics");
    const handler = layer.route.stack[0].handle;
    const res = createMockRes();

    await handler({}, res, vi.fn());

    expect(metricsMock.render).toHaveBeenCalledTimes(1);
    expect(metricsMock.contentType).toHaveBeenCalledTimes(1);
    expect(res.headers?.["Content-Type"]).toContain("text/plain");
    expect(res.body).toContain("codeporter_runs_enqueued_total");
  });

  it("routes health and supports optional network probe", async () => {
    buildHealthResponseMock.mockResolvedValueOnce({ ok: true, db: { ok: true } });

    const app = createApp();
    const layer = (app as any)._router.stack.find((item: any) => item.route?.path === "/health");
    const handler = layer.route.stack[0].handle;

    const res = createMockRes();

    await handler({ query: { probe: "network" } }, res, vi.fn());

    expect(buildHealthResponseMock).toHaveBeenCalledWith({ probeNetwork: true });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, db: { ok: true } });
  });
});
