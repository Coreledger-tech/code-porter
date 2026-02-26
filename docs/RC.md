# Code Porter v1.0.0-rc.1 Release Candidate Guide

## RC Checklist
1. Confirm git working tree is clean (`git status --short` should be empty).
2. Confirm you are on `main`.
3. Run type checks: `npm run typecheck`.
4. Run fast tests: `npm test`.
5. Run integration tests: `npm run test:integration`.
6. Create local RC tag via helper: `npm run release:rc`.
7. Push branch and tag:
- `git push origin main`
- `git push origin v1.0.0-rc.1`
8. Verify GitHub Actions:
- `docker-publish` triggered for `v1.0.0-rc.1`
- image pushed to `ghcr.io/coreledger-tech/code-porter:v1.0.0-rc.1`.

## Exact RC Commands
```bash
npm run release:rc
git push origin main
git push origin v1.0.0-rc.1
```

## Post-Tag Verification
1. Confirm tag exists remotely:
- `git ls-remote --tags origin "v1.0.0-rc.1"`
2. Confirm GHCR publish workflow success in GitHub Actions.
3. Pull and smoke-run image in pilot environment.

## Rollback Steps
1. Pause campaign enqueues:
- `POST /campaigns/:id/pause` for active pilot campaigns.
2. Stop worker and PR poller services.
3. Roll back deployment to previous stable image tag.
4. If RC tag must be withdrawn:
- local delete: `git tag -d v1.0.0-rc.1`
- remote delete: `git push origin :refs/tags/v1.0.0-rc.1`
5. Resume campaigns only after rollback validation.

