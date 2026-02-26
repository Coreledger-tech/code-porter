import { describe, expect, it, vi } from "vitest";

const { buildHealthResponseMock } = vi.hoisted(() => {
  return {
    buildHealthResponseMock: vi.fn()
  };
});

vi.mock("./health.js", () => {
  return {
    buildHealthResponse: buildHealthResponseMock
  };
});

import { createApp } from "./app.js";

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

describe("createApp", () => {
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
