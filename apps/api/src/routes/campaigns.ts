import { randomUUID } from "node:crypto";
import { Router } from "express";
import { query } from "../db/client.js";
import { parseSummaryWindow } from "./summary-utils.js";
import {
  CampaignPausedError,
  enqueueCampaignRun,
  pauseCampaign,
  resumeCampaign,
  RunThrottleError
} from "../workflow-service.js";

interface IdRow {
  id: string;
}

interface CampaignSummaryRow {
  id: string;
  project_id: string;
  policy_id: string;
  recipe_pack: string;
  target_selector: string | null;
  lifecycle_status: "active" | "paused";
}

interface SummaryStatusRow {
  status: string;
  count: number;
}

interface SummaryFailureRow {
  failure_kind: string | null;
  count: number;
}

interface DurationRow {
  p50_sec: number | null;
  p95_sec: number | null;
}

interface RetryCancelRow {
  retry_count: number;
  cancelled_count: number;
}

interface RecentRunRow {
  run_id: string;
  status: string;
  queue_status: string | null;
  started_at: string;
  finished_at: string | null;
  duration_sec: number | null;
  pr_url: string | null;
  pr_number: number | null;
  pr_state: "open" | "merged" | "closed" | null;
  pr_opened_at: string | null;
  merged_at: string | null;
  closed_at: string | null;
}

