# Code Porter V1 Stage 11

## Summary
Stage 11 turns the Stage 10 keeper pattern into the default GitHub PR loop:
1. choose and persist a single keeper PR per project/base branch,
2. mark keeper PRs as merge-ready when checklist evidence passes,
3. optionally auto-merge strict-safe Maven keeper PRs,
4. expose keeper outcomes in run summaries and pilot reporting.

This stage stays narrow. It does not add new build lanes, expand Android execution, or change cohort definitions.

## Goals
1. Reduce operator effort after PR creation without weakening existing safety rails.
2. Keep exactly one meaningful PR open per repo/base branch at a time.
3. Make merge readiness and keeper outcomes explicit in evidence, summaries, and reports.
4. Keep auto-merge conservative, optional, and policy-driven.

## Non-goals
1. No auto-merge for Gradle or guarded Android runs.
2. No new endpoint family or dashboard.
3. No lane expansion for Go, Node, or Python.
4. No relaxation of merge checklist hard-fail behavior.

## Acceptance Criteria
1. Keeper PR selection, supersede close/comment, merge-ready labeling, and optional auto-merge are policy-controlled.
2. Keeper outcomes are persisted consistently in DB summaries, `/runs/:id`, and `run.json`.
3. `/reports/pilot` exposes keeper metrics without changing existing cohort semantics.
4. Axum live validation confirms no duplicate PR creation after the merged keeper and correct keeper/checklist persistence.
5. A live control-repo validation proves end-to-end keeper selection, merge-ready labeling, and strict-safe auto-merge.

## Risk Controls
1. Keeper scoring order stays unchanged from Stage 10.
2. Auto-merge is off by default and enabled only in `pilot-stage11`.
3. Auto-merge requires:
   - GitHub project
   - apply mode
   - keeper chosen
   - final status `completed`
   - Maven `supported` lane
   - merge checklist pass
   - `changedFiles <= 1`
   - `changedLines <= 25`
   - changed paths limited to `pom.xml`
4. GitHub automation failures after PR creation are recorded as warnings and never delete evidence or fail the run.

## Keeper Lifecycle
1. Create PR when apply produced a commit and merge checklist passed.
2. Load open PRs for the same `projectId + base branch`.
3. Choose the keeper with the existing deterministic score order.
4. Comment on and close every non-keeper PR.
5. Mark the keeper PR merge-ready with label `code-porter:merge-ready` when checklist passed.
6. If policy allows and strict-safe rules pass, squash-merge the keeper.

## Persistence Contract
Run summaries persist:
1. `keeperCandidate`
2. `keeperChosen`
3. `keeperMerged`
4. `mergeReady`
5. `supersededByPrNumber`
6. `supersededClosedCount`
7. `mergeChecklist`

`mergeChecklist` summary data must include:
1. `passed`
2. `reasons`
3. `advisories`
4. `changedFilePaths`

## Reporting
Add `keeperOutcomes` to `/reports/pilot`:
1. `keeperChosen`
2. `keeperMerged`
3. `mergeReady`
4. `supersededClosedCount`

Existing `all`, `actionable_maven`, and `coverage` cohorts remain unchanged.

## Test Plan
### Unit
1. PR provider adds merge-ready label.
2. PR provider performs squash merge.
3. Auto-merge eligibility rejects out-of-scope diffs and non-Maven runs.
4. Keeper summaries are normalized consistently.
5. Report aggregation counts keeper outcomes correctly.

### Integration
1. First keeper PR opens and is labeled merge-ready.
2. Second PR for the same repo/base branch becomes keeper, closes superseded PRs, and records counts.
3. Strict-safe keeper PR auto-merges when `pilot-stage11` is enabled.
4. Non-strict-safe keeper PR stays open and merge-ready.
5. `run.json` matches `/runs/:id` for keeper and checklist fields.

### Ops
1. Axum no-change run confirms Stage 11 summary persistence without opening a duplicate PR.
2. Control repo run twice proves keeper selection, supersede close/comment, merge-ready label, and optional auto-merge.
3. Capture refreshed `all`, `actionable_maven`, and `coverage` pilot snapshots before `rc.10`.
