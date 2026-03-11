# Code Porter V1 Stage 6

## Summary
Stage 6 targets two pilot blockers and one optional capability:
1. Deterministic Maven test-runtime Java 17 module-access remediation for `sun.nio.ch.FileChannelImpl` failures.
2. Reliable Android Gradle subtype classification and guarded baseline PR behavior when policy allows it.
3. Optional semantic retrieval scaffolding via Zilliz claude-context core, non-blocking and evidence-only.

## Goals
1. Classify Java 17 module-access test runtime failures as a dedicated failure kind and remediate with minimal, deterministic `--add-opens` edits.
2. Ensure Android Gradle repos classify as `android` (not `unknown`) and execute guarded baseline path under policy with explicit `needs_review` reasoning.
3. Add optional retrieval provider plumbing that stores context under `evidence/context/` and never blocks core workflow.
4. Keep deterministic-first behavior and Stage 5 reproducibility intact.

## Non-goals
1. No mandatory retrieval dependency for core execution.
2. No MCP sidecar orchestration in Stage 6 runtime path.
3. No broad Maven/Gradle refactors or non-deterministic edits.
4. No new HTTP endpoints.

## Acceptance Criteria
1. `npm run typecheck`, `npm test`, and `npm run test:integration` pass.
2. Axum targeted rerun reaches `completed` or yields a narrower failure kind than generic `code_test_failure`.
3. Android run with `allowAndroidBaselineApply=true` executes guarded baseline, opens PR in GitHub lane, and ends `needs_review` with explicit `summary.guardedBaselineReason`.
4. Stage 6 docs and expected-metrics retro updates are present.

## Risk Controls
1. Strict classifier signatures (`IllegalAccessError` + `sun.nio.ch.FileChannelImpl`/module-export phrasing) plus negative tests to avoid false positives.
2. POM edits restricted to existing surefire/failsafe plugin blocks; no blanket/global opens.
3. Retrieval provider loaded dynamically and wrapped in non-fatal error handling.
4. Android subtype detection expanded to nested module manifests and buildscript/plugin signatures.

## Implementation

### Maven test-runtime module access
1. Add `java17_module_access_test_failure` verify failure kind.
2. Add classifier rules for tests-phase module-access errors.
3. Add deterministic remediator for existing surefire/failsafe plugin `argLine` updates:
   - ensure `--add-opens=java.base/sun.nio.ch=ALL-UNNAMED`
   - no plugin insertion when absent
   - idempotent updates and patch evidence.
4. Add policy section `remediation.mavenTestRuntime` (default disabled, Stage 6 pilot enabled).

### Android guarded baseline accuracy
1. Extend Gradle subtype detection using:
   - plugin DSL,
   - `apply plugin` forms,
   - buildscript classpath signatures,
   - nested module Gradle files.
2. When policy allows Android guarded baseline:
   - classify as supported guarded path,
   - run plan/apply deterministic baseline,
   - skip compile/test verify with explicit guarded reason,
   - allow PR creation for GitHub projects.

### Optional semantic retrieval
1. Add semantic retrieval provider interface + noop implementation.
2. Add optional claude-context core provider (dynamic import).
3. Trigger retrieval only on verify failures and persist to `evidence/context/retrieval.json`.
4. On retrieval failure, record error payload and continue.

## Environment Flags
1. `SEMANTIC_RETRIEVAL_ENABLED=false`
2. `SEMANTIC_RETRIEVAL_PROVIDER=claude_context`
3. `SEMANTIC_RETRIEVAL_TOP_K=5`

## Test Plan

### Unit
1. Classifier maps module-access signature to `java17_module_access_test_failure`; negative cases stay non-module kinds.
2. Maven add-opens mutation is minimal, idempotent, and no-op when target plugins absent.
3. Android detection identifies `android` from nested/buildscript/plugin patterns.
4. Retrieval provider returns deterministic shape when enabled and non-fatal error payload on provider failure.

### Integration
1. Signature-triggered Maven remediation applies and reruns verify with remediation evidence artifacts.
2. Non-signature Maven test failure does not trigger module-access remediation.
3. Guarded Android baseline run returns `needs_review`, explicit guarded reason, and PR metadata (mocked GitHub).
4. Retrieval non-blocking evidence path is written on verify failures.

### Operational
1. Targeted Axum apply rerun under Stage 6 policy.
2. Targeted Android guarded run under Stage 6 policy.
3. RC preflight readiness after green suites.
