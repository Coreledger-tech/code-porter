import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  queryMock,
  appendRunEventMock,
  getTokenMock,
  logInfoMock,
  logWarnMock,
  logErrorMock
} = vi.hoisted(() => {
  return {
    queryMock: vi.fn(),
    appendRunEventMock: vi.fn(),
    getTokenMock: vi.fn(),
    logInfoMock: vi.fn(),
    logWarnMock: vi.fn(),
    logErrorMock: vi.fn()
  };
});

vi.mock("./db/client.js", () => {
  return {
    query: queryMock
  };
});

vi.mock("./workflow-service.js", () => {
  return {
    appendRunEvent: appendRunEventMock
  };
});

vi.mock("./observability/logger.js", () => {
  return {
    logInfo: logInfoMock,
    logWarn: logWarnMock,
    logError: logErrorMock
  };
});

vi.mock("@code-porter/workspace/src/index.js", () => {
  return {
    createGitHubAuthProvider: vi.fn(() => ({
      getToken: getTokenMock
    }))
  };
});

import { PrLifecyclePollerWorker } from "./pr-poller-worker.js";

describe("PrLifecyclePollerWorker", () => {
  beforeEach(() => {
    queryMock.mockReset();
    appendRunEventMock.mockReset();
    getTokenMock.mockReset();
    logInfoMock.mockReset();
    logWarnMock.mockReset();
    logErrorMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("updates open PR to merged and emits transition event", async () => {
    getTokenMock.mockResolvedValueOnce("test-token");
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: "run-1",
            pr_url: "https://github.com/acme/demo/pull/42",
            pr_number: null,
            pr_state: "open"
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [] });
    appendRunEventMock.mockResolvedValueOnce(1);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          number: 42,
          state: "closed",
          merged_at: "2026-02-26T00:01:00.000Z",
          closed_at: "2026-02-26T00:01:00.000Z",
          created_at: "2026-02-25T00:01:00.000Z"
        })
      })
    );

    const worker = new PrLifecyclePollerWorker({
      batchSize: 10,
      timeoutMs: 2000,
      githubApiUrl: "https://api.github.com"
    });

    const updated = await worker.pollOnce();

    expect(updated).toBe(1);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[1]?.[0]).toContain("set pr_number = coalesce(pr_number, $2)");
    expect(appendRunEventMock).toHaveBeenCalledTimes(1);
    expect(appendRunEventMock.mock.calls[0]?.[1]).toMatchObject({
      eventType: "lifecycle",
      message: "Pull request state changed to merged"
    });
  });

  it("updates open PR metadata without transition event when state remains open", async () => {
    getTokenMock.mockResolvedValueOnce("test-token");
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: "run-2",
            pr_url: "https://github.com/acme/demo/pull/7",
            pr_number: 7,
            pr_state: null
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [] });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          number: 7,
          state: "open",
          merged_at: null,
          closed_at: null,
          created_at: "2026-02-25T00:01:00.000Z"
        })
      })
    );

    const worker = new PrLifecyclePollerWorker({
      batchSize: 10,
      timeoutMs: 2000
    });

    const updated = await worker.pollOnce();

    expect(updated).toBe(1);
    expect(appendRunEventMock).not.toHaveBeenCalled();
  });

  it("returns zero updates when auth token retrieval fails", async () => {
    getTokenMock.mockRejectedValueOnce(new Error("no token"));
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "run-3",
          pr_url: "https://github.com/acme/demo/pull/9",
          pr_number: null,
          pr_state: "open"
        }
      ]
    });

    const worker = new PrLifecyclePollerWorker({
      batchSize: 10,
      timeoutMs: 2000
    });

    const updated = await worker.pollOnce();

    expect(updated).toBe(0);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(logWarnMock).toHaveBeenCalled();
  });
});
