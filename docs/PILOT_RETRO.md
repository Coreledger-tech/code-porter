# Code Porter Pilot Retro

## Pilot Metadata
- Pilot window: 2026-03-01
- Coordinator: Codex execution run
- Generated at: 2026-03-01T09:34:07.232Z
- Policy ID: `pilot-conservative`
- Recipe pack: `java-maven-plugin-modernize`
- Report window: `7d`
- Cohort artifact: `/Users/kelvinmusodza/Downloads/Code porter/evidence/pilot/2026-03-01T09-34-07-229Z/pilot-summary.json`

## Scope Note
- This retro is based on the corrected cohort rerun at `2026-03-01T09:34:07Z`.
- The cumulative `7d` report still contains an earlier misconfigured pilot attempt that used `main` for two `master` repos.
- Those four historical `workspace_prepare` blocked runs are real operational evidence, but they are not representative of the corrected cohort.

## Cohort
| repo | owner | bucket | campaignId | planRunId | applyRunId | applyStatus | prUrl | prState | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Java-Web-Crawler | Coreledger-tech | small | `cc30236d-4fd4-4071-8039-94ede0832a85` | `c21c1608-8ec0-412c-b582-ae872c157d8e` | `bcf594fc-6e12-4eb4-91b2-7e4b485c7283` | `needs_review` |  |  | Build system detected as `unknown`; policy denied lane entry and apply was skipped. |
| Axum-matching-engine | Coreledger-tech | medium | `78989c70-3406-48a3-8ebd-2faa1231cade` | `918c8a40-932c-4121-bb25-221f497395a0` | `191f18e8-274c-4b38-bb85-fa14828ae26e` | `needs_review` | `https://github.com/Coreledger-tech/Axum-matching-engine/pull/2` | `open` | Maven lane executed; PR opened; verifier failed on legacy `lombok-maven-plugin` under Java 17. |
| authelia-TOTP | Coreledger-tech | small | `3b8403b0-e70c-4863-ba87-f0ed4f4bf77f` | `012b6724-7270-4016-af54-fc40566ec4f0` | `593797ce-722b-4a4a-9e3e-47ca99044fe2` | `needs_review` |  |  | Corrected to `master`; build system still detected as `unknown`; apply skipped by policy. |
| Exception-handling-reconciliation | Coreledger-tech | medium | `2a823c41-f8a8-4df8-b3e2-b17aa20237aa` | `ccad04bf-dd60-49db-93ee-f74828a56cc4` | `ac4638b5-6c2e-49fd-8ddf-a37788a0e998` | `needs_review` |  |  | Build system detected as `unknown`; apply skipped by policy. |
| android-ESP-32-bluetooth-arduino | Coreledger-tech | messy | `034c8ede-59ff-4960-a970-2adb5996e058` | `ce49ef22-1bb4-4ec1-90eb-921a3e7faac8` | `92ca7848-cc8c-476b-84c0-9adf8036a49e` | `needs_review` |  |  | Corrected to `master`; build system detected as `gradle`; policy denied lane entry because pilot policy allows only Maven. |

## Corrected Cohort Results
- Run outcomes: `10/10 needs_review`, `0/10 blocked`, `0/10 completed`
- PR outcomes: `1` PR opened, `0` merged, `0` closed unmerged
- Retries observed: `0`
- Budget guardrails triggered: `0`
- Time-to-green: not yet measurable because no PR merged

## Metrics Snapshot (`/reports/pilot?window=7d`)
- totalsByStatus: `needs_review=19`, `blocked=4`
- PR outcomes: `opened=2`, `merged=0`, `closedUnmerged=0`, `open=2`, `mergeRate=0`
- timeToGreen: `sampleSize=0`, `p50Hours=null`, `p90Hours=null`
- retryRate: `1/23 = 4.35%`

## Interpreting the 7d Report
- The `blocked=4` and `workspace_prepare=4` counts come from the earlier pilot attempt that incorrectly forced `main` onto two `master` repositories.
- After fixing the pilot runner to use repo-specific default branches, the corrected cohort had `0` workspace preparation failures.
- The report still shows `unknown` as the top failure kind because `needs_review` runs that were policy-skipped do not currently persist a normalized `failureKind`.

## Top Failure Kinds
| rank | failureKind | count | blockedShare | notes |
| --- | --- | --- | --- | --- |
| 1 | `unknown` | 19 (7d aggregate) | `0/19` in corrected cohort, `19/19` unclassified | Mostly lane-mismatch or policy-skipped runs that need explicit failure-kind propagation. |
| 2 | `workspace_prepare` | 4 (7d aggregate) | `4/4` in earlier run, `0/4` in corrected cohort | Root cause was bad target branch selection, fixed by using repo `defaultBranch` in pilot automation. |
| 3 | `code_failure` | 1 repo in corrected cohort (Axum evidence) | `0` blocked, `1` needs_review | Real Java 17 migration blocker: legacy `lombok-maven-plugin:1.18.12.0` fails with `IllegalAccessError`. |

## Retry and Budget Guardrails
- Retries observed:
  - Corrected cohort: `0`
  - Aggregate 7d report: `1` retried run out of `23`
- Runs with `failureKind=budget_guardrail`: `0`
- Budget keys triggered: none
- Recommended budget adjustments: none yet; the pilot did not hit time/retry/evidence size guardrails.

## PR Outcomes
- Open: `1`
- Merged: `0`
- Closed unmerged: `0`
- Merge rate: `0%`
- Repos requiring manual follow-up:
  - `Coreledger-tech/Axum-matching-engine`: open PR, verifier failed on Java 17-incompatible Lombok Maven plugin.
  - `Coreledger-tech/Java-Web-Crawler`: repo did not enter a supported modernization lane.
  - `Coreledger-tech/authelia-TOTP`: repo did not enter a supported modernization lane.
  - `Coreledger-tech/Exception-handling-reconciliation`: repo did not enter a supported modernization lane.
  - `Coreledger-tech/android-ESP-32-bluetooth-arduino`: Gradle repo excluded by Maven-only pilot policy.

