# Code Porter V1 Pilot Guide

## Objective
Run a structured V1 pilot that produces measurable modernization outcomes and clear recipe-priority signals before v1.0.0.

## Pilot Cohort Selection
Use three repo buckets to reduce bias and validate behavior across complexity levels.

### Small
- `<20k` LOC
- single-module or simple module graph
- stable CI/build in normal development
- low dependency/plugin churn

### Medium
- `20k-150k` LOC or multi-module build
- moderate plugin/dependency drift
- mixed test reliability

### Messy
- legacy build/plugin topology
- frequent artifact/plugin resolution issues
- flaky tests or unstable build health
- high historical blocked/needs-review risk

## Success Metrics
Track all metrics over rolling windows (`7d`, `30d`) with primary gate on `30d`.

1. PR merge rate
- `merged / opened`

2. Time-to-green
- Definition: `PR Open -> PR Merge`
- Report p50 and p90 in hours

3. Blocked rate by failure kind
- blocked runs / total runs
- top blocked failure kinds from run summaries

4. Retry rate
- runs with `attempt_count > 1` / total runs

## Operating Procedure

### Safety Controls
1. Respect configured run throttles (`maxInflightRunsPerProject`, `maxInflightRunsGlobal`).
2. Keep campaign pause/resume available for freeze windows and incident response.
3. Keep cleanup defaults:
- workspace: `delete_on_success_keep_on_failure`
- TTL cleanup jobs enabled

### Freeze Windows
1. Pause campaign enqueue during release freezes or infra incidents.
2. Resume only after verifier/toolchain health is restored.
3. Do not start new pilot waves during freeze windows.

### Cancellation Rules
1. Cancel queued runs if campaign scope changed.
2. Cancel running runs only for:
- policy misconfiguration
- credential/permission incident
- severe infra degradation
3. Prefer pause for broad control, cancel for targeted interruption.

## v1.0.0 Exit Criteria
Pilot exits to v1.0.0 when all targets are met over the last 30 days:

1. Merge rate `>= 60%`
2. Blocked rate `<= 25%`
3. Time-to-green p90 `<= 7 days`
4. Retry rate `<= 20%`

If any target misses, use `/reports/pilot` output to prioritize next recipe/verifier improvements before release.
