# Stage 12: Coverage Usefulness + Unsupported-Slice Precision

## Summary
Stage 12 improves the `coverage` cohort without adding a new execution lane. The goal is to make excluded and guarded runs operationally useful by recording precise unsupported reasons, deterministic next-lane recommendations, and a dedicated coverage artifact for pilot retros.

## Goals
- Make `coverage` explain why a repo missed the actionable lane.
- Persist deterministic next-lane recommendations for excluded repos.
- Keep current run statuses, cohorts, and top-level failure kinds stable.
- Add a pilot artifact that makes unsupported-share trends easy to compare between stages.

## Non-Goals
- No new live execution lane in Stage 12.
- No release gate changes.
- No retro update with observed Stage 12 outcomes in this implementation pass.
- No `rc.11` in this stage.

## Additive Model Changes
- Extend run summary scan metadata with:
  - `unsupportedReason`
  - `recommendedNextLane`
  - `coverageOutcome`
- Extend `/reports/pilot` with:
  - `coverageEntries`
  - `coverageSummary`
- Extend `pilot:run` output with `coverage-summary.json`.

## Unsupported Reason Taxonomy
| Condition | unsupportedReason | recommendedNextLane |
| --- | --- | --- |
| Go repo excluded | `unsupported_build_system_go` | `go_readiness_lane` |
| Node repo excluded | `unsupported_build_system_node` | `node_readiness_lane` |
| Python repo excluded | `unsupported_build_system_python` | `python_readiness_lane` |
| Gradle JVM repo missing wrapper | `unsupported_subtype_gradle_no_wrapper` | `gradle_jvm_wrapper_lane` |
| Gradle subtype unknown | `unsupported_subtype_gradle_unknown` | `manual_triage` |
| Android repo with guarded mode disabled | `unsupported_subtype_android_unguarded` | `android_guarded_baseline` |
| Supported manifest excluded by policy | `excluded_by_policy` | `enable_build_system_in_policy` |
| No supported manifest found | `no_supported_manifest` | `manifest_follow_up` |
| Fallback excluded case | `unsupported_build_system_unknown` | `manual_triage` |

## Coverage Outcomes
- `excluded`: repo is outside the current actionable lane and should carry an unsupported reason plus a next-lane recommendation.
- `guarded_applied`: guarded Android baseline made deterministic changes.
- `guarded_noop`: guarded Android baseline was already satisfied.
- `guarded_blocked`: guarded Android path was selected but did not finish as applied/no-op.

## Coverage Report Contract
`GET /reports/pilot?cohort=coverage` should return repo-level entries with:
- repo identity
- selected build system
- disposition and Gradle subtype metadata
- coverage outcome
- unsupported reason
- recommended next lane
- current failure kind / blocked reason / PR URL

`cohort=all` should also expose the coverage entries for the non-actionable slice in the same window so retros can compare actionable and coverage views side by side.

## Pilot Artifact Additions
Each `pilot:run` output directory should now contain:
- `pilot-summary.json`
- `coverage-summary.json`

`coverage-summary.json` should include:
- the raw `coverage` cohort API payload
- repo-level coverage entries
- totals for excluded / guarded applied / guarded noop / guarded blocked
- counts by unsupported reason
- counts by recommended next lane

## Acceptance
- Coverage entries explain why excluded repos missed the lane.
- Excluded repos carry deterministic next-lane recommendations.
- Guarded Android runs are reported distinctly from unsupported repos.
- Existing cohort semantics and top-level run statuses remain backward-compatible.
