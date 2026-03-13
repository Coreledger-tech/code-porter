# Code Porter V1 Stage 10

## Summary
Stage 10 tightens the operator loop around already-stable pilot execution:
1. automate keeper PR selection and supersede non-keepers deterministically,
2. enforce a merge checklist before PR creation,
3. make Android guarded baseline runs more useful by distinguishing changed PRs from safe no-op outcomes.

This stage stays narrow. It does not add new build lanes, new endpoint families, or auto-merge behavior.

## Goals
1. Keep exactly one active Code Porter PR per repo and base branch in a pilot window.
2. Prevent unsafe or low-signal PRs from being opened when diff scope, evidence, or parseability checks fail.
3. Make guarded Android outcomes measurable:
   - `guarded_baseline_applied` when deterministic baseline changes exist,
   - `guarded_baseline_noop` when the guarded baseline is already satisfied.
4. Keep pilot reporting useful for both actionable Maven work and coverage expansion.

## Non-goals
1. No automatic PR merge.
2. No new Gradle execution lane for Android.
3. No Node, Python, or Go lane expansion.
4. No broad dependency/plugin modernization sweeps beyond existing lane behavior.

## Acceptance Criteria
1. Keeper PR automation closes superseded PRs and leaves one keeper PR open per repo/base branch.
2. Merge checklist evidence is written before PR creation and prevents out-of-scope or malformed PRs.
3. Android guarded runs with no deterministic changes end as `needs_review` with:
   - `failureKind=guarded_baseline_noop`
   - `guardedBaselineNoop=true`
   - explicit `guardedBaselineReason`
4. `npm run typecheck`, `npm test`, and `npm run test:integration` remain green.

## Risk Controls
1. Keeper scoring is deterministic and based only on persisted run data plus current PR metadata.
2. Checklist hard-fails only for objective issues:
   - out-of-scope files,
   - missing required evidence,
   - parseability failures,
   - churn over policy limits.
3. Supersede automation comments before closing a PR so operator review context is preserved.
4. Guarded Android mode remains apply-only and never runs Gradle tasks.

## Keeper PR Lifecycle

### Keeper Group
Keeper evaluation applies to:
1. the same `projectId`,
2. the same base branch,
3. currently open Code Porter PRs persisted in the DB.

### Keeper Scoring Order
1. merge checklist passed
2. run status rank:
   - `completed`
   - `needs_review`
   - `blocked`
   - `failed`
   - `cancelled`
3. fewer changed files
4. fewer changed lines
5. newer `finishedAt`

### Supersede Behavior
1. On new PR creation, compute keeper across the open PR group plus the new PR.
2. Keep exactly one PR open.
3. Comment on every non-keeper PR with a deterministic supersede message.
4. Close every non-keeper PR after the comment succeeds.
5. Persist:
   - `keeperCandidate`
   - `supersededByPrNumber`

## Merge Checklist

### Hard-fail Rules
Do not open a PR when any of these fail:
1. changed file scope exceeds the lane contract,
2. changed files or changed lines exceed policy limits,
3. `verify.json` is missing,
4. required remediation artifacts are missing when remediation fired,
5. changed XML files are no longer parseable.

### Advisory-only Rules
Record, but do not hard-fail, operator-facing guidance:
1. a better keeper already exists,
2. guarded Android run produced no deterministic changes,
3. a run is safe to inspect but not merge without external CI.

### Evidence
Write `merge-checklist.json` before evidence finalization. The artifact records:
1. whether the checklist passed,
2. hard-fail reasons,
3. advisory reasons,
4. file scope summary,
5. churn summary.

## Android Guarded Baseline Usefulness

### Allowed Edits
1. `gradle/wrapper/gradle-wrapper.properties`
2. `gradle.properties`

### Forbidden Edits
1. `build.gradle`
2. `build.gradle.kts`
3. dependency or plugin sweeps
4. Gradle task execution

### Outcome Contract
1. If deterministic guarded edits exist:
   - keep current guarded path,
   - allow PR creation,
   - persist `failureKind=guarded_baseline_applied`.
2. If no guarded edits are needed:
   - end `needs_review`,
   - persist `failureKind=guarded_baseline_noop`,
   - set `guardedBaselineNoop=true`,
   - do not create a PR,
   - record that the guarded baseline is already satisfied.

## Test Plan

### Unit
1. keeper scoring chooses the correct keeper deterministically,
2. superseded PR comment references the keeper PR number,
3. checklist hard-fails out-of-scope or malformed XML diffs,
4. Android guarded no-op persists `guarded_baseline_noop`,
5. Android guarded changed case keeps `guarded_baseline_applied`.

### Integration
1. new keeper PR creation comments and closes older open PRs,
2. non-keeper new PR is commented and closed immediately,
3. checklist failure prevents PR creation and writes `merge-checklist.json`,
4. Android guarded changed case opens PR metadata and stays `needs_review`,
5. Android guarded no-op case stays `needs_review` without opening a PR.

### Ops
1. merge the keeper PR only after checklist pass and evidence review,
2. let PR poller sync merged/closed state,
3. capture `all`, `actionable_maven`, and `coverage` report snapshots after merge,
4. defer `rc.9` until Stage 10 metrics are recorded.
