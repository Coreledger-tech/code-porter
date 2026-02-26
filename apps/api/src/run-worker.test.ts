import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  claimNextRunJobMock,
  completeRunJobMock,
  extendRunJobLeaseMock,
  getRunJobAttemptsMock,
  queueDepthMock,
  requeueRunJobMock,
  executeRunByIdMock,
  appendRunEventMock,
  metricsMock
} = vi.hoisted(() => {
  return {
    claimNextRunJobMock: vi.fn(),
    completeRunJobMock: vi.fn(),
    extendRunJobLeaseMock: vi.fn(),
    getRunJobAttemptsMock: vi.fn(),
    queueDepthMock: vi.fn(),
    requeueRunJobMock: vi.fn(),
    executeRunByIdMock: vi.fn(),
    appendRunEventMock: vi.fn(),
    metricsMock: {
      incrementWorkerClaim: vi.fn(),
      setQueueDepth: vi.fn(),
      incrementRunFailure: vi.fn(),
      incrementRunsCancelled: vi.fn(),
      incrementQueueRetry: vi.fn(),
      incrementQueueLeaseReclaim: vi.fn()
    }
  };
});

vi.mock("./run-queue.js", () => {
  return {
    claimNextRunJob: claimNextRunJobMock,
    completeRunJob: completeRunJobMock,
    extendRunJobLease: extendRunJobLeaseMock,
    getRunJobAttempts: getRunJobAttemptsMock,
    queueDepth: queueDepthMock,
    requeueRunJob: requeueRunJobMock
  };
});

vi.mock("./workflow-service.js", () => {
  return {
    executeRunById: executeRunByIdMock,
    appendRunEvent: appendRunEventMock
  };
});

vi.mock("./observability/metrics.js", () => {
  return {
    metrics: metricsMock
  };
});

vi.mock("./observability/logger.js", () => {
  return {
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn()
  };
});

vi.mock("./db/client.js", () => {
  return {
    query: vi.fn()
  };
});

import { AsyncRunWorker } from "./run-worker.js";

describe("AsyncRunWorker", () => {
  beforeEach(() => {
    claimNextRunJobMock.mockReset();
    completeRunJobMock.mockReset();
    extendRunJobLeaseMock.mockReset();
    getRunJobAttemptsMock.mockReset();
    queueDepthMock.mockReset();
    requeueRunJobMock.mockReset();
    executeRunByIdMock.mockReset();
    appendRunEventMock.mockReset();
    metricsMock.incrementWorkerClaim.mockReset();
    metricsMock.setQueueDepth.mockReset();
    metricsMock.incrementRunFailure.mockReset();
    metricsMock.incrementRunsCancelled.mockReset();
    metricsMock.incrementQueueRetry.mockReset();
    metricsMock.incrementQueueLeaseReclaim.mockReset();
  });

  it("records empty claims when no jobs are available", async () => {
    claimNextRunJobMock.mockResolvedValueOnce(null);
    queueDepthMock.mockResolvedValueOnce(0);

    const worker = new AsyncRunWorker({
      workerId: "worker-test",
      concurrency: 1,
      pollMs: 10
    });

    const processed = await worker.processAvailableJobs();
    expect(processed).toBe(0);
    expect(metricsMock.incrementWorkerClaim).toHaveBeenCalledWith("empty");
    expect(metricsMock.setQueueDepth).toHaveBeenCalledWith(0);
  });

  it("executes claimed jobs and marks queue completion", async () => {
    claimNextRunJobMock.mockResolvedValueOnce({
      runId: "run-1",
      campaignId: "campaign-1",
      mode: "apply",
      attemptCount: 1,
      maxAttempts: 3,
      reclaimed: false
    });
    executeRunByIdMock.mockResolvedValueOnce({
      runId: "run-1",
      status: "completed"
    });
    completeRunJobMock.mockResolvedValueOnce(true);
    queueDepthMock.mockResolvedValueOnce(0);

    const worker = new AsyncRunWorker({
      workerId: "worker-test",
      concurrency: 1,
      pollMs: 10
    });

    const processed = await worker.processAvailableJobs();

    expect(processed).toBe(1);
    expect(executeRunByIdMock).toHaveBeenCalledWith("run-1", "worker-test");
    expect(completeRunJobMock).toHaveBeenCalledWith({
      runId: "run-1",
      status: "completed",
      lastError: null,
      workerId: "worker-test"
    });
    expect(metricsMock.incrementWorkerClaim).toHaveBeenCalledWith("claimed");
  });

  it("tracks lease reclaim claims", async () => {
    claimNextRunJobMock.mockResolvedValueOnce({
      runId: "run-2",
      campaignId: "campaign-2",
      mode: "apply",
      attemptCount: 2,
      maxAttempts: 3,
      reclaimed: true
    });
    executeRunByIdMock.mockResolvedValueOnce({
      runId: "run-2",
      status: "completed"
    });
    completeRunJobMock.mockResolvedValueOnce(true);
    queueDepthMock.mockResolvedValueOnce(0);

    const worker = new AsyncRunWorker({
      workerId: "worker-test",
      concurrency: 1,
      pollMs: 10
    });

    const processed = await worker.processAvailableJobs();
    expect(processed).toBe(1);
    expect(metricsMock.incrementQueueLeaseReclaim).toHaveBeenCalledTimes(1);
  });

  it("requeues transient failures with exponential backoff", async () => {
    claimNextRunJobMock.mockResolvedValueOnce({
      runId: "run-3",
      campaignId: "campaign-3",
      mode: "apply",
      attemptCount: 2,
      maxAttempts: 3,
      reclaimed: false
    });
    executeRunByIdMock.mockRejectedValueOnce(new Error("transient"));
    getRunJobAttemptsMock.mockResolvedValueOnce({
      attemptCount: 2,
      maxAttempts: 3
    });
    requeueRunJobMock.mockResolvedValueOnce(true);
    queueDepthMock.mockResolvedValueOnce(0);

    const worker = new AsyncRunWorker({
      workerId: "worker-test",
      concurrency: 1,
      pollMs: 10,
      backoffBaseSeconds: 15,
      backoffMaxSeconds: 300
    });

    await worker.processAvailableJobs();

    expect(requeueRunJobMock).toHaveBeenCalledWith({
      runId: "run-3",
      delaySeconds: 30,
      lastError: "transient",
      workerId: "worker-test"
    });
    expect(metricsMock.incrementQueueRetry).toHaveBeenCalledWith("worker_crash");
  });
});
