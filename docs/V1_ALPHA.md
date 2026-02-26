# Code Porter V1 Alpha

## Goal
Deliver a safe, repeatable alpha that runs deterministic modernization workflows without mutating user repositories in place, can open GitHub PRs, and produces portable evidence bundles (`evidence.zip`).

## Scope
- Add project types: `local` and `github`.
- Add workspace lifecycle and execute all workflow stages in ephemeral workspaces.
- Add zip evidence export and API download endpoint.
- Add GitHub clone/push/PR orchestration behind provider interfaces.
- Keep deterministic-first execution order:
  - recipes
  - verifier
  - optional deterministic remediator
- Preserve existing local API lane behavior.

## Out of Scope
- GitHub App auth model (PAT only in this alpha).
- S3 evidence upload implementation (stub only).
- Autonomous free-form agentic edits.

## Project Types

### Local Project
- Existing route: `POST /projects` with `{ name, localPath }`.
- Stored as `type=local`.
- Source repository is treated as read-only input for workflow execution.

### GitHub Project
- New route: `POST /projects/github` with:
  - `name` (required)
  - `owner` (required)
  - `repo` (required)
  - `cloneUrl` (optional)
  - `defaultBranch` (optional)
- Stored as `type=github`.

## Workspace Lifecycle
1. **Prepare**
   - Determine `baseRef` priority:
     1. `campaign.targetSelector`
     2. `project.defaultBranch`
     3. `main`
   - Create workspace under `./workspaces/<runId>/`.
   - Local project: clone from local path into workspace.
   - GitHub project: clone from GitHub into workspace.
   - For local apply mode only: enforce source repo clean tree precheck.
2. **Run**
   - Execute scan/plan/apply/verify against workspace path.
   - Create branch `codeporter/<campaignId>/<runId>` in workspace for apply mode.
3. **Collect Evidence**
   - Persist evidence artifacts from workflow.
   - Include workspace metadata in `run.json` and run summary:
     - workspace path
     - base ref
     - commit before
     - commit after (if apply)
     - branch name (if apply)
4. **Cleanup**
   - Default policy: `delete_on_success_keep_on_failure`.
   - Configurable via `WORKSPACE_CLEANUP_POLICY`.
   - Cleanup failure is recorded as non-fatal evidence/summary warning.

## Evidence Export
Options considered:
- Local evidence directory only (current behavior).
- Local evidence directory + zip export (chosen for V1 alpha).
- External object store URL (future).

### V1 Alpha Choice
- Generate `evidence.zip` after evidence finalize.
- Keep original evidence directory on disk.
- Register zip as evidence artifact (`type=evidence.zip`).
- Expose `GET /runs/:id/evidence.zip` endpoint for download.
- Store zip `sha256` and `size` in manifest export metadata.

## Credential and Security Model

### PAT (V1 Alpha)
- Use `GITHUB_TOKEN` from environment.
- Never persist token in DB.
- Token used for:
  - cloning GitHub repos
  - pushing branches
  - opening PRs
- Failures due to missing/invalid token map to blocked run with `failureKind=auth`.

### Future (Post-Alpha)
- GitHub App auth with installation tokens.
- Token rotation and scoped repository permissions.

## Acceptance Tests

### Manual Acceptance
1. Local lane apply:
   - source repo remains unchanged
   - workspace branch/commit metadata appears in evidence
   - run exposes downloadable `evidence.zip`
2. GitHub lane apply:
   - branch pushed to origin
   - PR opened with recipe and score summary
   - PR body includes evidence download instruction
3. Failure lane:
   - invalid token or no write permission yields `status=blocked`
   - summary failure kind is `auth` or `repo_write`

### Automated Acceptance
1. `npm test`
   - workspace manager unit tests
   - zip evidence store unit tests
   - route tests for GitHub project creation and evidence zip endpoint
   - mocked GitHub provider and PR provider tests
2. `npm run test:integration`
   - local apply does not mutate source repo
   - zip endpoint returns artifact bytes and metadata hash
   - mocked GitHub orchestration flow persists `prUrl`
