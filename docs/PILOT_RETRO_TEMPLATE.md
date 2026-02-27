# Code Porter Pilot Retro Template

## Pilot Metadata
- Pilot window:
- Coordinator:
- Generated at:
- Policy ID:
- Recipe pack:
- Report window (`7d` or `30d`):

## Cohort
| repo | owner | bucket | campaignId | planRunId | applyRunId | applyStatus | prUrl | prState | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |  |  |  |

## Metrics Snapshot (`/reports/pilot`)
- totalsByStatus:
- PR outcomes:
- timeToGreen (p50/p90):
- retryRate:

## Top Failure Kinds
| rank | failureKind | count | blockedShare | notes |
| --- | --- | --- | --- | --- |
| 1 |  |  |  |  |
| 2 |  |  |  |  |
| 3 |  |  |  |  |

## Retry and Budget Guardrails
- Retries observed:
- Runs with `failureKind=budget_guardrail`:
- Budget keys triggered (`maxVerifyMinutesPerRun`, `maxVerifyRetries`, `maxEvidenceZipBytes`):
- Recommended budget adjustments:

## PR Outcomes
- Open:
- Merged:
- Closed unmerged:
- Merge rate:
- Blocked repos requiring manual intervention:

## Top Missing Recipes or Remediations
| rank | item | type (`recipe_pack` or `operational`) | triggerFailureKinds | expected impact |
| --- | --- | --- | --- | --- |
| 1 |  |  |  |  |
| 2 |  |  |  |  |
| 3 |  |  |  |  |

## Proposed Next Two Deterministic Recipe Packs
1. Candidate:
- Rationale:
- Expected pass@1 impact:
- Risks:

2. Candidate:
- Rationale:
- Expected pass@1 impact:
- Risks:

## Action Backlog
| priority | action | owner | target date | status |
| --- | --- | --- | --- | --- |
| P0 |  |  |  |  |
| P1 |  |  |  |  |
| P2 |  |  |  |  |