## Top 3 Blockers
1. Lane mismatch dominated the cohort.
   - Four of five repos did not enter the active Maven lane.
   - Three were detected as `unknown` build systems and one was `gradle`, so the deterministic recipes never ran.
2. The one true Maven repo exposed a concrete Java 17 compatibility gap.
   - `Axum-matching-engine` failed compile and test on `org.projectlombok:lombok-maven-plugin:1.18.12.0`.
   - That is a deterministic modernization target, not an environment flake.
3. Failure-kind reporting is too lossy for pilot prioritization.
   - Cohort runs that were denied by policy show up as `needs_review` with no normalized `failureKind`.
   - The aggregate report therefore ranks `unknown` above the actionable blockers.

## Top Missing Recipes or Remediations
| rank | item | type | triggerFailureKinds | expected impact |
| --- | --- | --- | --- | --- |
| 1 | `java-maven-lombok-java17-pack` | `recipe_pack` | `code_failure` | Convert Java 17-incompatible Lombok Maven plugin failures into deterministic plugin upgrades or targeted no-op advisories. |
| 2 | `build-system-readiness-preflight` | `operational` | `unknown`, `gradle` | Stop unsupported repos before plan/apply and classify them explicitly instead of producing opaque `needs_review` runs. |
| 3 | `gradle-lane-admission-and-baseline-policy` | `operational` | `gradle` | Separate Gradle repos from Maven-only pilots so lane mismatch does not consume pilot slots. |

## Proposed Next Two Deterministic Recipe Packs
1. Candidate: `java-maven-lombok-java17-pack`
- Rationale: the only true Maven modernization attempt failed on a legacy Lombok Maven plugin that is not Java 17 compatible.
- Expected pass@1 impact: highest immediate upside; it directly targets the only repo that reached deterministic apply + verify and should materially improve Maven pass@1.
- Risks: plugin bump may need coordinated Lombok core or compiler settings and should stay conservative to avoid behavior drift.

2. Candidate: `java-gradle-java17-baseline-pack`
- Rationale: one repo in the cohort is Gradle and was excluded entirely by the Maven-only policy; a narrow Gradle baseline pack would convert that repo from non-actionable to actionable.
- Expected pass@1 impact: expands pilot coverage by opening a second deterministic lane instead of burning pilot capacity on unsupported repos.
- Risks: Gradle ecosystems vary more than Maven; the first pack should stay tight to wrapper/JVM target/test baseline changes only.

## Next Two Verifier Remediation Candidates
1. `build-system-and-lane-preflight`
- Detect `unknown` and unsupported build systems before campaign creation or enqueue.
- Persist a normalized reason such as `unsupported_build_system` instead of leaving `failureKind` null.

2. `java17-plugin-compat-diagnostics`
- Detect verifier signatures like `lombok-maven-plugin` `IllegalAccessError` and emit a specific remediation hint.
- This should classify plugin-compat failures distinctly so they are visible in `/reports/pilot`.

## Action Backlog
| priority | action | owner | target date | status |
| --- | --- | --- | --- | --- |
| P0 | Add `java-maven-lombok-java17-pack` and validate on `Axum-matching-engine` | Engineering | 2026-03-08 | proposed |
| P0 | Add explicit unsupported-build-system classification/preflight for pilot campaigns | Engineering | 2026-03-05 | proposed |
| P1 | Define a narrow `java-gradle-java17-baseline-pack` and a Gradle-safe pilot policy | Engineering | 2026-03-12 | proposed |
| P1 | Re-run the pilot after Lombok and preflight work, using the same 5-repo cohort | Operations | 2026-03-12 | proposed |

## Iteration 1 Results
- Iteration artifact: `/Users/kelvinmusodza/Downloads/Code porter/evidence/pilot/2026-03-01T19-11-00-572Z/pilot-summary.json`
- Generated at: `2026-03-01T19:11:00.576Z`
- Policy ID: `pilot-conservative`
- Recipe pack: `java-maven-lombok-java17-pack`

### Baseline vs Iteration 1
| metric | baseline corrected cohort | iteration 1 |
| --- | --- | --- |
| completed apply runs | `0` | `1` |
| needs_review apply runs | `5` | `4` |
| blocked apply runs | `0` | `0` |
| open PRs | `1` | `2` |
| merged PRs | `0` | `0` |
| explicit unsupported apply runs | `0` | `3` |
| unknown build-system repo outcomes | `3` | `0` |
| green verify count | `0` | `1` |

### Cohort Outcome
| repo | applyStatus | prUrl | key evidence |
| --- | --- | --- | --- |
| Java-Web-Crawler | `completed` | `https://github.com/Coreledger-tech/Java-Web-Crawler/pull/1` | Nested Maven module at `my-app/pom.xml` was detected and executed from `selectedBuildRoot=my-app`. |
| Axum-matching-engine | `needs_review` | `https://github.com/Coreledger-tech/Axum-matching-engine/pull/3` | Lombok plugin was bumped to `1.18.20.0`; original `IllegalAccessError` is gone, but `delombok` still fails with `NoSuchFieldError` and downstream missing builder symbols. |
| authelia-TOTP | `needs_review` |  | Explicitly classified as `unsupported_build_system` with primary `go` and secondary `node` detections. |
| Exception-handling-reconciliation | `needs_review` |  | Explicitly classified as `unsupported_build_system`; no supported manifest found within the scan depth. |
| android-ESP-32-bluetooth-arduino | `needs_review` |  | Explicitly classified as `unsupported_build_system`; detected as `gradle` and excluded by Maven-only policy. |

### Concrete Deltas
- `Java-Web-Crawler` no longer falls into `unknown`.
  - Scan summary now records:
    - `selectedBuildSystem = maven`
    - `selectedBuildRoot = my-app`
    - `selectedManifestPath = my-app/pom.xml`
  - Apply run `a1fb5c6b-fdcf-4bc5-9b47-dca588a824c0` completed with score `86` and opened PR `#1`.
