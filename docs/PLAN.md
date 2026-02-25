# Code Porter MVP Plan

## Problem Statement
Enterprise modernization work is slow, risky, and hard to audit. Teams need a deterministic modernization control plane that can apply known-safe upgrades first, then escalate to agentic repair only when deterministic recipes leave residual failures.

## Scope
- V1 MVP: local-repo modernization control plane for deterministic JVM upgrade recipes.
- Deterministic-first workflow with policy gates, verifier stages, confidence scoring, and evidence bundles.
- Local API-only operation (CLI/API driven), no UI required.

## Non-Goals (This Sprint)
- Full COBOL/Fortran/PLSQL translation implementation.
- GitHub PR automation and remote SCM orchestration.
- Production-grade distributed orchestration.
- Full LLM repair loop execution.

## Concrete MVP Demo Definition (Local)
1. Register local repo path with `POST /projects`.
2. Create campaign with policy + recipe pack via `POST /campaigns`.
3. Run `POST /campaigns/:id/plan` to generate intended changes only.
4. Run `POST /campaigns/:id/apply` to:
   - create local branch `codeporter/<campaignId>/<runId>`
   - apply deterministic recipes
   - run verifier gates
   - generate evidence bundle in `./evidence/<project>/<campaign>/<run>/`
5. Fetch run summary with `GET /runs/:id` including status, score, evidence path, and branch name.

## MVP User Journeys
### Local Repo First
- Platform engineer registers a local checkout.
- Modernization owner creates a campaign targeting a recipe pack and policy.
- Reviewer inspects `plan.json` before apply.
- Apply produces branch, evidence, and deterministic confidence result.

### GitHub Later (Post-MVP)
- Replace local branch-only output with optional PR orchestration.
- Add review templates, status checks, and merge controls.

## Architecture Overview
### Components
- API (`apps/api`): project/campaign/run lifecycle endpoints.
- Core (`packages/core`): domain model, workflow orchestration, policy engine, confidence scoring.
- Recipes (`packages/recipes`): deterministic recipe engine and recipe implementations.
- Verifier (`packages/verifier`): compile/test/static checks with graceful fallback.
- Evidence (`packages/evidence`): structured artifact persistence and manifest/checksum writer.
- Runner Adapters (`workflow-runner-*`): in-memory default, DBOS stub.
- Knowledge Hook (`packages/knowledge`): artifact publishing stub for docs/context systems.

### Data Flow
`API -> WorkflowRunner -> Scan -> Plan -> Apply -> Verify -> Evidence -> Run Summary`

## Data Model
- `Project`: local source checkout registered for modernization campaigns.
- `Campaign`: modernization intent (`projectId`, policy, recipe pack, target selector).
- `Run`: one execution of plan/apply with mode, status, score, evidence path, and optional branch.
- `EvidenceArtifact`: typed evidence object with checksum and filesystem path.
- `Policy`: YAML-defined gates and thresholds.

## Workflow Stages
1. `Scan`: detect build system (`pom.xml`, `build.gradle`, `package.json`) and runtime metadata.
2. `Plan`: compute deterministic intended edits without writing files.
3. `Apply`: enforce clean tree, create branch, apply edits, commit patch.
4. `Verify`: run build/test/static commands when tools are available; otherwise record `not_run`.
5. `Package Evidence`: persist JSON artifacts + patch + manifest.

## Risk and Trust Model
### Confidence Score Inputs
- Compile/build result.
- Test result (or policy-approved not-run reason).
- Static check result.
- Change size (files changed, lines changed).
- Policy violation count.

### Rollback Story
- Local apply creates isolated branch only.
- Main branch remains untouched.
- Rollback is a branch discard/reset operation by user.

### Sandboxing and Safety
- No destructive operations without explicit prompt.
- Apply blocked on dirty working tree.
- Policy can limit build systems and maximum change footprint.

## 4-Week Milestones
### Week 1
- Docs-first baseline and architecture contracts.
- Monorepo scaffold + Postgres persistence.
- Core project/campaign APIs.

### Week 2
- Deterministic recipe engine + Maven recipes.
- Scan/Plan/Apply stage implementation.
- Evidence writer v1.

### Week 3
- Verifier, policy enforcement, confidence scoring.
- Run retrieval endpoint and integration wiring.
- Unit and fixture tests.

### Week 4
- DBOS runner stub + knowledge hook stub.
- End-to-end local demo hardening.
- Test stabilization and release checklist.
