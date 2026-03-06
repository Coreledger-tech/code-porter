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
  - `npm run verify:ghcr -- --tag v1.0.0-rc.2` still returns `unauthorized`
  - Conclusion: the repository can be public while `ghcr.io/coreledger-tech/code-porter` remains private or inaccessible to anonymous pull from this environment
  - Release docs now record both the preferred public-pull path and the private `docker login ghcr.io` fallback

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
| GHCR public pull | not verified | still unauthorized |
| Axum failure kind | `code_compile_failure` | `code_test_failure` |
| Axum compile status | failed | passed |
| Axum remediation applied | no | no; compile remediator not applicable once compile passed |
| Axum PR candidate | `#4` | `#9` |
| Gradle precise subtype result | not exercised live | yes |
| full cohort rerun | deferred | executed |
| completed apply runs | `0` | `1` |

### Top Remaining Blockers After Stage 3
1. GHCR package visibility is still not public in practice.
   - The scripted public pull path remains unauthorized.
2. Axum now fails in test sources rather than build tooling.
   - The blocking errors are project-level Java 17 test compatibility issues (`jdk.nashorn.internal.ir.annotations`, `Ignore`), not lane/toolchain failures.
3. Real-world Gradle subtype inference needs one more pass.
   - The Android repo is correctly held out of the JVM-only lane, but it is classified as `unknown` subtype rather than `android`.
4. The aggregate `7d` report still carries historical `unknown` rows.
   - The Stage 3 cohort artifact is clean, but `/reports/pilot?window=7d` still mixes in older runs from before the classification changes.

### Next Operator Actions
1. Fix GHCR pull verification by making `ghcr.io/coreledger-tech/code-porter` public or by using `docker login ghcr.io` with a PAT that has `read:packages`.
2. Review `Axum-matching-engine` PR `#9` as a merge candidate for compile-side modernization; treat the remaining test failures as the next deterministic/test lane target.
3. Keep Android subtype refinement out of the critical path unless the next pilot specifically needs Android support.
