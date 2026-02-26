# Code Porter Operations

## Environment Variables

### Core API
- `PORT` (default: `3000`)
- `BASE_URL` (recommended in pilot: externally reachable API base URL)

### Database
- `DATABASE_URL` (required)
- `POSTGRES_HOST_PORT` (dev convenience, default `5433`)

### Policy/Workflow
- `POLICY_DEFAULT_PATH` (default `./policies/default.yaml`)
- `WORKSPACE_ROOT` (default `./workspaces`)
- `WORKSPACE_CLEANUP_POLICY` (`always_delete|delete_on_success_keep_on_failure|always_keep`)
- `WORKSPACE_TTL_DAYS` (default `7`)
- `ENABLE_DETERMINISTIC_REMEDIATOR` (`true|false`)
- `RUN_WORKER_POLL_MS` (default `1000`)
- `RUN_WORKER_CONCURRENCY` (default `1`)
- `RUN_JOB_LEASE_SECONDS` (default `300`)
- `RUN_JOB_HEARTBEAT_SECONDS` (default `30`)
- `RUN_JOB_BACKOFF_BASE_SECONDS` (default `15`)
- `RUN_JOB_BACKOFF_MAX_SECONDS` (default `300`)
- `PR_POLL_INTERVAL_MS` (default `60000`)
- `PR_POLL_BATCH_SIZE` (default `100`)
- `PR_POLL_TIMEOUT_MS` (default `3000`)

### Evidence Storage
- `EVIDENCE_STORE_MODE` (`local|s3`, default `local`)
- `EVIDENCE_ROOT` (default `./evidence`)
- `EVIDENCE_EXPORT_ROOT` (default `./evidence-exports`)
- `EVIDENCE_KEEP_LOCAL_DISK` (`true|false`, default `true`)
- `EVIDENCE_CACHE_TTL_DAYS` (default `7`)
- `EVIDENCE_URL_MODE` (`signed|public`, default `signed`)
- `EVIDENCE_SIGNED_URL_TTL_SECONDS` (default `3600`)

### S3-Compatible (MinIO/AWS)
- `S3_ENDPOINT` (upload endpoint, e.g. `http://minio:9000` in compose)
- `S3_PUBLIC_ENDPOINT` (client-facing URL base, e.g. `http://localhost:9000`)
- `S3_REGION` (default `us-east-1`)
- `S3_BUCKET` (default `code-porter-evidence`)
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_FORCE_PATH_STYLE` (`true|false`, default `true`)

### GitHub Lane
- `GITHUB_AUTH_MODE` (`pat|app`, default `pat`)
- `GITHUB_API_URL` (default `https://api.github.com`)
- `GITHUB_TOKEN` (legacy PAT mode)
- `GITHUB_APP_ID` (required in app mode)
- `GITHUB_APP_INSTALLATION_ID` (required in app mode)
- `GITHUB_APP_PRIVATE_KEY_PATH` (required in app mode, mounted PEM path)
- `SUMMARY_GITHUB_LOOKUP_TIMEOUT_MS` (default `1500`)

## Run Locally (Host Process)
1. Install dependencies:
- `npm install`
2. Start Postgres only:
- `npm run db:up`
3. Run DB migrations:
- `npm run db:migrate`
4. Start API:
- `npm run api:start`
5. Start worker (separate process):
- `npm run worker:start`
6. Start PR poller (separate process):
- `npm run pr-poller:start`

## Run On Server (Docker Compose)
1. Set production `.env` values (DB, MinIO, GitHub auth mode, BASE_URL).
2. Start services:
- `docker compose up --build`
3. Verify health:
- `curl http://<host>:3000/health`
4. Verify metrics:
- `curl http://<host>:3000/metrics`
5. Run campaign flow through API.

## Cleanup Operations
- Workspace TTL cleanup:
  - `npm run cleanup:workspaces`
- Local evidence cache cleanup:
  - `npm run cleanup:evidence`

Cleanup safety behavior:
- Refuses unsafe roots (`/` or empty path).
- Logs deleted and skipped entries.
- Returns non-zero only for fatal traversal/configuration failures.

## Troubleshooting Checklist

### Database
- Symptom: migration or API startup fails.
- Check:
  - `DATABASE_URL` is correct.
  - Postgres container is running.
  - `npm run db:migrate` succeeds.

### MinIO/S3 Uploads
- Symptom: no remote evidence URLs or upload errors.
- Check:
  - `EVIDENCE_STORE_MODE=s3`
  - bucket exists (`S3_BUCKET`)
  - endpoint/credentials are correct
  - API can reach `S3_ENDPOINT`

### Signed URL Failures
- Symptom: URL generation fails.
- Check:
  - `S3_PUBLIC_ENDPOINT` is externally resolvable.
  - `S3_FORCE_PATH_STYLE` matches target service behavior.
  - fallback endpoint `/runs/:id/evidence.zip` works.

### GitHub Auth/Write Failures
- Symptom: run ends `blocked` with auth or repo write errors.
- Check:
  - `GITHUB_AUTH_MODE` is correct.
  - PAT mode: `GITHUB_TOKEN` present and valid.
  - App mode: app ID, installation ID, private key path are correct.
  - GitHub App permissions include contents write + pull requests write.

### Queue/Worker Stalls
- Symptom: run remains `queued` for too long.
- Check:
  - worker process/container is running.
  - campaign is not paused (`campaigns.lifecycle_status` should be `active`).
  - `run_jobs` row has `status=queued` and `next_attempt_at <= now()`.
  - lease settings are reasonable (`RUN_JOB_LEASE_SECONDS`, `RUN_JOB_HEARTBEAT_SECONDS`).
  - `GET /runs/:id/events` for latest lifecycle/error entries.

### PR Lifecycle Stale
- Symptom: PR merged/closed on GitHub but run still shows `prState=open`.
- Check:
  - PR poller process/container is running.
  - `PR_POLL_INTERVAL_MS` is not too high.
  - GitHub auth token/app credentials are valid for PR read access.
  - `GET /runs/:id/events` contains `pr_poll` lifecycle transitions.

### Cancellation / Pause Controls
- Cancel running or queued run:
  - `POST /runs/:id/cancel`
- Pause or resume campaign execution:
  - `POST /campaigns/:id/pause`
  - `POST /campaigns/:id/resume`

### Throttling 429
- Symptom: plan/apply returns HTTP 429.
- Check:
  - inflight runs still `queued|running`.
  - policy limits (`maxInflightRunsPerProject`, `maxInflightRunsGlobal`).
  - retry after current inflight runs complete.
