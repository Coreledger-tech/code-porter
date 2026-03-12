# Code Porter V1 Stage 8

## Summary
Stage 8 focuses on pilot outcome quality and signal stability:
1. Improve Axum time-to-green by adding a deterministic Java 17 test-runtime compatibility path for Chronicle-style reflective-access failures.
2. Stabilize pilot reporting with cohort-aware `/reports/pilot` views that separate actionable Maven outcomes from coverage-only outcomes.
3. Validate semantic retrieval in an Axum-only controlled run with sanitized evidence output and non-blocking behavior.
4. Ship after full quality gates and prepare `v1.0.0-rc.7`.

## Goals
1. Reduce generic `code_test_failure` outcomes for Axum and classify/runtime-remediate Java 17 reflective-access signatures deterministically.
2. Add reporting cohort splits (`all`, `actionable_maven`, `coverage`) without breaking existing report consumers.
3. Preserve deterministic-first execution: narrow test-runtime JVM arg patches only, no broad dependency/plugin sweeps.
4. Keep retrieval optional and non-blocking while ensuring evidence redaction safety.

## Non-goals
1. No new endpoint family or infrastructure.
2. No mandatory semantic retrieval dependency.
3. No production source refactors for Axum; test-runtime and build config only.
4. No expansion beyond existing pilot 5-repo orchestration flow.

## Acceptance Criteria
1. `npm run typecheck`, `npm test`, and `npm run test:integration` pass.
2. Axum targeted rerun ends `completed` or with a narrower deterministic failure kind than generic `code_test_failure`.
3. `/reports/pilot?cohort=actionable_maven` excludes unsupported/guarded noise and remains backward compatible.
4. Retrieval evidence (`context/retrieval.json`) is written on failing runs when enabled and remains sanitized/non-blocking.

## Risk Controls
1. Strict signature matching for Chronicle module-access failures to prevent false positives.
2. Test-runtime remediator edits only existing surefire/failsafe plugin `argLine` content.
3. Idempotent argLine updates with no comment-node corruption.
4. Retrieval output sanitized before evidence persistence; provider errors do not change run status/failureKind.

## Deterministic Axum Runtime Strategy
1. Detect tests-phase signatures:
   - `NoSuchFieldException: address`
   - `net.openhft.chronicle` (or Chronicle stack context)
2. Classify as Java 17 module-access test-runtime incompatibility.
3. Apply minimal JVM opens in existing surefire/failsafe `argLine`:
   - `--add-opens=java.base/sun.nio.ch=ALL-UNNAMED` (existing Stage 6)
   - `--add-opens=java.base/java.nio=ALL-UNNAMED` (Chronicle reflective access)
4. Rerun verifier after remediation and keep terminal failure mapping tied to final verify state.

## Pilot Reporting Cohort Model
1. `cohort=all`:
   - all apply-mode runs in window.
2. `cohort=actionable_maven`:
   - apply runs where `summary.scan.selectedBuildSystem='maven'` and `buildSystemDisposition='supported'`.
3. `cohort=coverage`:
   - apply runs not in actionable Maven cohort (unsupported/excluded/guarded/other lanes).
4. Existing report shape remains stable; response adds cohort metadata and cohort counts.

## Keeper PR Convention
1. One keeper PR per repo per pilot window.
2. Superseded PRs must be closed with a `superseded-by` note.
3. Merge gate requires:
   - diff scope within allowed files for that lane,
   - evidence artifacts present (`verify.json`, remediation artifacts when applicable),
   - classifier consistency (terminal failure kind matches final verify reality).

## Axum-Only Retrieval Experiment
1. Enable only for targeted Axum rerun:
   - `SEMANTIC_RETRIEVAL_ENABLED=true`
   - `SEMANTIC_RETRIEVAL_PROVIDER=claude_context`
   - `SEMANTIC_RETRIEVAL_TOP_K=5`
2. Run one failing Axum apply and verify:
   - `evidence/context/retrieval.json` exists,
   - payload is sanitized,
   - terminal status/failure kind unchanged versus retrieval-disabled baseline.

## Test Plan
1. Unit:
   - Chronicle signature classifier positive/negative cases.
   - Test-runtime remediator idempotence and minimal argLine patch behavior.
   - Cohort query parsing/validation and filter composition.
   - Retrieval sanitization checks.
2. Integration:
   - Signature-triggered remediator run writes patch artifacts and reruns verify.
   - Non-signature test failures do not apply Chronicle add-opens patch.
   - Cohort report split returns expected isolation.
   - Retrieval evidence remains non-blocking and sanitized.
3. Ops:
   - targeted Axum gate,
   - full pilot rerun,
   - report snapshots for `all`, `actionable_maven`, and `coverage`.