- `Axum-matching-engine` no longer fails with the previous Lombok `IllegalAccessError`.
  - Baseline failure: `lombok-maven-plugin:1.18.12.0` with `IllegalAccessError`.
  - Iteration 1 failure: `lombok-maven-plugin:1.18.20.0` with `NoSuchFieldError` during `delombok`, followed by missing generated builder symbols.
  - This is progress: the original Java 17 plugin incompatibility signature is removed, but Lombok/delombok compatibility remains the active blocker.
- Unsupported lanes are now explicit instead of opaque.
  - Iteration artifact failure kinds: `unsupported_build_system=6`, `code_failure=1`, `unknown=0` within the cohort artifact.
  - The aggregate `7d` report still shows `unknown=3` because it includes non-iteration rows and plan-mode runs without normalized failure kinds.

### Iteration 1 Metrics Snapshot
- Cohort statuses: `completed=1`, `needs_review=9`
- Cohort failure kinds: `unsupported_build_system=6`, `code_failure=1`
- PR outcomes: `open=2`, `merged=0`
- Retries: `0`
- Budget guardrails triggered: `0`
- `/reports/pilot?window=7d` snapshot after rerun:
  - `completed=1`, `needs_review=10`
  - `topFailureKinds = unsupported_build_system(6), unknown(3), code_failure(2)`
  - `mergeRate = 0`
  - `retryRate = 1/11 = 9.09%`

### Top 3 Blockers After Iteration 1
1. Maven-only policy still excludes three repos from actionable execution.
   - `authelia-TOTP`, `Exception-handling-reconciliation`, and `android-ESP-32-bluetooth-arduino` are now truthfully classified, but they still consume pilot attention without yielding modernization output.
2. Axum still has a deterministic Lombok/delombok compatibility failure after the initial plugin bump.
   - The active failure is now `NoSuchFieldError` in `lombok-maven-plugin:1.18.20.0`, not the original `IllegalAccessError`.
3. Aggregate reporting still carries some `unknown` rows outside the cohort artifact.
   - Cohort-level evidence is clean, but the 7-day aggregate still mixes in non-iteration rows and plan-mode runs that do not set a failure kind.

### Prioritized Next Fixes
#### Next 2 deterministic recipe candidates
1. `java-maven-lombok-delombok-compat-pack`
   - Target the remaining Axum blocker by handling legacy `lombok-maven-plugin` delombok usage more explicitly.
   - Expected impact: convert the remaining Maven `code_failure` into either `completed` or a narrower next blocker.
2. `java-gradle-java17-baseline-pack`
   - The pilot has one explicit Gradle repo and zero Gradle lane coverage.
   - Expected impact: turn `android-ESP-32-bluetooth-arduino` from policy-excluded to actionable in the next pilot wave.

#### Next 2 verifier remediation candidates
1. `unsupported-build-system preflight`
   - Gate campaign start with the same scanner used at run time so non-Maven repos are identified before pilot slots are consumed.
2. `lombok delombok compatibility diagnostics`
   - Recognize `NoSuchFieldError` / `delombok` signatures separately from generic `code_failure` and emit targeted remediation guidance in evidence and reports.

## Stage 2 / rc.2
- Stage 2 scope stayed intentionally narrow: stabilize `release:rc`, merge the completed `Java-Web-Crawler` PR, and rerun only `Axum-matching-engine` with a deterministic Lombok delombok compatibility pack.
- `Java-Web-Crawler` PR `#1` was squash-merged on `2026-03-01T20:22:44Z`.
  - PR: `https://github.com/Coreledger-tech/Java-Web-Crawler/pull/1`
  - This gives the pilot its first real merge and unblocks time-to-green measurement on the next report window.
- `Axum-matching-engine` was rerun with `java-maven-lombok-delombok-compat-pack`.
  - Apply run: `87483118-4a2c-4dbd-9c66-29e4b2252986`
  - Replacement PR: `https://github.com/Coreledger-tech/Axum-matching-engine/pull/4`
  - Superseded PR `#3` was closed after the rerun produced a better diff and evidence trail.
- The Stage 1 Lombok delombok crash signature is eliminated.
  - The rerun no longer fails inside `lombok-maven-plugin` with `NoSuchFieldError`, `JCImport`, or `qualid`.
  - The current verifier output is now ordinary compile-time project breakage: missing Lombok-generated builders, missing `builder()` methods, and other downstream symbols.
  - This is the minimum acceptable success condition for Stage 2 because the platform has moved from plugin/runtime incompatibility into the project's next real code-level blocker.
- `v1.0.0-rc.2` was cut locally after a clean run of:
  - `npm run typecheck`
  - `npm test`
  - `npm run test:integration`
- The full 5-repo cohort rerun is deferred until the Gradle lane exists.
  - Re-running the whole cohort now would mostly reconfirm the Maven-only boundary rather than produce new modernization signal.

## Stage 3 Results
- Stage 3 code landed locally and passed:
  - `npm run typecheck`
  - `npm test`
  - `npm run test:integration`
- GHCR verification result:
  - private package login succeeds with PAT (`read:packages`)
  - `npm run verify:ghcr -- --tag v1.0.0-rc.2` now succeeds
  - `rc.2` is single-arch and requires fallback pull on Apple Silicon:
    - `docker pull --platform linux/amd64 ghcr.io/coreledger-tech/code-porter:v1.0.0-rc.2`
  - publishing workflow has been updated to multi-arch for future tags (`linux/amd64`, `linux/arm64`)

### Axum Targeted Rerun
- Fresh Stage 3 runtime used:
  - API: `http://127.0.0.1:3014`
  - Java: `Temurin 17.0.18`
  - policy: `pilot-stage3`
  - recipe pack: `java-maven-lombok-delombok-compat-pack`
- Targeted apply run:
  - runId: `77662191-27bd-47b9-b3a8-29022b0407d0`
  - PR: `https://github.com/Coreledger-tech/Axum-matching-engine/pull/8`
  - final status: `needs_review`
  - failureKind: `code_test_failure`
- Verifier result:
  - compile passes on Java 17
  - tests fail in `testCompile`
  - current failures are ordinary project test-source issues:
    - `package jdk.nashorn.internal.ir.annotations does not exist`
    - `cannot find symbol class Ignore`
- Remediation result:
  - compile remediator did not run because compile already passed
  - `remediation.json` records `applied=false` and `reason=not_applicable`
