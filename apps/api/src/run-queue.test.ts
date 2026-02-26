import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, connectMock, clientQueryMock, releaseMock } = vi.hoisted(() => {
  const queryMock = vi.fn();
  const clientQueryMock = vi.fn();
  const releaseMock = vi.fn();
  const connectMock = vi.fn().mockResolvedValue({
    query: clientQueryMock,
    release: releaseMock
  });

  return {
    queryMock,
    connectMock,
    clientQueryMock,
    releaseMock
  };
});

vi.mock("./db/client.js", () => {
  return {
    query: queryMock,
    dbPool: {
      connect: connectMock
    }
  };
});

import {
  claimNextRunJob,
  completeRunJob,
  extendRunJobLease,
  getRunJobAttempts,
  queueDepth,
  requeueRunJob
} from "./run-queue.js";

describe("run-queue", () => {
  beforeEach(() => {
    queryMock.mockReset();
    connectMock.mockClear();
    clientQueryMock.mockReset();
    releaseMock.mockClear();
  });

  it("claims queued jobs with transaction lock semantics", async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] }) // begin
      .mockResolvedValueOnce({
        rows: [
          {
            run_id: "run-1",
            campaign_id: "campaign-1",
            mode: "apply",
            attempt_count: 1,
            max_attempts: 3,
            reclaimed: false
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [] }); // commit

    const claimed = await claimNextRunJob({
      workerId: "worker-1",
      leaseSeconds: 300
    });

    expect(claimed).toEqual({
      runId: "run-1",
      campaignId: "campaign-1",
      mode: "apply",
      attemptCount: 1,
      maxAttempts: 3,
      reclaimed: false
    });
    expect(clientQueryMock).toHaveBeenCalledWith("begin");
    expect(clientQueryMock).toHaveBeenCalledWith("commit");
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when no claimable jobs exist", async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] }) // begin
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // commit

    const claimed = await claimNextRunJob({
      workerId: "worker-1",
      leaseSeconds: 300
    });

    expect(claimed).toBeNull();
  });

  it("supports completion, requeue, attempts, and queue depth helpers", async () => {
    queryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // completeRunJob
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // requeueRunJob
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // extendRunJobLease
      .mockResolvedValueOnce({ rows: [{ attempt_count: 2, max_attempts: 3 }] }) // get attempts
      .mockResolvedValueOnce({ rows: [{ count: 4 }] }); // depth

    const completed = await completeRunJob({
      runId: "run-1",
      status: "completed"
    });
    const requeued = await requeueRunJob({
      runId: "run-1",
      delaySeconds: 30,
      lastError: "transient"
    });
    const extended = await extendRunJobLease({
      runId: "run-1",
      workerId: "worker-1",
      leaseSeconds: 300
    });
    const attempts = await getRunJobAttempts("run-1");
    const depth = await queueDepth();

    expect(completed).toBe(true);
    expect(requeued).toBe(true);
    expect(extended).toBe(true);
    expect(attempts).toEqual({ attemptCount: 2, maxAttempts: 3 });
    expect(depth).toBe(4);
    expect(queryMock).toHaveBeenCalledTimes(5);
  });
});
