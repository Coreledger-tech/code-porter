import type { Run } from "@code-porter/core/src/models.js";
import type { RunRequest, WorkflowRunner } from "@code-porter/core/src/workflow-runner.js";

export class DbosWorkflowRunnerStub implements WorkflowRunner {
  async start(_request: RunRequest): Promise<{ runId: string }> {
    // TODO: wire DBOS durable workflow execution when DBOS is enabled.
    // Expected flow: checkpoint each stage, enforce idempotent step boundaries,
    // and persist resumable state in Postgres-backed workflow tables.
    throw new Error("DBOS workflow runner is not implemented in MVP. Set WORKFLOW_RUNNER=inmemory.");
  }

  async get(_runId: string): Promise<Run | undefined> {
    // TODO: map DBOS workflow status back to Run shape.
    return undefined;
  }
}
