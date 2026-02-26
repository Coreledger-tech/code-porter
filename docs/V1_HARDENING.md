# Code Porter V1 GA Hardening

## Scope
This stage hardens GA readiness for pilot operations by focusing on:
- queue correctness with explicit leasing and retries for multi-worker safety
- operator controls for run cancellation and campaign pause/resume
- portfolio summary endpoints for project/campaign health visibility

No new queue infrastructure is introduced; Postgres remains the only broker/state store.

## Exactly-Once and Leasing Model

### Execution Guarantees
- At most one active worker lease per job at a time.
- Terminal run outcomes are written once using guarded transitions.
- Recovery remains at-least-once at process level, but lease ownership and terminal guards prevent duplicate finalization.

### Leasing Strategy
- Claims use `SELECT ... FOR UPDATE SKIP LOCKED`.
- Job is claimable when:
  - `status = 'queued'`
  - `next_attempt_at <= now()`
  - campaign lifecycle status is `active`
  - no active lease or lease expired
- Claim writes:
  - `lease_owner`
  - `leased_at`
  - `lease_expires_at`
  - `attempt_count = attempt_count + 1`
- Worker heartbeats periodically extend `lease_expires_at` while processing.
- Expired running lease can be reclaimed by another worker.

## Retry and Backoff

### Retry Policy
- Retry class: transient worker/process failures and reclaim-retry paths.
- Max attempts default: `3`.
- Deterministic exponential backoff:
  - `delay = min(maxBackoff, baseBackoff * 2^(attempt_count - 1))`
  - defaults: base `15s`, max `300s`
- On retry:
  - `status = 'queued'`
  - `next_attempt_at = now() + delay`
  - clear lease fields
  - set `last_error`
- On retry exhaustion:
  - `run_jobs.status = 'failed'`
  - `runs.status = 'failed'` unless run is already terminal
  - run summary includes `failureKind = 'retry_exhausted'`

## Cancellation Semantics

### Statuses
- Run statuses extended with:
  - `cancelling`
  - `cancelled`
- Job statuses extended with:
  - `cancelled`

### Safe Interruption
- Worker checks cancellation at workflow boundaries:
  - `scan`
  - `plan`
  - `apply`
  - `verify`
  - `evidence_finalize`
  - `pr_create`
  - `workspace_cleanup`
- No forced interruption inside active commands.
- Cancellation events:
  - `run_cancellation_requested`
  - `run_cancelled`

### Transition Rules
- `queued -> cancelled` immediately via API.
- `running -> cancelling` via API.
- Worker transitions `cancelling -> cancelled` at the next safe checkpoint.
- Terminal runs remain unchanged on repeated cancel calls.

## Campaign Pause/Resume

### Pause
- `POST /campaigns/:id/pause` sets lifecycle status to `paused`.
- New enqueues return `409`.
- Worker claim query excludes paused campaigns; queued jobs remain queued.

### Resume
- `POST /campaigns/:id/resume` sets lifecycle status back to `active`.
- Existing queued jobs become claimable when `next_attempt_at <= now()`.

## Summary Endpoints

### Endpoints
- `GET /projects/:id/summary`
- `GET /campaigns/:id/summary`

### Aggregates
- Default rolling window: 30 days (`?days=` override, bounded).
- Status totals.
- Failure-kind totals (`summary.failureKind` with `unknown` fallback).
- Retry and cancellation counts.
- Duration p50/p95.
- Recent run list with queue status and PR info.

### PR Merge State
- Best-effort live lookup for GitHub PR URLs.
- Timeout default: `1500ms`.
- Errors/timeouts/auth failures return `mergeState = 'unknown'` without failing the endpoint.

## Pilot Metrics Added
- `codeporter_runs_cancelled_total{mode}`
- `codeporter_queue_retries_total{reason}`
- `codeporter_queue_lease_reclaims_total`

Existing metrics remain unchanged.

## Acceptance Targets
- Two workers do not both process the same claimed job.
- Lease expiry allows safe reclaim after worker failure.
- Cancellation does not corrupt workspace/evidence and lands in `cancelled`.
- Pause blocks enqueue and prevents paused-campaign claims.
- Summary endpoints surface actionable health and reliability indicators.
