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
9. Keeper PR preflight:
- for each pilot repo with multiple open PRs in the release window, choose one keeper PR and close superseded PRs before release.
- merge only keeper PRs that satisfy the merge checklist in this document.

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

## Keeper PR Convention
1. Keep exactly one active modernization PR per repository in a given pilot window.
2. Close superseded PRs with a deterministic reason comment (for example `superseded by #16`).
3. Use squash merge for keeper PRs.

## Merge Checklist
1. Diff scope guardrails:
- only files expected for the lane/pack are touched.
- no unplanned plugin insertion or broad dependency sweep.
2. Churn guardrails:
- changed files and changed lines remain within policy limits and pilot guardrails.
3. Evidence guardrails:
- `verify.json` exists and reflects terminal state.
- remediation artifacts exist when remediation was applied (`remediation*.json` and patch artifacts).
- terminal failure-kind mapping matches final verify phase (compile vs tests).
4. Parseability guardrails:
- XML/Gradle files remain parseable after deterministic patching.

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
