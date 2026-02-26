# Code Porter V1 Beta

## What Is New In Beta
V1 Beta extends V1 Alpha from local pilot to off-laptop pilot readiness.

New in Beta:
- Containerized deployment path (`api + postgres + minio`) with a single compose startup flow.
- Remote evidence hosting via S3-compatible object storage (MinIO first).
- Stable evidence URLs in run responses for `evidence.zip` and `manifest.json`.
- Portfolio controls for safer operations at scale:
  - inflight throttling (per-project and global)
  - workspace TTL cleanup
  - local evidence cache TTL cleanup (when object store is enabled)

Unchanged fundamentals:
- Deterministic-first workflow remains the default.
- Run truthfulness remains strict: `completed`, `needs_review`, `blocked`.
- Full evidence manifest and hashes remain required per run.

## Deployment Model
Beta is deployed as a containerized API with supporting services:
- `api`: Code Porter API service
- `postgres`: run/campaign/project metadata and artifact index
- `minio`: S3-compatible object storage for evidence exports
- `minio-init`: bucket bootstrap service
- `migrate`: one-shot migration service

Primary startup:
- `docker compose up --build`

## Evidence Serving Model
Beta supports two evidence storage modes:

1. `local` (`EVIDENCE_STORE_MODE=local`)
- Evidence remains on local disk.
- API serves local proxy endpoints:
  - `GET /runs/:id/evidence.zip`
  - `GET /runs/:id/evidence.manifest`

2. `s3` (`EVIDENCE_STORE_MODE=s3`)
- On run finalize, API uploads `evidence.zip` and `manifest.json` to object storage.
- `GET /runs/:id` returns direct URLs for both artifacts:
  - `evidenceZipUrl`
  - `evidenceManifestUrl`
- URL mode is controlled by `EVIDENCE_URL_MODE`:
  - `signed` (default)
  - `public`
- Compatibility endpoints still exist and can redirect/proxy as fallback.

## Operational Defaults
- `WORKSPACE_CLEANUP_POLICY=delete_on_success_keep_on_failure`
- `WORKSPACE_TTL_DAYS=7`
- `EVIDENCE_KEEP_LOCAL_DISK=true`
- `EVIDENCE_CACHE_TTL_DAYS=7`
- `maxInflightRunsPerProject=2` (policy)
- `maxInflightRunsGlobal=10` (policy)
- `EVIDENCE_URL_MODE=signed`
- `EVIDENCE_SIGNED_URL_TTL_SECONDS=3600`

## Acceptance Tests

### Manual
1. Start stack with Docker compose.
2. Register project and run apply.
3. Verify `GET /runs/:id` includes evidence URL metadata:
- `evidenceZipUrl`
- `evidenceManifestUrl`
- `evidenceUrlMode`
- `evidenceStorage`
4. Download evidence from another machine/network client via returned URL.
5. Trigger repeated run starts and verify throttling returns HTTP 429 with limits.
6. Run cleanup commands and verify stale workspace/evidence cache directories are removed.

### Automated
- Fast suite (`npm test`):
  - policy parser for throttling keys
  - run route fields and manifest endpoint behavior
  - throttling route-level mapping (429)
  - cleanup logic guardrails
- Integration suite (`npm run test:integration`):
  - MinIO evidence upload and URL retrieval
  - throttling behavior under inflight pressure
  - TTL cleanup command behavior
  - local lane regression for `/runs/:id/evidence.zip`
