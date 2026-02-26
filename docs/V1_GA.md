# Code Porter V1 GA

## Scope
V1 GA prepares Code Porter for production pilot operation with three upgrades:
- asynchronous run execution with queue-backed workers
- GitHub App authentication for hosted deployments
- pilot observability (structured logs, run events, metrics)

This release preserves deterministic-first workflow behavior and existing terminal status semantics:
- `completed`
- `needs_review`
- `blocked`
- `failed`

## Async Architecture

### Components
- `api`: accepts run requests and enqueues jobs
- `run_jobs` table: durable queue state in Postgres
- `worker`: polls queue, executes runs, updates status/events
- `run_events` table: step-level event stream for run progress

### Request Lifecycle
1. Client calls `POST /campaigns/:id/plan` or `/apply`.
2. API validates campaign/policy throttles.
3. API creates:
- `runs` row with `status=queued`
- `run_jobs` row with `status=queued`
- initial `run_events` lifecycle entry
4. API returns immediately with `{ runId, status: "queued" }`.
5. Worker claims queued jobs (`FOR UPDATE SKIP LOCKED`).
6. Worker executes deterministic workflow and updates:
- `runs` terminal status
- `run_jobs` completion/failure state
- step events in `run_events`
7. Clients poll:
- `GET /runs/:id` for summary/status
- `GET /runs/:id/events` for progress timeline

### Run State Machine
- Queue state (`run_jobs.status`): `queued -> running -> completed|failed`
- Run state (`runs.status`): `queued -> running -> completed|needs_review|blocked|failed`
- Queue failures can retry; terminal run status remains source of truth for outcomes.

## GitHub App Authentication

### Modes
- `pat` (legacy, local/dev compatibility)
- `app` (GA target for deployment)

### Required GitHub App Permissions
Repository permissions:
- Contents: Read & Write
- Pull requests: Read & Write
- Metadata: Read

### Required Configuration
- `GITHUB_AUTH_MODE=app`
- `GITHUB_APP_ID`
- `GITHUB_APP_INSTALLATION_ID`
- `GITHUB_APP_PRIVATE_KEY_PATH`
- optional: `GITHUB_API_URL` (default `https://api.github.com`)

### Flow
1. Read app private key from mounted PEM file.
2. Generate app JWT.
3. Exchange JWT for installation access token.
4. Use installation token for clone, push, and PR API calls.
5. Cache token in memory until near expiry; never persist token in DB.

## Pilot Success Metrics

### Primary
- Time-to-green: run duration distribution and p50/p95
- Blocked rate: percentage of runs ending in `blocked`
- Top failure kinds: auth, repo write, verifier categories
- PR merge rate: ratio of PR-created runs that are merged downstream

### Supporting
- Queue latency: enqueue-to-start delay
- Retry rate: queue retries and deterministic remediation retries
- Event completeness: percentage of runs with full stage event trail

## Acceptance Targets
- API run-start endpoints return immediately with `queued` status.
- Worker-driven runs progress without manual intervention.
- `GET /runs/:id/events` provides ordered step progress.
- GitHub App mode successfully clones, pushes, and opens PRs.
- Metrics endpoint exposes pilot health counters/histograms.
