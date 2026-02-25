import type { Run } from "@code-porter/core/src/models.js";
import type { RunRequest, WorkflowRunner } from "@code-porter/core/src/workflow-runner.js";

export class InMemoryWorkflowRunner implements WorkflowRunner {
  private readonly runs = new Map<string, Run>();

  constructor(private readonly executor: (request: RunRequest) => Promise<Run>) {}

  async start(request: RunRequest): Promise<{ runId: string }> {
    const run = await this.executor(request);
    this.runs.set(run.id, run);
    return { runId: run.id };
  }

  async get(runId: string): Promise<Run | undefined> {
    return this.runs.get(runId);
  }
}