- Gate decision:
  - Stage 3 Axum gate passed
  - the old toolchain/plugin crash path is gone
  - remaining failures are normal project-level test compatibility issues

### Full Cohort Rerun
- Cohort artifact: `/Users/kelvinmusodza/Downloads/Code porter/evidence/pilot/2026-03-02T00-20-02-233Z/pilot-summary.json`
- Runtime:
  - API: `http://127.0.0.1:3014`
  - Java: `Temurin 17.0.18`
  - policy: `pilot-stage3`
- Cohort outcomes:
  - `completed=1`
  - `needs_review=9`
  - `blocked=0`
  - `retries=0`
  - `budget guardrails=0`
  - `open PRs=1`
- Repo results:
  - `Java-Web-Crawler`
    - apply status: `completed`
    - build system: `maven`
    - selected build root: nested Maven lane already normalized; no new PR was needed in this rerun
  - `Axum-matching-engine`
    - apply status: `needs_review`
    - failureKind: `code_test_failure`
    - PR: `https://github.com/Coreledger-tech/Axum-matching-engine/pull/9`
  - `authelia-TOTP`
    - apply status: `needs_review`
    - failureKind: `unsupported_build_system`
    - selected build system: `go`
    - disposition: `excluded_by_policy`
  - `Exception-handling-reconciliation`
    - apply status: `needs_review`
    - failureKind: `unsupported_build_system`
    - selected build system: `unknown`
    - disposition: `no_supported_manifest`
  - `android-ESP-32-bluetooth-arduino`
    - apply status: `needs_review`
    - failureKind: `unsupported_build_system`
    - selected build system: `gradle`
    - disposition: `unsupported_subtype`
    - gradleProjectType: `unknown`
    - result: no PR, but the lane now returns an explicit unsupported subtype rather than an opaque unknown

### Stage 3 Comparison vs Stage 2
| metric | Stage 2 | Stage 3 |
| --- | --- | --- |
| GHCR verification | not verified | verified via authenticated pull + arm fallback |
| Axum failure kind | `code_compile_failure` | `code_test_failure` |
| Axum compile status | failed | passed |
| Axum remediation applied | no | no; compile remediator not applicable once compile passed |
| Axum PR candidate | `#4` | `#9` |
| Gradle precise subtype result | not exercised live | yes |
| full cohort rerun | deferred | executed |
| completed apply runs | `0` | `1` |

### Top Remaining Blockers After Stage 3
1. Axum now fails in test sources rather than build tooling.
   - The blocking errors are project-level Java 17 test compatibility issues (`jdk.nashorn.internal.ir.annotations`, `Ignore`), not lane/toolchain failures.
2. Real-world Gradle subtype inference needs one more pass.
   - The Android repo is correctly held out of the JVM-only lane, but it is classified as `unknown` subtype rather than `android`.
3. The aggregate `7d` report still carries historical `unknown` rows.
   - The Stage 3 cohort artifact is clean, but `/reports/pilot?window=7d` still mixes in older runs from before the classification changes.

### Next Operator Actions
1. Review `Axum-matching-engine` PR `#9` as a merge candidate for compile-side modernization; treat the remaining test failures as the next deterministic/test lane target.
2. Keep Android subtype refinement out of the critical path unless the next pilot specifically needs Android support.
3. For `rc.3+`, verify GHCR native arm pulls after the multi-arch publish workflow runs on a new tag.

## Stage 4 Results
- Stage 4 cohort artifact: `/Users/kelvinmusodza/Downloads/Code porter/evidence/pilot/2026-03-10T06-45-50-557Z/pilot-summary.json`
- Stage 4 report snapshot: `/tmp/pilot-report-stage4-7d.json`
- Policy ID: `pilot-stage4`
- Maven pack: `java-maven-test-compat-pack`

## Stage 6 Expected Deltas
This section is intentionally pre-execution and contains expected outcomes only.

1. Maven module-access test runtime failures should move from generic `code_test_failure` to `java17_module_access_test_failure` when the strict signature is present.
2. Deterministic test-runtime remediation should add minimal surefire/failsafe `--add-opens=java.base/sun.nio.ch=ALL-UNNAMED` configuration only when required by evidence.
3. Android Gradle repos with `allowAndroidBaselineApply=true` should follow guarded baseline path with explicit guarded reasoning, avoiding opaque unsupported-subtype outcomes.
4. Optional semantic retrieval should produce `evidence/context/retrieval.json` on verify failures without changing terminal run semantics.

## Stage 8 Expected Deltas
This section is intentionally pre-execution and contains expected outcomes only.

1. Axum should no longer terminate as generic `code_test_failure` when Chronicle Java 17 reflective-access signatures are present; deterministic test-runtime remediation should apply minimal JVM opens and rerun verify.
2. `/reports/pilot` should support cohort views:
   - `all` for full apply-mode pilot runs,
   - `actionable_maven` for supported Maven lane metrics,
   - `coverage` for excluded/guarded/other-lane outcomes.
3. Top failure kinds in actionable cohort should reflect true modernization blockers rather than unsupported-lane noise.
4. Retrieval experiment for Axum-only failures should emit `context/retrieval.json` with sanitized content and no status/failure-kind side effects.
5. Keeper PR convention should reduce multi-PR drift by enforcing one active keeper PR per repo window.

## Stage 5 Expected Deltas
This section is intentionally pre-execution and contains expected outcomes only.

1. Axum test-compat v2 should reduce test-side compatibility failures by:
   - rewriting `jdk.nashorn.*` test imports/references to `org.openjdk.nashorn.*`
   - ensuring `org.openjdk.nashorn:nashorn-core:15.4` test dependency when required
   - normalizing `@Ignore` usage by JUnit lane (`@Disabled` for JUnit5, dependency ensure for JUnit4)
2. Android Gradle repos should move from opaque lane outcomes to deterministic guarded baseline outcomes:
   - baseline wrapper/properties edits only
   - no Gradle task execution
   - terminal `needs_review` with explicit `summary.guardedBaselineReason`
