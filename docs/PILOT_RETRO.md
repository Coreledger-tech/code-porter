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
