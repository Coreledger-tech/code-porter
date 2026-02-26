# Code Porter Release Guide

## Versioning and Tagging
1. Use semantic versioning (`MAJOR.MINOR.PATCH`).
2. Create release tags with `v` prefix (for example `v1.0.0`).
3. Tag pushes (`v*`) are the publish trigger for container release automation.

## Docker Image Publishing (GHCR)

### Registry
- `ghcr.io/coreledger-tech/code-porter`

### Publish Flow
1. Push semver tag (`v*`).
2. GitHub Actions builds Docker image from root `Dockerfile`.
3. Workflow publishes immutable tag image:
- `ghcr.io/coreledger-tech/code-porter:<tag>`
4. Optional `latest` tag is published for non-prerelease tags.

## Production Environment Checklist

### Core Services
1. Postgres reachable and healthy.
2. API service running.
3. Run worker running.
4. PR poller worker running.

### Database and Migrations
1. `db:migrate` completed successfully on target environment.
2. Required tables/columns exist (`runs`, `run_jobs`, `run_events`, `evidence_artifacts`).
3. PR lifecycle columns present on `runs`.

### GitHub Authentication
1. Configure either:
- `GITHUB_AUTH_MODE=app` with app credentials, or
- `GITHUB_AUTH_MODE=pat` (legacy/dev fallback)
2. Confirm token scopes/permissions support clone/push/PR read operations.

### Evidence and Storage
1. Evidence store mode configured (`local` or `s3`).
2. Bucket and signed/public URL config validated in object-store mode.
3. `/runs/:id/evidence.zip` and manifest retrieval verified.

### Observability
1. `/health` reports DB/tools readiness.
2. `/metrics` is scrapeable.
3. Worker and poller logs include run/campaign/project identifiers.

## Release Validation Checklist
1. `npm run typecheck`
2. `npm test`
3. `npm run test:integration`
4. smoke test:
- enqueue run
- confirm terminal status
- confirm PR metadata lifecycle and evidence links

## Rollback Notes
1. Pause campaigns before rollback.
2. Stop worker and poller if data integrity incident is suspected.
3. Roll back API image to previous tag.
4. Re-run migrations only when moving forward to corrected build.
