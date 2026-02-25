import type { KnowledgePublisherPort } from "@code-porter/core/src/workflow-runner.js";

export class StubKnowledgePublisher implements KnowledgePublisherPort {
  async publishRunSummary(_input: {
    runId: string;
    campaignId: string;
    projectId: string;
    summary: string;
    evidencePath: string;
  }): Promise<{ published: boolean; location?: string; reason?: string }> {
    return {
      published: false,
      reason: "knowledge layer not configured"
    };
  }
}