3. Pilot policy migration from `pilot-stage4` to `pilot-stage5` should preserve cohort comparability while isolating Stage 5 behavior.
4. Compose startup and migration should be more repeatable in container mode due to:
   - no fixed global container names
   - service-host DB defaults (`postgres`) for migration/runtime services.
- Gradle pack: `java-gradle-java17-baseline-pack`

### GHCR Verification Closure
- Verification mode is now reproducible and documented.
- Current package setting remains private; authenticated pull works with PAT.
- `npm run verify:ghcr -- --tag v1.0.0-rc.2` succeeds using login credentials.
- `rc.2` remains single-arch in registry history; multi-arch validation should be asserted on the next tag publish.

### Axum Targeted Gate (Stage 4)
- Targeted run: `fee733e3-0ae9-4378-bd66-56893134740e`
- Status: `needs_review`
- Failure kind: `code_test_failure`
- PR: `https://github.com/Coreledger-tech/Axum-matching-engine/pull/10`
- Deterministic actions recorded in evidence:
  - Lombok plugin bump + delombok phase shift
  - Nashorn Ignore import rewrite in test sources
  - JUnit Ignore compatibility rewrite to JUnit 5 `@Disabled`
- Gate outcome:
  - Prior Lombok plugin/runtime crash signature remained eliminated
  - Failure moved to normal test-side incompatibility, which is within the intended Stage 4 scope

### Full 5-Repo Cohort Rerun (Stage 4)
| repo | applyStatus | failureKind | disposition | prUrl |
| --- | --- | --- | --- | --- |
| Java-Web-Crawler | `completed` |  | `supported` |  |
| Axum-matching-engine | `needs_review` | `code_test_failure` | `supported` | `https://github.com/Coreledger-tech/Axum-matching-engine/pull/11` |
| authelia-TOTP | `needs_review` | `unsupported_build_system` | `excluded_by_policy` |  |
| Exception-handling-reconciliation | `needs_review` | `unsupported_build_system` | `no_supported_manifest` |  |
| android-ESP-32-bluetooth-arduino | `needs_review` | `unsupported_build_system` | `unsupported_subtype` |  |

### Stage 4 Comparison vs Stage 3
| metric | Stage 3 | Stage 4 |
| --- | --- | --- |
| completed apply runs | `1` | `1` |
| needs_review apply runs | `4` | `4` |
| blocked apply runs | `0` | `0` |
| open PRs from cohort apply | `1` | `1` |
| Axum targeted gate PR | `#8`/`#9` sequence | `#10` |
| dominant cohort failure kind | `unsupported_build_system` | `unsupported_build_system` |
| Axum lane failure kind | `code_test_failure` | `code_test_failure` |

### Metrics Snapshot (`/reports/pilot?window=7d`, captured after Stage 4 rerun)
- totalsByStatus: `needs_review=11`, `completed=1`, `cancelling=1`
- topFailureKinds:
  - `unsupported_build_system=6`
  - `unknown=4` (historical rows in 7d window)
  - `code_test_failure=3`
- prOutcomes: `opened=2`, `merged=0`, `open=2`, `mergeRate=0`
- retryRate: `2/13 = 15.38%`
- timeToGreen: no merged sample yet

### Top 3 Blockers After Stage 4
1. Unsupported lanes still dominate (`unsupported_build_system`) in this cohort.
2. Axum has moved into test-compat work; compile/toolchain blocker is no longer the leading issue.
3. Android Gradle repo is explicit but still non-actionable under current subtype classification (`unsupported_subtype`, `gradleProjectType=unknown`).

### Next Pack Priorities (Data-Driven)
1. `java-junit5-transition-pack`
- Trigger evidence: persistent `code_test_failure` on Axum after compile/toolchain fixes.
- Expected impact: reduce remaining test annotation/framework drift.

2. `java-maven-repository-resilience-pack`
- Trigger evidence: recurring report recommendation and historical resolver-related noise in mixed pilot windows.
- Expected impact: reduce flake/needs-review pressure from Maven fetch instability.

## Stage 6 Results
- Stage 6 cohort artifact: `/Users/kelvinmusodza/Downloads/Code porter/evidence/pilot/2026-03-11T06-11-16-047Z/pilot-summary.json`
- Stage 6 report snapshot (`7d`): `generatedAt=2026-03-11T06:11:34.204Z`
- Policy ID: `pilot-stage6`
- Maven pack: `java-maven-test-compat-pack`
- Gradle pack: `java-gradle-guarded-baseline-pack`

### Targeted Gates (Pre-Cohort)
1. Axum targeted apply gate
- runId: `6e504091-b2da-4467-9076-bfeed8d6f549`
- status: `needs_review`
- failureKind: `code_compile_failure`
- remediation evidence: `remediation-test-runtime.json` + `artifacts/remediation-test-runtime-1.patch`
- remediation rule applied: `ensure_add_opens_sun_nio_ch`
- PR opened: `https://github.com/Coreledger-tech/Axum-matching-engine/pull/15`
- outcome: Stage 6 remediator fired on `triggerFailureKind=java17_module_access_test_failure`; verify-after moved to `testsFailureKind=code_test_failure` while terminal run classification remained `code_compile_failure`.

2. Android targeted guarded-baseline gate
- runId: `5985ea5f-b21d-435b-8e4f-8ad9d6bd5278`
- status: `needs_review`
- failureKind: `null` (guarded lane)
- scan disposition: `supported`
- gradleProjectType: `android`
- PR opened: `https://github.com/Coreledger-tech/android-ESP-32-bluetooth-arduino/pull/1`
- outcome: guarded Android baseline engaged as designed with explicit `summary.guardedBaselineReason`.

