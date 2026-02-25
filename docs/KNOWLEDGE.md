# Knowledge Layer (Dosu-Ready Stub)

## Purpose
Capture modernization context as durable, queryable artifacts so future agents and humans can reason about prior decisions quickly.

## MVP Output Candidates
- Run summaries (what changed, why, outcome).
- Policy decision logs (allow/deny reasoning).
- Confidence score explanations.
- Recipe rationale and affected modules.
- Migration timeline notes by campaign.

## Proposed Publish Targets (Future)
- Local docs folder snapshots.
- GitHub PR comments/check summaries.
- External knowledge tools (for example Dosu) via adapter.

## Stub Contract
```ts
interface KnowledgePublisher {
  publishRunSummary(input: {
    runId: string;
    campaignId: string;
    projectId: string;
    summary: string;
    evidencePath: string;
  }): Promise<{ published: boolean; location?: string; reason?: string }>;
}
```

## MVP Behavior
- Stub implementation returns `published: false` and reason `knowledge layer not configured`.
- No outbound network calls.
- Evidence still stores `knowledge.json` artifact to show handoff points.
