# Code Porter V1 Stage 5

## Summary
Stage 5 upgrades the current `v1.0.0-rc.4` baseline with deterministic, pilot-focused improvements:
1. Axum test compatibility v2 for Maven test failures (`Nashorn` + `@Ignore/@Disabled` paths).
2. Android Gradle guarded baseline PR mode (deterministic apply, no Gradle task execution).
3. Docker Compose reliability hardening for repeatable container startup and migration.

This stage keeps deterministic-first execution, preserves evidence-first output, and avoids broad or agentic code refactors.

## Goals
1. Improve Maven test-side compatibility with narrow, idempotent recipes that only touch `src/test/**` and `pom.xml`.
2. Allow Android Gradle repos to produce baseline PRs under policy guardrails, with explicit `needs_review` reasoning.
3. Remove fragile compose defaults that cause cross-project container collisions or wrong DB host usage in container mode.
4. Keep Stage 4 behavior reproducible by introducing Stage 5 policy/pack identifiers instead of mutating old ones.

## Non-goals
1. No broad Java source rewrites in `src/main/**`.
2. No full Android CI parity in-platform (`assemble`, `test`, emulator/device lanes).
3. No dependency modernization sweeps beyond narrowly scoped deterministic edits.
4. No new HTTP endpoints.

## Acceptance Criteria
1. `java-maven-test-compat-v2-pack` applies deterministic test compatibility edits and remains idempotent.
2. Android Gradle guarded runs can apply deterministic baseline edits, open PRs (GitHub lane), and end as `needs_review` with an explicit guarded reason.
3. Compose stack runs without fixed container name collisions; migrate uses service-host defaults in container mode.
4. Existing Stage 4 tests remain green and Stage 5 test additions pass:
   - `npm run typecheck`
   - `npm test`
   - `npm run test:integration`

## Risk Controls
1. Keep recipe scope narrow:
   - Maven v2 edits limited to test Java and `pom.xml`.
   - Guarded Android edits limited to wrapper and `gradle.properties`.
2. Preserve idempotency and no-op behavior when preconditions are not met.
3. Keep deterministic plans explicit in evidence advisories and run summaries.
4. Continue policy-gated guarded mode (`gradle.allowAndroidBaselineApply`).

## Axum Test-Compat v2

### Strategy
Add a new Stage 5 pack (`java-maven-test-compat-v2-pack`) so Stage 4 packs remain reproducible. The pack includes existing Java 17/lombok safety recipes plus v2 test compatibility recipes.

### Deterministic Transformations
1. Nashorn namespace rewrite (test-only):
   - Rewrite `jdk.nashorn.` to `org.openjdk.nashorn.` in `src/test/java/**`.
   - No non-test Java changes.
2. Nashorn test dependency ensure:
   - If test sources require Nashorn and `pom.xml` lacks dependency, add:
     - `org.openjdk.nashorn:nashorn-core:15.4` with `<scope>test</scope>`.
   - Add once only; no unrelated `pom.xml` changes.
3. JUnit Ignore handling:
   - If JUnit 5 present in `pom.xml`: rewrite `@Ignore` to `@Disabled` with import migration.
   - Else (JUnit 4 lane): keep `@Ignore` and ensure `junit:junit:4.13.2` test dependency exists.

### Evidence Expectations
1. Recipe advisories must include matched signature context and exact deterministic action taken.
2. No-op advisories must explain why the transformation was skipped.
3. Changes remain bounded to `src/test/java/**` and `pom.xml`.

## Gradle Guarded Baseline PR

### Scope
Guarded mode applies to **Android subtype only**. JVM Gradle lane behavior remains unchanged.

### Allowed Edits
1. `gradle/wrapper/gradle-wrapper.properties` baseline updates.
2. `gradle.properties` deterministic baseline keys:
   - `org.gradle.java.installations.auto-detect=true`
   - `org.gradle.java.installations.auto-download=true`

### Forbidden Edits
1. No `build.gradle` or `build.gradle.kts` rewrites in guarded Android mode.
2. No dependency/plugin sweeps.
3. No Gradle task execution (`classes`, `test`, etc.) in guarded Android mode.

### Run Contract
1. GitHub lane still pushes branch and opens PR when configured.
2. Final status is `needs_review` with explicit `summary.guardedBaselineReason`.
3. Existing run PR fields (`prUrl`, `prState`) remain unchanged.

## Docker Compose Reliability
1. Remove fixed `container_name` usage to avoid project collisions.
2. Ensure `migrate/api/worker/pr-poller` container defaults use DB host `postgres` in compose mode, independent of host-local `.env`.
3. Preserve host-local workflows by keeping non-compose defaults and env overrides intact.

## Test Plan

### Unit
1. Nashorn rewrite recipe:
   - test-only file scope and idempotency.
2. Nashorn dependency ensure:
   - add-once behavior and no unrelated rewrites.
3. JUnit compatibility:
   - JUnit5 `@Ignore` -> `@Disabled`, JUnit4 dependency ensure path.
4. Gradle subtype detection:
   - robust Android signature matching.
5. Guarded gradle.properties recipe:
   - deterministic key insertion/update with unrelated key preservation.

### Integration
1. Axum-like Maven fixture:
   - test-compat v2 recipes apply and record evidence signatures/actions.
2. Android guarded Gradle run:
   - returns `needs_review`, includes guarded reason, skips Gradle command execution.
3. Android guarded GitHub path:
   - PR metadata persists with guarded outcome.
4. Compose reliability:
   - migrate + service startup succeeds using service-host DB defaults.
5. Regression:
   - Stage 4 integration coverage remains green.

### Pilot Lane
1. Add `pilot-stage5` policy and seed it.
2. Update pilot config:
   - Maven repos use `java-maven-test-compat-v2-pack`.
   - Android repo uses guarded Gradle baseline pack.
3. Keep same 5-repo order and cohort composition.