### Full 5-Repo Cohort Rerun (Stage 6)
| repo | applyRunId | applyStatus | failureKind | disposition | gradleProjectType | remediation | prUrl |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Java-Web-Crawler | `274e7a78-47cf-4bd6-ba78-a0d93979376e` | `completed` |  | `supported` |  | none |  |
| Axum-matching-engine | `805230d5-3343-4f2b-aba9-b7dca100a0a2` | `needs_review` | `code_compile_failure` | `supported` |  | `ensure_add_opens_sun_nio_ch` | `https://github.com/Coreledger-tech/Axum-matching-engine/pull/16` |
| authelia-TOTP | `80a6ef8e-3612-4995-b1d4-73345743bb81` | `needs_review` | `unsupported_build_system` | `excluded_by_policy` |  | none |  |
| Exception-handling-reconciliation | `7b3a9187-9593-4a9c-b8ff-5f699b48561a` | `needs_review` | `unsupported_build_system` | `no_supported_manifest` |  | none |  |
| android-ESP-32-bluetooth-arduino | `3d5dbdd3-bc54-4fee-8d02-b65d3d914402` | `needs_review` |  | `supported` | `android` | none | `https://github.com/Coreledger-tech/android-ESP-32-bluetooth-arduino/pull/2` |

### Stage 6 Metrics Snapshot
- Cohort statuses: `completed=1`, `needs_review=9`, `blocked=0`
- Cohort failure kinds: `unsupported_build_system=4`, `code_compile_failure=1`
- Cohort retries: `0`
- Cohort PR outcomes: `opened=2`, `merged=0`, `closed=0`
- 7d aggregate report:
  - totalsByStatus: `needs_review=12`, `completed=1`
  - topFailureKinds: `unknown=6`, `unsupported_build_system=4`, `code_compile_failure=2`, `code_test_failure=1`
  - prOutcomes: `opened=4`, `merged=0`, `open=4`, `mergeRate=0`
  - retryRate: `1/13 = 7.69%`

### Stage 6 Delta Assessment
1. Axum path remains narrowed with deterministic remediation evidence.
- Module-access remediator fired and produced explicit patch/evidence artifacts, but the final run still settled on `code_compile_failure`.
2. Android guarded baseline objective passed.
- Android is classified as `gradle/android`, executes guarded apply, and opens PRs with explicit guarded reason.
3. Signature-absent no-op behavior is preserved in non-Axum cohort runs.
- Runs without module-access signatures (for example Java-Web-Crawler) show no test-runtime remediation rule application (`remediationRules=[]`).

## Stage 7 Results
- Stage 7 cohort artifact: `/Users/kelvinmusodza/Downloads/Code porter/evidence/pilot/2026-03-11T07-30-50-715Z/pilot-summary.json`
- Stage 7 report snapshot (`7d`): `generatedAt=2026-03-12T01:11:34.224Z`
- Policy ID: `pilot-stage6`
- Maven pack: `java-maven-test-compat-pack`
- Gradle pack: `java-gradle-java17-baseline-pack`

### PR Triage Outcomes
1. Android triage
- Kept PR `#2`, closed PR `#1` as superseded, and squash-merged PR `#2`.
- Merged PR: `https://github.com/Coreledger-tech/android-ESP-32-bluetooth-arduino/pull/2` (`merged_at=2026-03-11T06:30:20Z`).

2. Axum triage
- Closed superseded PRs `#15`, `#16`, and `#18`.
- Kept and squash-merged PR `#19`.
- Merged PR: `https://github.com/Coreledger-tech/Axum-matching-engine/pull/19` (`merged_at=2026-03-12T01:10:41Z`).

### Targeted Gates (Post-Fix)
1. Axum targeted apply gate
- runId: `08702830-00a6-42b7-9129-bac9a6a5d1af`
- status: `needs_review`
- failureKind: `code_test_failure`
- remediation evidence: `remediation-test-runtime.json` + `artifacts/remediation-test-runtime-1.patch`
- remediation rule applied: `ensure_add_opens_sun_nio_ch`
- PR opened then superseded: `https://github.com/Coreledger-tech/Axum-matching-engine/pull/18`
- outcome: terminal failure kind now matches final verify reality (`tests failed`, compile passed), eliminating the earlier stale `code_compile_failure` mismatch.

2. Android targeted guarded-baseline gate
- runId: `09129c72-a33b-4de0-afe7-b7b257f8bcaf`
- status: `needs_review`
- failureKind: `guarded_baseline_applied`
- scan metadata: `selectedBuildSystem=gradle`, `gradleProjectType=android`, `buildSystemDisposition=supported`
- guarded reason: `Guarded Android baseline apply mode skips Gradle task execution; run full Android CI outside Code Porter before merge`
- PR outcome: none in this run (`changedFiles=0`), expected because baseline changes were already present.

### Full 5-Repo Cohort Rerun (Stage 7)
| repo | planRunId | applyRunId | applyStatus | applyFailureKind | prUrl |
| --- | --- | --- | --- | --- | --- |
| Java-Web-Crawler | `13ded092-85c1-4c2a-905e-bb2906a50875` | `f454b910-41c4-4506-a1f6-23c0ef79006c` | `completed` |  |  |
| Axum-matching-engine | `485be928-bcb8-4174-b10d-821df48ecbbd` | `b2516e83-c495-495f-b0e2-bcf162c6425d` | `needs_review` | `code_test_failure` | `https://github.com/Coreledger-tech/Axum-matching-engine/pull/19` |
| authelia-TOTP | `3f4703d8-e7e4-413f-815b-5ee02e82da36` | `086d48a4-8144-4dc5-b5d5-de2cac510400` | `needs_review` | `unsupported_build_system` |  |
| Exception-handling-reconciliation | `0717d29a-3cbc-4d9a-aa46-5f65535f5b1a` | `b091bf6f-e178-4fa6-ad9a-3a18ca3fc020` | `needs_review` | `unsupported_build_system` |  |
| android-ESP-32-bluetooth-arduino | `7068bfe3-9dd8-4e65-90aa-5b84be37be32` | `4434be4e-bfc8-41a1-a94c-6772c8932e90` | `needs_review` | `guarded_baseline_applied` |  |

### Stage 7 Metrics Snapshot
- Cohort statuses: `completed=1`, `needs_review=9`, `blocked=0`
- Cohort failure kinds: `unsupported_build_system=4`, `code_test_failure=1`, `guarded_baseline_applied=1`
- 7d aggregate report:
  - totalsByStatus: `needs_review=12`, `completed=1`
  - topFailureKinds: `unsupported_build_system=4`, `manual_review_required=3`, `code_test_failure=3`, `guarded_baseline_applied=2`, `unknown=1`
  - prOutcomes: `opened=2`, `merged=1`, `closedUnmerged=1`, `open=0`, `mergeRate=0.5`
  - timeToGreen: `sampleSize=1`, `p50Hours=17.667565`, `p90Hours=17.667565`
  - retryRate: `1/13 = 7.69%`

