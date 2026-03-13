import { Router } from "express";
import { deriveCoverageClassification } from "@code-porter/core/src/coverage-classification.js";
import type {
  BuildSystem,
  BuildSystemDisposition,
  CoverageEntry,
  CoverageNextLane,
  CoverageOutcome,
  GradleProjectType,
  RunStatus,
  UnsupportedCoverageReason
} from "@code-porter/core/src/models.js";
import { query } from "../db/client.js";

interface StatusCountRow {
  status: string;
  count: number;
}

interface FailureCountRow {
  failure_kind: string;
  count: number;
}

interface PrOutcomesRow {
  opened: number;
  merged: number;
  closed_unmerged: number;
  open: number;
}

interface TimeToGreenRow {
  sample_size: number;
  p50_hours: number | null;
  p90_hours: number | null;
}

interface RetryRateRow {
  total_runs: number;
  retried_runs: number;
}

interface OffenderRow {
  project_id: string;
  project_name: string;
  total_runs: number;
  blocked_runs: number;
  blocked_rate: number;
}

interface TopFailureByProjectRow {
  failure_kind: string;
}

interface CohortCountRow {
  total_apply_runs: number;
  cohort_apply_runs: number;
}

interface KeeperOutcomeRow {
  keeper_chosen: number;
  keeper_merged: number;
  merge_ready: number;
  superseded_closed_count: number;
}

interface CoverageEntryRow {
  project_id: string;
  project_name: string;
  repo: string | null;
  run_id: string;
  status: RunStatus;
  selected_build_system: BuildSystem | null;
  build_system_disposition: BuildSystemDisposition | null;
  gradle_project_type: GradleProjectType | null;
  gradle_wrapper_path: string | null;
  coverage_outcome: CoverageOutcome | null;
  unsupported_reason: UnsupportedCoverageReason | null;
  recommended_next_lane: CoverageNextLane | null;
  failure_kind: string | null;
  blocked_reason: string | null;
  pr_url: string | null;
}

type PilotCohort = "all" | "actionable_maven" | "coverage";

function parseWindow(
  raw: string | string[] | undefined
): { window: "7d" | "30d"; days: number } | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || value === "30d") {
    return { window: "30d", days: 30 };
  }

  if (value === "7d") {
    return { window: "7d", days: 7 };
  }

  return null;
}

function parseCohort(raw: string | string[] | undefined): PilotCohort | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || value === "all") {
    return "all";
  }
  if (value === "actionable_maven" || value === "coverage") {
    return value;
  }
  return null;
}

function safeRate(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }

  return numerator / denominator;
}

function buildCoverageSummary(entries: CoverageEntry[]): {
  byOutcome: Record<string, number>;
  byReason: Record<string, number>;
  byRecommendation: Record<string, number>;
} {
  const byOutcome: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  const byRecommendation: Record<string, number> = {};

  for (const entry of entries) {
    if (entry.coverageOutcome) {
      byOutcome[entry.coverageOutcome] = (byOutcome[entry.coverageOutcome] ?? 0) + 1;
    }
    if (entry.unsupportedReason) {
      byReason[entry.unsupportedReason] = (byReason[entry.unsupportedReason] ?? 0) + 1;
    }
    if (entry.recommendedNextLane) {
      byRecommendation[entry.recommendedNextLane] =
        (byRecommendation[entry.recommendedNextLane] ?? 0) + 1;
    }
  }

  return {
    byOutcome,
    byReason,
    byRecommendation
  };
}

