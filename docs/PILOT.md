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

## 5-Repo Pilot Plan Template
Use this table as the minimum planning artifact before starting any pilot wave.

| repo | owner | bucket | base branch | freeze window | campaign id | policy | recipe pack | status | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `repo-1` | `team-a` | `small` | `main` | `Fri 18:00-23:00 UTC` | `TBD` | `default` | `java-maven-plugin-modernize` | `planned` | `stable build` |
| `repo-2` | `team-b` | `small` | `main` | `Fri 18:00-23:00 UTC` | `TBD` | `default` | `java-maven-plugin-modernize` | `planned` | `single-module` |
| `repo-3` | `team-c` | `medium` | `main` | `Sat 16:00-22:00 UTC` | `TBD` | `default` | `java-maven-plugin-modernize` | `planned` | `multi-module` |
| `repo-4` | `team-d` | `medium` | `main` | `Sat 16:00-22:00 UTC` | `TBD` | `default` | `java-maven-plugin-modernize` | `planned` | `historical flaky tests` |
| `repo-5` | `team-e` | `messy` | `main` | `Sun 14:00-20:00 UTC` | `TBD` | `default` | `java-maven-plugin-modernize` | `planned` | `legacy plugins` |

### Freeze-Window and Owner Sign-Off Checklist
1. Owner acknowledged campaign scope and rollback path.
2. Freeze window agreed in writing for apply runs.
3. Campaign paused outside allowed window.
4. Cancel criteria documented for this repo (policy misconfig, auth incident, infra degradation).
5. Post-run evidence review owner assigned.

## Pilot Automation Runbook
Use the deterministic pilot script for a full 5-repo run.

1. Prepare config from the example file:
- `cp scripts/pilot-config.example.json /tmp/pilot-config.json`
2. Update repos and owner metadata in `/tmp/pilot-config.json`.
3. Run pilot:
- `npm run pilot:run -- --config /tmp/pilot-config.json`
4. Validate output:
- console summary table
- JSON artifact under `./evidence/pilot/<timestamp>/pilot-summary.json`

### Locked Execution Rules
1. Plans are enqueued for all repos first.
2. Applies run strictly one-at-a-time in configured repo order.
3. `429` responses are retried with bounded backoff.
4. Budget events and retry counts are captured into the pilot summary.

### Pilot Config Contract
```json
{
  "apiBaseUrl": "http://localhost:3000",
  "policyId": "pilot-conservative",
  "recipePack": "java-maven-plugin-modernize",
  "targetSelector": "main",
  "window": "30d",
  "pollIntervalMs": 2000,
  "applyStartBackoffMs": 5000,
  "maxApplyStartRetries": 12,
  "repos": [
    {
      "name": "repo-1",
      "owner": "org-a",
      "repo": "service-a"
    }
  ]
}
```

### Post-Wave Retro Handoff
1. Run `GET /reports/pilot?window=30d`.
2. Attach the pilot summary JSON.
3. Fill [PILOT_RETRO_TEMPLATE.md](/Users/kelvinmusodza/Downloads/Code porter/docs/PILOT_RETRO_TEMPLATE.md).
4. Capture prioritized pack proposals and assign owners for next sprint.

## PR Keeper Loop
1. Keep only one active keeper PR per repo per pilot wave.
2. If multiple PRs exist, select the keeper with the cleanest in-scope diff and latest valid evidence.
3. Close superseded PRs with explicit references to the keeper.
4. Merge only when the keeper satisfies the RC merge checklist (diff scope, churn limits, evidence integrity, and classifier consistency).
5. Keeper scoring is deterministic in this order:
- merge checklist pass
- run status (`completed > needs_review > blocked > failed > cancelled`)
- fewer changed files
- fewer changed lines
- newer completion time
6. Keeper automation may comment on and close superseded PRs automatically when policy enables it.
7. Keeper PRs are labeled `code-porter:merge-ready` only when `merge-checklist.json` passes.
8. Stage 11 auto-merge is Maven-only, squash-only, and limited to strict-safe one-file `pom.xml` diffs.
9. If a guarded Android run makes no deterministic baseline changes, record it as a no-op outcome instead of opening a low-signal PR.

## v1.0.0 Exit Criteria
Pilot exits to v1.0.0 when all targets are met over the last 30 days:

1. Merge rate `>= 60%`
2. Blocked rate `<= 25%`
3. Time-to-green p90 `<= 7 days`
4. Retry rate `<= 20%`

If any target misses, use `/reports/pilot` output to prioritize next recipe/verifier improvements before release.