### Stage 7 Delta Assessment
1. Reporting normalization is now stable for guarded and policy-excluded paths.
- Guarded Android runs persist `failureKind=guarded_baseline_applied`.
- Policy-excluded/no-manifest runs persist `failureKind=unsupported_build_system`.
- `unknown` is no longer the top 7d failure kind.
2. Axum classifier consistency is fixed.
- Module-access remediator can trigger on test-runtime signature, and terminal classification now reflects final verify phase (`code_test_failure` here).
3. Merge signal is now visible in pilot reporting.
- 7d report now has `merged=1` and non-null time-to-green from merged Axum PR `#19`.

## Stage 8 Results
- Stage 8 cohort artifact: `/Users/kelvinmusodza/Downloads/Code porter/evidence/pilot/2026-03-12T02-47-35-554Z/pilot-summary.json`
- Stage 8 report snapshots:
  - `/tmp/pilot-report-stage8-all.json`
  - `/tmp/pilot-report-stage8-actionable.json`
  - `/tmp/pilot-report-stage8-coverage.json`
- Policy ID: `pilot-stage8`
- Maven pack: `java-maven-test-compat-stage8-pack`
- Gradle pack: `java-gradle-guarded-baseline-pack`

### Targeted Gates (Pre-Cohort)
1. Axum targeted apply gate
- runId: `30fadee6-756b-4c99-9d28-8e8e8ba501d7`
- status: `needs_review`
- failureKind: `code_test_failure`
- remediation evidence:
  - `/Users/kelvinmusodza/Downloads/Code porter/evidence/61afa147-9a90-48df-ad66-c8dd16360be7/676b8f0b-e86b-4b3f-be16-5c24aee4d4eb/30fadee6-756b-4c99-9d28-8e8e8ba501d7/remediation-test-runtime.json`
  - `/Users/kelvinmusodza/Downloads/Code porter/evidence/61afa147-9a90-48df-ad66-c8dd16360be7/676b8f0b-e86b-4b3f-be16-5c24aee4d4eb/30fadee6-756b-4c99-9d28-8e8e8ba501d7/artifacts/remediation-test-runtime-1.patch`
- remediation rule applied: `ensure_add_opens_java_nio`
- PR opened: `https://github.com/Coreledger-tech/Axum-matching-engine/pull/20`

2. Android targeted guarded-baseline gate
- runId: `4b72a871-6d39-4542-9077-e8ee0ad1ddb9`
- status: `needs_review`
- failureKind: `guarded_baseline_applied`
- scan metadata: `selectedBuildSystem=gradle`, `gradleProjectType=android`, `buildSystemDisposition=supported`
- guarded reason: `Guarded Android baseline apply mode skips Gradle task execution; run full Android CI outside Code Porter before merge`
- PR outcome: none in this run (`changedFiles=0`, deterministic baseline already applied)

### Full 5-Repo Cohort Rerun (Stage 8)
| repo | planRunId | applyRunId | applyStatus | applyFailureKind | prUrl |
| --- | --- | --- | --- | --- | --- |
| Java-Web-Crawler | `3cb951b8-bd1e-4122-8f8f-9a2b97ce09da` | `d626c757-27d4-444c-990b-9493a519ec72` | `completed` |  |  |
| Axum-matching-engine | `96e211e1-e372-4121-a9f7-4c6f2ac380ea` | `066c6dc5-7388-48e4-a2f4-22fbc2cf8c15` | `needs_review` | `code_test_failure` | `https://github.com/Coreledger-tech/Axum-matching-engine/pull/21` |
| authelia-TOTP | `20669884-93df-45f1-83b3-d92bc1501000` | `177a6dc7-65f5-432e-8ebf-2700fda9d26d` | `needs_review` | `unsupported_build_system` |  |
| Exception-handling-reconciliation | `69912e5f-925c-4275-810c-7ce434a37c66` | `438b4c85-0ade-47a3-8c47-4d9d4432fc89` | `needs_review` | `unsupported_build_system` |  |
| android-ESP-32-bluetooth-arduino | `f346eea4-2c5e-4395-b776-cde03abaabd2` | `0438d8c6-807f-48b2-a044-3ec71b48488b` | `needs_review` | `guarded_baseline_applied` |  |

### Stage 8 Cohort-Split Metrics (`window=7d`)
1. `cohort=all`
- totalsByStatus: `completed=1`, `needs_review=7`
- topFailureKinds: `code_test_failure=3`, `guarded_baseline_applied=2`, `unsupported_build_system=2`, `unknown=1`
- prOutcomes: `opened=2`, `merged=0`, `open=2`, `mergeRate=0`

2. `cohort=actionable_maven`
- totalsByStatus: `completed=1`, `needs_review=3`
- topFailureKinds: `code_test_failure=3`, `unknown=1`
- prOutcomes: `opened=2`, `merged=0`, `open=2`, `mergeRate=0`

3. `cohort=coverage`
- totalsByStatus: `needs_review=4`
- topFailureKinds: `guarded_baseline_applied=2`, `unsupported_build_system=2`
- prOutcomes: `opened=0`, `merged=0`

### Stage 8 Delta Assessment
1. Axum Chronicle remediator path is evidenced and deterministic.
- Runtime remediation applied `ensure_add_opens_java_nio` and produced a narrow patch to existing surefire/failsafe `argLine`.
- Terminal failure remained `code_test_failure` due a subsequent reflective-access test issue (`java.base` `opens java.lang`), not the original Chronicle signature.

2. Cohort reporting split is operational and usable.
- `actionable_maven` cleanly isolates modernization lane runs.
- Unsupported/guarded noise is isolated in `coverage` instead of dominating actionable metrics.

