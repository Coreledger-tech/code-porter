import { randomUUID } from "node:crypto";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Router } from "express";
import { query } from "../db/client.js";
import { parseSummaryWindow } from "./summary-utils.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function projectsRouter(): Router {
  const router = Router();

  router.get("/projects/:id/summary", async (req, res, next) => {
    try {
      const projectId = req.params.id;
      const { days, recentLimit } = parseSummaryWindow({
        days: req.query.days as string | string[] | undefined,
        recentLimit: req.query.recentLimit as string | string[] | undefined
      });

      const projectResult = await query<{
        id: string;
        name: string;
      }>(
        `select id, name
         from projects
         where id = $1`,
        [projectId]
      );
      const project = projectResult.rows[0];
      if (!project) {
        return res.status(404).json({ error: "project not found" });
      }

      const statuses = await query<{ status: string; count: number }>(
        `select r.status, count(*)::int as count
         from runs r
         join campaigns c on c.id = r.campaign_id
         where c.project_id = $1
           and r.started_at >= now() - make_interval(days => $2)
         group by r.status`,
        [projectId, days]
      );

      const failures = await query<{ failure_kind: string | null; count: number }>(
        `select coalesce(r.summary->>'failureKind', 'unknown') as failure_kind,
                count(*)::int as count
         from runs r
         join campaigns c on c.id = r.campaign_id
         where c.project_id = $1
           and r.started_at >= now() - make_interval(days => $2)
         group by coalesce(r.summary->>'failureKind', 'unknown')`,
        [projectId, days]
      );

      const durations = await query<{ p50_sec: number | null; p95_sec: number | null }>(
        `select
           percentile_cont(0.5) within group (
             order by extract(epoch from (r.finished_at - r.started_at))
           ) as p50_sec,
           percentile_cont(0.95) within group (
             order by extract(epoch from (r.finished_at - r.started_at))
           ) as p95_sec
         from runs r
         join campaigns c on c.id = r.campaign_id
         where c.project_id = $1
           and r.started_at >= now() - make_interval(days => $2)
           and r.finished_at is not null`,
        [projectId, days]
      );

      const retryCancel = await query<{ retry_count: number; cancelled_count: number }>(
        `select
           (count(*) filter (where coalesce(j.attempt_count, 0) > 1))::int as retry_count,
           (count(*) filter (where r.status = 'cancelled'))::int as cancelled_count
         from runs r
         join campaigns c on c.id = r.campaign_id
         left join run_jobs j on j.run_id = r.id
         where c.project_id = $1
           and r.started_at >= now() - make_interval(days => $2)`,
        [projectId, days]
      );

      const recent = await query<{
        run_id: string;
        campaign_id: string;
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
      }>(
        `select
           r.id as run_id,
           r.campaign_id,
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
         join campaigns c on c.id = r.campaign_id
         left join run_jobs j on j.run_id = r.id
         where c.project_id = $1
           and r.started_at >= now() - make_interval(days => $2)
         order by r.started_at desc
         limit $3`,
        [projectId, days, recentLimit]
      );

      const recentRuns = recent.rows.map((row) => ({
        mergeState: row.pr_state ?? "unknown",
        runId: row.run_id,
        campaignId: row.campaign_id,
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
        projectId: project.id,
        name: project.name,
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

  router.post("/projects", async (req, res) => {
    const body = req.body as { name?: string; localPath?: string };

    if (!body.name || !body.localPath) {
      return res.status(400).json({ error: "name and localPath are required" });
    }

    if (!isAbsolute(body.localPath)) {
      return res.status(400).json({ error: "localPath must be an absolute path" });
    }

    if (!(await pathExists(body.localPath))) {
      return res.status(400).json({ error: "localPath does not exist" });
    }

    const fileStat = await stat(body.localPath);
    if (!fileStat.isDirectory()) {
      return res.status(400).json({ error: "localPath must be a directory" });
    }

    const id = randomUUID();

    await query(
      `insert into projects (id, name, type, local_path, owner, repo, clone_url, default_branch)
       values ($1, $2, 'local', $3, null, null, null, null)`,
      [id, body.name, body.localPath]
    );

    return res.status(201).json({
      id,
      name: body.name,
      type: "local",
      localPath: body.localPath,
      createdAt: new Date().toISOString()
    });
  });

  router.post("/projects/github", async (req, res) => {
    const body = req.body as {
      name?: string;
      owner?: string;
      repo?: string;
      cloneUrl?: string;
      defaultBranch?: string;
    };

    if (!body.name || !body.owner || !body.repo) {
      return res.status(400).json({
        error: "name, owner, and repo are required"
      });
    }

    const id = randomUUID();

    await query(
      `insert into projects (id, name, type, local_path, owner, repo, clone_url, default_branch)
       values ($1, $2, 'github', null, $3, $4, $5, $6)`,
      [
        id,
        body.name,
        body.owner,
        body.repo,
        body.cloneUrl ?? null,
        body.defaultBranch ?? null
      ]
    );

    return res.status(201).json({
      id,
      name: body.name,
      type: "github",
      owner: body.owner,
      repo: body.repo,
      cloneUrl: body.cloneUrl,
      defaultBranch: body.defaultBranch,
      createdAt: new Date().toISOString()
    });
  });

  return router;
}