export function campaignsRouter(): Router {
  const router = Router();

  router.post("/campaigns", async (req, res) => {
    const body = req.body as {
      projectId?: string;
      policyId?: string;
      recipePack?: string;
      targetSelector?: string;
    };

    if (!body.projectId || !body.policyId || !body.recipePack) {
      return res.status(400).json({
        error: "projectId, policyId, and recipePack are required"
      });
    }

    const projectCheck = await query<IdRow>(
      `select id from projects where id = $1`,
      [body.projectId]
    );
    if (projectCheck.rows.length === 0) {
      return res.status(404).json({ error: "project not found" });
    }

    const policyCheck = await query<IdRow>(
      `select id from policies where id = $1`,
      [body.policyId]
    );
    if (policyCheck.rows.length === 0) {
      return res.status(404).json({ error: "policy not found" });
    }

    const id = randomUUID();
    await query(
      `insert into campaigns (id, project_id, policy_id, recipe_pack, target_selector)
       values ($1, $2, $3, $4, $5)`,
      [id, body.projectId, body.policyId, body.recipePack, body.targetSelector ?? null]
    );

    return res.status(201).json({
      id,
      projectId: body.projectId,
      policyId: body.policyId,
      recipePack: body.recipePack,
      targetSelector: body.targetSelector,
      createdAt: new Date().toISOString()
    });
  });

  router.post("/campaigns/:id/plan", async (req, res, next) => {
    const campaignId = req.params.id;
    try {
      const result = await enqueueCampaignRun(campaignId, "plan");
      return res.status(202).json(result);
    } catch (error) {
      if (error instanceof RunThrottleError) {
        return res.status(429).json({
          error: "run start throttled by policy",
          limitType: error.limitType,
          currentInflight: error.currentInflight,
          limit: error.limit,
          retryHint: error.retryHint
        });
      }
      if (error instanceof CampaignPausedError) {
        return res.status(409).json({
          error: "campaign is paused",
          campaignId: error.campaignId,
          lifecycleStatus: "paused"
        });
      }
      return next(error);
    }
  });

  router.post("/campaigns/:id/apply", async (req, res, next) => {
    const campaignId = req.params.id;
    try {
      const result = await enqueueCampaignRun(campaignId, "apply");
      return res.status(202).json(result);
    } catch (error) {
      if (error instanceof RunThrottleError) {
        return res.status(429).json({
          error: "run start throttled by policy",
          limitType: error.limitType,
          currentInflight: error.currentInflight,
          limit: error.limit,
          retryHint: error.retryHint
        });
      }
      if (error instanceof CampaignPausedError) {
        return res.status(409).json({
          error: "campaign is paused",
          campaignId: error.campaignId,
          lifecycleStatus: "paused"
        });
      }
      return next(error);
    }
  });

  router.post("/campaigns/:id/pause", async (req, res, next) => {
    try {
      const result = await pauseCampaign(req.params.id);
      return res.json(result);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return res.status(404).json({ error: "campaign not found" });
      }
      return next(error);
    }
  });

  router.post("/campaigns/:id/resume", async (req, res, next) => {
    try {
      const result = await resumeCampaign(req.params.id);
      return res.json(result);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return res.status(404).json({ error: "campaign not found" });
      }
      return next(error);
    }
  });

  router.get("/campaigns/:id/summary", async (req, res, next) => {
    try {
      const campaignId = req.params.id;
      const { days, recentLimit } = parseSummaryWindow({
        days: req.query.days as string | string[] | undefined,
        recentLimit: req.query.recentLimit as string | string[] | undefined
      });

      const campaignResult = await query<CampaignSummaryRow>(
        `select id, project_id, policy_id, recipe_pack, target_selector, lifecycle_status
         from campaigns
         where id = $1`,
        [campaignId]
      );
      const campaign = campaignResult.rows[0];
      if (!campaign) {
        return res.status(404).json({ error: "campaign not found" });
      }

      const statuses = await query<SummaryStatusRow>(
        `select status, count(*)::int as count
         from runs
         where campaign_id = $1
           and started_at >= now() - make_interval(days => $2)
         group by status`,
        [campaignId, days]
      );

      const failures = await query<SummaryFailureRow>(
        `select coalesce(summary->>'failureKind', 'unknown') as failure_kind,
                count(*)::int as count
         from runs
         where campaign_id = $1
           and started_at >= now() - make_interval(days => $2)
         group by coalesce(summary->>'failureKind', 'unknown')`,
        [campaignId, days]
      );

      const durations = await query<DurationRow>(
        `select
           percentile_cont(0.5) within group (
             order by extract(epoch from (finished_at - started_at))
           ) as p50_sec,
           percentile_cont(0.95) within group (
             order by extract(epoch from (finished_at - started_at))
           ) as p95_sec
         from runs
         where campaign_id = $1
           and started_at >= now() - make_interval(days => $2)
           and finished_at is not null`,
        [campaignId, days]
      );

      const retryCancel = await query<RetryCancelRow>(
        `select
           (count(*) filter (where coalesce(j.attempt_count, 0) > 1))::int as retry_count,
           (count(*) filter (where r.status = 'cancelled'))::int as cancelled_count
         from runs r
         left join run_jobs j on j.run_id = r.id
         where r.campaign_id = $1
           and r.started_at >= now() - make_interval(days => $2)`,
        [campaignId, days]
      );

      const recent = await query<RecentRunRow>(
        `select
           r.id as run_id,
           r.status,
           j.status as queue_status,
           r.started_at::text,
           r.finished_at::text,
           case
             when r.finished_at is null then null
             else extract(epoch from (r.finished_at - r.started_at))
           end as duration_sec,
           r.pr_url,
           r.pr_number,
           r.pr_state,
           r.pr_opened_at::text,
           r.merged_at::text,
           r.closed_at::text
         from runs r
         left join run_jobs j on j.run_id = r.id
         where r.campaign_id = $1
           and r.started_at >= now() - make_interval(days => $2)
         order by r.started_at desc
         limit $3`,
        [campaignId, days, recentLimit]
      );

      const recentRuns = recent.rows.map((row) => ({
        mergeState: row.pr_state ?? "unknown",
        runId: row.run_id,
        status: row.status,
        queueStatus: row.queue_status ?? "unknown",
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        durationSec: row.duration_sec === null ? null : Number(row.duration_sec),
        prUrl: row.pr_url,
        prNumber: row.pr_number,
        prState: row.pr_state,
        prOpenedAt: row.pr_opened_at,
        mergedAt: row.merged_at,
        closedAt: row.closed_at
      }));

      return res.json({
        campaignId: campaign.id,
        projectId: campaign.project_id,
        policyId: campaign.policy_id,
        recipePack: campaign.recipe_pack,
        targetSelector: campaign.target_selector,
        lifecycleStatus: campaign.lifecycle_status,
        windowDays: days,
        recentLimit,
        totalsByStatus: Object.fromEntries(
          statuses.rows.map((row) => [row.status, Number(row.count)])
        ),
        failureKinds: Object.fromEntries(
          failures.rows.map((row) => [row.failure_kind ?? "unknown", Number(row.count)])
        ),
        retryCount: Number(retryCancel.rows[0]?.retry_count ?? 0),
        cancelledCount: Number(retryCancel.rows[0]?.cancelled_count ?? 0),
        durations: {
          p50Sec:
            durations.rows[0]?.p50_sec === null || durations.rows[0]?.p50_sec === undefined
              ? null
              : Number(durations.rows[0].p50_sec),
          p95Sec:
            durations.rows[0]?.p95_sec === null || durations.rows[0]?.p95_sec === undefined
              ? null
              : Number(durations.rows[0].p95_sec)
        },
        recentRuns
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