export function reportsRouter(): Router {
  const router = Router();

  router.get("/reports/pilot", async (req, res, next) => {
    try {
      const parsed = parseWindow(req.query.window as string | string[] | undefined);
      if (!parsed) {
        return res.status(400).json({
          error: "invalid window, expected one of: 7d, 30d"
        });
      }
      const cohort = parseCohort(req.query.cohort as string | string[] | undefined);
      if (!cohort) {
        return res.status(400).json({
          error: "invalid cohort, expected one of: all, actionable_maven, coverage"
        });
      }

      const { window, days } = parsed;
      const actionableMavenCondition = `coalesce(r.summary#>>'{scan,selectedBuildSystem}', 'unknown') = 'maven'
         and coalesce(r.summary#>>'{scan,buildSystemDisposition}', 'supported') = 'supported'`;
      const normalizedFailureKindExpr = `coalesce(
        nullif(r.summary->>'failureKind', ''),
        case when r.status = 'completed' then null else 'manual_review_required' end,
        'unknown'
      )`;
      const coverageCondition = `not (${actionableMavenCondition})`;
      const cohortCondition =
        cohort === "all"
          ? "true"
          : cohort === "actionable_maven"
            ? actionableMavenCondition
            : coverageCondition;
      const applyWindowFilter = `r.mode = 'apply'
         and r.started_at >= now() - make_interval(days => $1)
         and (${cohortCondition})`;
      const coverageWindowFilter = `r.mode = 'apply'
         and r.started_at >= now() - make_interval(days => $1)
         and (${coverageCondition})`;

      const [
        statuses,
        topFailures,
        blockedByFailure,
        prOutcomes,
        timeToGreen,
        retryRate,
        offenders,
        cohortCounts,
        keeperOutcomes,
        coverageEntryRows
      ] = await Promise.all([
        query<StatusCountRow>(
          `select status, count(*)::int as count
           from runs r
           where ${applyWindowFilter}
           group by status`,
          [days]
        ),
        query<FailureCountRow>(
          `select ${normalizedFailureKindExpr} as failure_kind,
                  count(*)::int as count
           from runs r
           where ${applyWindowFilter}
             and r.status <> 'completed'
           group by ${normalizedFailureKindExpr}
           order by count(*) desc
           limit 10`,
          [days]
        ),
        query<FailureCountRow>(
          `select ${normalizedFailureKindExpr} as failure_kind,
                  count(*)::int as count
           from runs r
           where ${applyWindowFilter}
             and r.status = 'blocked'
           group by ${normalizedFailureKindExpr}
           order by count(*) desc
           limit 10`,
          [days]
        ),
        query<PrOutcomesRow>(
          `select
             (count(*) filter (where r.pr_url is not null))::int as opened,
             (count(*) filter (where r.pr_state = 'merged'))::int as merged,
             (count(*) filter (where r.pr_state = 'closed'))::int as closed_unmerged,
             (count(*) filter (where r.pr_state = 'open'))::int as open
           from runs r
           where ${applyWindowFilter}`,
          [days]
        ),
        query<TimeToGreenRow>(
          `select
             count(*)::int as sample_size,
             percentile_cont(0.5) within group (
               order by extract(epoch from (merged_at - pr_opened_at)) / 3600.0
             ) as p50_hours,
             percentile_cont(0.9) within group (
               order by extract(epoch from (merged_at - pr_opened_at)) / 3600.0
             ) as p90_hours
           from runs r
           where ${applyWindowFilter}
             and r.pr_opened_at is not null
             and r.merged_at is not null`,
          [days]
        ),
        query<RetryRateRow>(
          `select
             count(*)::int as total_runs,
             (count(*) filter (where coalesce(j.attempt_count, 0) > 1))::int as retried_runs
           from runs r
           left join run_jobs j on j.run_id = r.id
           where ${applyWindowFilter}`,
          [days]
        ),
        query<OffenderRow>(
          `select
             p.id as project_id,
             p.name as project_name,
             count(*)::int as total_runs,
             (count(*) filter (where r.status = 'blocked'))::int as blocked_runs,
             coalesce(
               (count(*) filter (where r.status = 'blocked'))::float / nullif(count(*), 0),
               0
             )::float as blocked_rate
           from runs r
           join campaigns c on c.id = r.campaign_id
           join projects p on p.id = c.project_id
           where ${applyWindowFilter}
           group by p.id, p.name
           having count(*) >= 5
           order by blocked_rate desc, total_runs desc
           limit 10`,
          [days]
        ),
        query<CohortCountRow>(
          `select
             (count(*) filter (
               where r.mode = 'apply'
                 and r.started_at >= now() - make_interval(days => $1)
             ))::int as total_apply_runs,
             (count(*) filter (
               where ${applyWindowFilter}
             ))::int as cohort_apply_runs
           from runs r`,
          [days]
        ),
        query<KeeperOutcomeRow>(
          `select
             (count(*) filter (
               where coalesce(r.summary->>'keeperChosen', 'false') = 'true'
             ))::int as keeper_chosen,
             (count(*) filter (
               where coalesce(r.summary->>'keeperMerged', 'false') = 'true'
             ))::int as keeper_merged,
             (count(*) filter (
               where coalesce(r.summary->>'mergeReady', 'false') = 'true'
             ))::int as merge_ready,
             coalesce(sum(
               case
                 when coalesce(r.summary->>'supersededClosedCount', '') ~ '^[0-9]+$'
                 then (r.summary->>'supersededClosedCount')::int
                 else 0
               end
             ), 0)::int as superseded_closed_count
           from runs r
           where ${applyWindowFilter}`,
          [days]
        ),
        cohort === "actionable_maven"
          ? Promise.resolve({ rows: [] as CoverageEntryRow[] })
          : query<CoverageEntryRow>(
            `select distinct on (p.id)
               p.id as project_id,
               p.name as project_name,
               p.repo as repo,
               r.id as run_id,
               r.status,
               nullif(r.summary#>>'{scan,selectedBuildSystem}', '') as selected_build_system,
               nullif(r.summary#>>'{scan,buildSystemDisposition}', '') as build_system_disposition,
               nullif(r.summary#>>'{scan,gradleProjectType}', '') as gradle_project_type,
               nullif(r.summary#>>'{scan,gradleWrapperPath}', '') as gradle_wrapper_path,
               nullif(r.summary#>>'{scan,coverageOutcome}', '') as coverage_outcome,
               nullif(r.summary#>>'{scan,unsupportedReason}', '') as unsupported_reason,
               nullif(r.summary#>>'{scan,recommendedNextLane}', '') as recommended_next_lane,
               nullif(r.summary->>'failureKind', '') as failure_kind,
               nullif(r.summary->>'blockedReason', '') as blocked_reason,
               r.pr_url
             from runs r
             join campaigns c on c.id = r.campaign_id
             join projects p on p.id = c.project_id
             where ${coverageWindowFilter}
             order by p.id, r.started_at desc`,
            [days]
          )
      ]);

      const totalsByStatus = Object.fromEntries(
        statuses.rows.map((row) => [row.status, Number(row.count)])
      );

      const pr = prOutcomes.rows[0] ?? {
        opened: 0,
        merged: 0,
        closed_unmerged: 0,
        open: 0
      };

      const retry = retryRate.rows[0] ?? {
        total_runs: 0,
        retried_runs: 0
      };

      const offendersWithTopFailure = await Promise.all(
        offenders.rows.map(async (row) => {
          const topFailure = await query<TopFailureByProjectRow>(
            `select ${normalizedFailureKindExpr} as failure_kind
             from runs r
             join campaigns c on c.id = r.campaign_id
             where c.project_id = $1
               and r.mode = 'apply'
               and r.started_at >= now() - make_interval(days => $2)
               and (${cohortCondition})
               and r.status = 'blocked'
             group by ${normalizedFailureKindExpr}
             order by count(*) desc
             limit 1`,
            [row.project_id, days]
          );

          return {
            projectId: row.project_id,
            projectName: row.project_name,
            totalRuns: Number(row.total_runs),
            blockedRuns: Number(row.blocked_runs),
            blockedRate: Number(row.blocked_rate),
          topFailureKind: topFailure.rows[0]?.failure_kind ?? "unknown"
          };
        })
      );

      const totalApplyRuns = Number(cohortCounts.rows[0]?.total_apply_runs ?? 0);
      const cohortApplyRuns = Number(cohortCounts.rows[0]?.cohort_apply_runs ?? 0);
      const keeper = keeperOutcomes.rows[0] ?? {
        keeper_chosen: 0,
        keeper_merged: 0,
        merge_ready: 0,
        superseded_closed_count: 0
      };
      const coverageEntries: CoverageEntry[] = coverageEntryRows.rows
        .map((row) => {
          const derived = deriveCoverageClassification({
            buildSystem: row.selected_build_system ?? "unknown",
            buildSystemDisposition: row.build_system_disposition,
            gradleProjectType: row.gradle_project_type,
            gradleWrapperPath: row.gradle_wrapper_path,
            failureKind: row.failure_kind,
            status: row.status
          });

          return {
            projectId: row.project_id,
            projectName: row.project_name,
            repo: row.repo,
            runId: row.run_id,
            selectedBuildSystem: row.selected_build_system ?? "unknown",
            buildSystemDisposition: row.build_system_disposition ?? "supported",
            gradleProjectType: row.gradle_project_type,
            coverageOutcome: row.coverage_outcome ?? derived.coverageOutcome,
            unsupportedReason: row.unsupported_reason ?? derived.unsupportedReason,
            recommendedNextLane:
              row.recommended_next_lane ?? derived.recommendedNextLane,
            failureKind: row.failure_kind,
            blockedReason: row.blocked_reason,
            prUrl: row.pr_url
          };
        })
        .sort((left, right) => left.projectName.localeCompare(right.projectName));
      const coverageSummary = buildCoverageSummary(coverageEntries);

      return res.json({
        window,
        cohort,
        cohortCounts: {
          totalApplyRuns,
          cohortApplyRuns,
          excludedApplyRuns: Math.max(0, totalApplyRuns - cohortApplyRuns)
        },
        generatedAt: new Date().toISOString(),
        totalsByStatus,
        topFailureKinds: topFailures.rows.map((row) => ({
          failureKind: row.failure_kind,
          count: Number(row.count)
        })),
        blockedByFailureKind: blockedByFailure.rows.map((row) => ({
          failureKind: row.failure_kind,
          count: Number(row.count)
        })),
        prOutcomes: {
          opened: Number(pr.opened),
          merged: Number(pr.merged),
          closedUnmerged: Number(pr.closed_unmerged),
          open: Number(pr.open),
          mergeRate: safeRate(Number(pr.merged), Number(pr.opened))
        },
        timeToGreen: {
          sampleSize: Number(timeToGreen.rows[0]?.sample_size ?? 0),
          p50Hours:
            timeToGreen.rows[0]?.p50_hours === null ||
            timeToGreen.rows[0]?.p50_hours === undefined
              ? null
              : Number(timeToGreen.rows[0].p50_hours),
          p90Hours:
            timeToGreen.rows[0]?.p90_hours === null ||
            timeToGreen.rows[0]?.p90_hours === undefined
              ? null
              : Number(timeToGreen.rows[0].p90_hours)
        },
        retryRate: {
          retriedRuns: Number(retry.retried_runs),
          totalRuns: Number(retry.total_runs),
          rate: safeRate(Number(retry.retried_runs), Number(retry.total_runs))
        },
        keeperOutcomes: {
          keeperChosen: Number(keeper.keeper_chosen),
          keeperMerged: Number(keeper.keeper_merged),
          mergeReady: Number(keeper.merge_ready),
          supersededClosedCount: Number(keeper.superseded_closed_count)
        },
        coverageEntries,
        coverageSummary,
        worstOffendersByProject: offendersWithTopFailure
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
