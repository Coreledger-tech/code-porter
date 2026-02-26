import { Router } from "express";
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

function safeRate(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }

  return numerator / denominator;
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

      const { window, days } = parsed;

      const [
        statuses,
        topFailures,
        blockedByFailure,
        prOutcomes,
        timeToGreen,
        retryRate,
        offenders
      ] = await Promise.all([
        query<StatusCountRow>(
          `select status, count(*)::int as count
           from runs
           where started_at >= now() - make_interval(days => $1)
           group by status`,
          [days]
        ),
        query<FailureCountRow>(
          `select coalesce(summary->>'failureKind', 'unknown') as failure_kind,
                  count(*)::int as count
           from runs
           where started_at >= now() - make_interval(days => $1)
           group by coalesce(summary->>'failureKind', 'unknown')
           order by count(*) desc
           limit 10`,
          [days]
        ),
        query<FailureCountRow>(
          `select coalesce(summary->>'failureKind', 'unknown') as failure_kind,
                  count(*)::int as count
           from runs
           where started_at >= now() - make_interval(days => $1)
             and status = 'blocked'
           group by coalesce(summary->>'failureKind', 'unknown')
           order by count(*) desc
           limit 10`,
          [days]
        ),
        query<PrOutcomesRow>(
          `select
             (count(*) filter (where pr_url is not null))::int as opened,
             (count(*) filter (where pr_state = 'merged'))::int as merged,
             (count(*) filter (where pr_state = 'closed'))::int as closed_unmerged,
             (count(*) filter (where pr_state = 'open'))::int as open
           from runs
           where started_at >= now() - make_interval(days => $1)`,
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
           from runs
           where started_at >= now() - make_interval(days => $1)
             and pr_opened_at is not null
             and merged_at is not null`,
          [days]
        ),
        query<RetryRateRow>(
          `select
             count(*)::int as total_runs,
             (count(*) filter (where coalesce(j.attempt_count, 0) > 1))::int as retried_runs
           from runs r
           left join run_jobs j on j.run_id = r.id
           where r.started_at >= now() - make_interval(days => $1)`,
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
           where r.started_at >= now() - make_interval(days => $1)
           group by p.id, p.name
           having count(*) >= 5
           order by blocked_rate desc, total_runs desc
           limit 10`,
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
            `select coalesce(r.summary->>'failureKind', 'unknown') as failure_kind
             from runs r
             join campaigns c on c.id = r.campaign_id
             where c.project_id = $1
               and r.started_at >= now() - make_interval(days => $2)
               and r.status = 'blocked'
             group by coalesce(r.summary->>'failureKind', 'unknown')
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

      return res.json({
        window,
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
        worstOffendersByProject: offendersWithTopFailure
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
