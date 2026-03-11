# Code Porter Release Candidate Guide

## RC Checklist
1. Move local non-source artifacts out of the repo root before release checks (for example the local `Code porter*.pdf` files) so `git status --short` is clean.
2. Confirm you are on `main`.
3. Run release helper with an explicit rc tag (local tag only): `npm run release:rc -- --tag <tag>`.
4. Push branch and tag explicitly:
- `git push origin main`
- `git push origin <tag>`
5. Verify remote tag exists:
- `git ls-remote --tags origin "<tag>"`
6. Verify GitHub Actions workflow success:
- `docker-publish` triggered for `<tag>`
- image published at `ghcr.io/coreledger-tech/code-porter:<tag>`
7. Verify fresh-clone runtime boot and health checks.
8. Integration isolation preflight (mandatory before `release:rc`):
- ensure host worker and pr-poller are stopped, or run integration in compose-only mode.
- stop command:
  - `/bin/zsh -lc 'pkill -f "apps/api/src/worker.ts" || true; pkill -f "apps/api/src/pr-poller.ts" || true'`

## Exact RC Commands
```bash
npm run release:rc -- --tag v1.0.0-rc.2
git push origin main
git push origin v1.0.0-rc.2
git ls-remote --tags origin "v1.0.0-rc.2"
npm run verify:ghcr -- --tag v1.0.0-rc.2
```

## GHCR Verification
1. GHCR visibility is package-level, not tag-level.
2. Preferred path is a public package at `ghcr.io/coreledger-tech/code-porter`.
3. In GitHub Actions, confirm successful run for `.github/workflows/docker-publish.yml` on the rc tag you just pushed.
4. Confirm the published container tag:
```bash
docker pull ghcr.io/coreledger-tech/code-porter:v1.0.0-rc.2
```
If your host is Apple Silicon and the tag is single-arch, use:
```bash
docker pull --platform linux/amd64 ghcr.io/coreledger-tech/code-porter:v1.0.0-rc.2
```
5. If the package is private, use:
```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
docker pull ghcr.io/coreledger-tech/code-porter:v1.0.0-rc.2
```

## Fresh Clone Compose Smoke Test
```bash
git clone https://github.com/Coreledger-tech/code-porter.git /tmp/code-porter-rc-smoke
cd /tmp/code-porter-rc-smoke
cp .env.example .env
docker compose -p codeporter-rc-smoke up --build -d
curl -s http://localhost:3000/health | jq
curl -s http://localhost:3000/metrics | head -n 20
docker compose -p codeporter-rc-smoke down -v
```

## Compose Reliability Notes
1. Compose no longer relies on fixed `container_name` values, so parallel stacks can run without global name collisions.
2. Container-mode defaults for `migrate`, `api`, `worker`, and `pr-poller` must use `postgres` as DB host unless explicitly overridden.
3. Host-local workflows remain supported by overriding `DATABASE_URL` outside compose.

## Non-interactive Smoke Checklist
Run in order:
```bash
docker compose -p codeporter-rc-smoke up -d postgres minio
docker compose -p codeporter-rc-smoke up migrate
docker compose -p codeporter-rc-smoke up -d api worker pr-poller
curl -sS http://localhost:3000/health | jq
curl -sS http://localhost:3000/metrics | head -n 20
docker compose -p codeporter-rc-smoke down -v
```

## Integration Test Isolation
`npm run release:rc` now fails fast if host worker/poller processes are running, because they can consume queue jobs and make `npm run test:integration` flaky.

Before release:
```bash
/bin/zsh -lc 'pkill -f "apps/api/src/worker.ts" || true; pkill -f "apps/api/src/pr-poller.ts" || true'
```

Alternative:
- keep host runtime processes stopped and run integration in compose-only mode.

Expected:
1. `health` returns `db.ok=true`.
2. API, worker, and pr-poller containers are running.
3. Metrics endpoint responds with Prometheus text.

## Rollback Steps
1. Pause campaign enqueues:
- `POST /campaigns/:id/pause` for active pilot campaigns.
2. Stop worker and PR poller services.
3. Roll back deployment to the previous stable image tag.
4. If RC tag must be withdrawn:
- local delete: `git tag -d <tag>`
- remote delete: `git push origin :refs/tags/<tag>`
5. Resume campaigns only after rollback validation.