3. Android guarded baseline semantics remain explicit and non-opaque.
- Stage 8 Android runs classify as `supported` Gradle Android with `failureKind=guarded_baseline_applied` and explicit guarded reason.

## Stage 9 Results
- Stage 9 cohort artifact: `/Users/kelvinmusodza/Downloads/Code porter/evidence/pilot/2026-03-13T00-47-38-699Z/pilot-summary.json`
- Stage 9 report snapshots:
  - `/tmp/pilot-report-stage9-all.json`
  - `/tmp/pilot-report-stage9-actionable.json`
  - `/tmp/pilot-report-stage9-coverage.json`
- Policy ID: `pilot-stage8`
- Maven pack: `java-maven-test-compat-stage8-pack`
- Gradle pack: `java-gradle-guarded-baseline-pack`

### Targeted Axum Gate (Stage 9.2)
- runId: `a77a5e8c-4ef5-4e06-9794-0a79b1449f20`
- status: `completed`
- PR opened: `https://github.com/Coreledger-tech/Axum-matching-engine/pull/23`
- evidence:
  - `/Users/kelvinmusodza/Downloads/Code porter/evidence/5727d326-888c-4599-a1b8-b45b6350f8b4/ef74aae8-d5a2-48e4-bf77-0888590fc508/a77a5e8c-4ef5-4e06-9794-0a79b1449f20/verify.json`
  - `/Users/kelvinmusodza/Downloads/Code porter/evidence/5727d326-888c-4599-a1b8-b45b6350f8b4/ef74aae8-d5a2-48e4-bf77-0888590fc508/a77a5e8c-4ef5-4e06-9794-0a79b1449f20/remediation-test-runtime.json`
  - `/Users/kelvinmusodza/Downloads/Code porter/evidence/5727d326-888c-4599-a1b8-b45b6350f8b4/ef74aae8-d5a2-48e4-bf77-0888590fc508/a77a5e8c-4ef5-4e06-9794-0a79b1449f20/artifacts/remediation-test-runtime-1.patch`
  - `/Users/kelvinmusodza/Downloads/Code porter/evidence/5727d326-888c-4599-a1b8-b45b6350f8b4/ef74aae8-d5a2-48e4-bf77-0888590fc508/a77a5e8c-4ef5-4e06-9794-0a79b1449f20/artifacts/remediation-test-runtime-2.patch`
- remediation rules fired:
  - `ensure_add_opens_java_nio`
  - `ensure_add_opens_java_lang`
- outcome: the chained Chronicle module-access fix advanced Axum from timeout-prone `needs_review` into a fully `completed` run with both deterministic runtime patches recorded.

### Full 5-Repo Cohort Rerun (Stage 9)
| repo | planRunId | applyRunId | applyStatus | applyFailureKind | prUrl |
| --- | --- | --- | --- | --- | --- |
| Java-Web-Crawler | `73c679b8-1304-4f49-90a3-c3aaea5efe83` | `8e9806b7-166f-47f7-a417-ba27315a4dc2` | `completed` |  |  |
| Axum-matching-engine | `ae629522-c4cc-4cc3-bdf7-2c134b039aa4` | `6be8d96c-a079-4d67-9c3b-c2afda7dc1a0` | `completed` |  | `https://github.com/Coreledger-tech/Axum-matching-engine/pull/24` |
| authelia-TOTP | `aa1b8be5-692d-4a70-8e70-be81c971af82` | `a46d5193-5e25-432c-8f8f-351b3a3f3d83` | `needs_review` | `unsupported_build_system` |  |
| Exception-handling-reconciliation | `eabd99dd-44aa-4a2c-b20d-ab8285df3bef` | `15f36822-a5a7-462f-928c-cee97a99b203` | `needs_review` | `unsupported_build_system` |  |
| android-ESP-32-bluetooth-arduino | `9359edef-dd4d-4d31-96da-05b6ed7183d4` | `da67a0a4-899e-4a36-b3b2-05255b802f9d` | `needs_review` | `guarded_baseline_applied` |  |

### Stage 9 Cohort-Split Metrics (`window=7d`)
1. `cohort=all`
- totalsByStatus: `completed=3`, `needs_review=4`
- topFailureKinds: `unsupported_build_system=2`, `code_test_failure=1`, `guarded_baseline_applied=1`
- prOutcomes: `opened=2`, `merged=0`, `open=2`, `mergeRate=0`
- retryRate: `1/7 = 14.29%`

2. `cohort=actionable_maven`
- totalsByStatus: `completed=3`, `needs_review=1`
- topFailureKinds: `code_test_failure=1`
- prOutcomes: `opened=2`, `merged=0`, `open=2`, `mergeRate=0`
- retryRate: `1/4 = 25%`
- `unknown` is absent from `topFailureKinds`

3. `cohort=coverage`
- totalsByStatus: `needs_review=3`
- topFailureKinds: `unsupported_build_system=2`, `guarded_baseline_applied=1`
- prOutcomes: `opened=0`, `merged=0`

### Stage 9 Delta Vs Stage 8
1. Axum moved from `needs_review` to `completed`.
- Stage 8 Axum apply run `066c6dc5-7388-48e4-a2f4-22fbc2cf8c15` ended `needs_review` with `code_test_failure`.
- Stage 9 Axum targeted gate `a77a5e8c-4ef5-4e06-9794-0a79b1449f20` completed after chained runtime remediation.
- Stage 9 cohort Axum apply run `6be8d96c-a079-4d67-9c3b-c2afda7dc1a0` also completed and opened PR `#24`.

2. Actionable Maven reporting is now stable and useful.
- Stage 8 actionable cohort top failure kinds were `code_test_failure=3` and `unknown=1`.
- Stage 9 actionable cohort top failure kinds are just `code_test_failure=1`.
- `unknown` is no longer present in the actionable cohort snapshot.

3. Completed outcomes increased without expanding unsupported noise.
- Stage 8 `cohort=all`: `completed=1`, `needs_review=7`
- Stage 9 `cohort=all`: `completed=3`, `needs_review=4`
- Coverage cohort remains explicit: `unsupported_build_system` and `guarded_baseline_applied` account for all non-actionable Stage 9 outcomes.
