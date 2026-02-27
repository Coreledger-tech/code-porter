# Code Porter v1.0.0-rc.1 Release Candidate Guide

## RC Checklist
1. Move local non-source artifacts out of the repo root before release checks (for example the local `Code porter*.pdf` files) so `git status --short` is clean.
2. Confirm you are on `main`.
3. Run release helper (local tag only): `npm run release:rc`.
4. Push branch and tag explicitly:
- `git push origin main`
- `git push origin v1.0.0-rc.1`
5. Verify remote tag exists:
- `git ls-remote --tags origin "v1.0.0-rc.1"`
6. Verify GitHub Actions workflow success:
- `docker-publish` triggered for `v1.0.0-rc.1`
- image published at `ghcr.io/coreledger-tech/code-porter:v1.0.0-rc.1`
7. Verify fresh-clone runtime boot and health checks.

## Exact RC Commands
```bash
npm run release:rc
git push origin main
git push origin v1.0.0-rc.1
git ls-remote --tags origin "v1.0.0-rc.1"
```

## GHCR Verification
1. In GitHub Actions, confirm successful run for `.github/workflows/docker-publish.yml` on tag `v1.0.0-rc.1`.
2. Confirm the published container tag:
```bash
docker pull ghcr.io/coreledger-tech/code-porter:v1.0.0-rc.1
```

## Fresh Clone Compose Smoke Test
```bash
git clone https://github.com/Coreledger-tech/code-porter.git /tmp/code-porter-rc-smoke
cd /tmp/code-porter-rc-smoke
cp .env.example .env
docker compose up --build -d
curl -s http://localhost:3000/health | jq
curl -s http://localhost:3000/metrics | head -n 20
docker compose down -v
```

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
- local delete: `git tag -d v1.0.0-rc.1`
- remote delete: `git push origin :refs/tags/v1.0.0-rc.1`
5. Resume campaigns only after rollback validation.
