import type { RunMode } from "@code-porter/core/src/models.js";
import { dbPool, query } from "./db/client.js";

export interface ClaimedRunJob {
  runId: string;
  campaignId: string;
  mode: RunMode;
  attemptCount: number;
  maxAttempts: number;
  reclaimed: boolean;
}

interface ClaimedRunJobRow {
  run_id: string;
  campaign_id: string;
  mode: RunMode;
  attempt_count: number;
  max_attempts: number;
  reclaimed: boolean;
}

interface AttemptsRow {
  attempt_count: number;
  max_attempts: number;
}

interface CountRow {
  count: number;
}

export async function claimNextRunJob(input: {
  workerId: string;
  leaseSeconds: number;
}): Promise<ClaimedRunJob | null> {
  const client = await dbPool.connect();

  try {
    await client.query("begin");

    const result = await client.query<ClaimedRunJobRow>(
      `with candidate as (
         select
           j.run_id,
           (j.status = 'running' and j.lease_expires_at is not null and j.lease_expires_at <= now()) as reclaimed
         from run_jobs j
         join campaigns c on c.id = j.campaign_id
         join runs r on r.id = j.run_id
         where c.lifecycle_status = 'active'
           and r.status in ('queued', 'running', 'cancelling')
           and (
             (
               j.status = 'queued'
               and j.next_attempt_at <= now()
               and (j.lease_expires_at is null or j.lease_expires_at <= now())
             )
             or
             (j.status = 'running' and j.lease_expires_at is not null and j.lease_expires_at <= now())
           )
         order by j.created_at asc
         for update skip locked
         limit 1
       )
       update run_jobs j
       set status = 'running',
           lease_owner = $1,
           leased_at = now(),
           lease_expires_at = now() + make_interval(secs => $2),
           attempt_count = j.attempt_count + 1,
           attempts = j.attempt_count + 1,
           next_attempt_at = now(),
           available_at = now(),
           locked_by = $1,
           locked_at = now(),
           updated_at = now()
       from candidate
       where j.run_id = candidate.run_id
       returning
         j.run_id,
         j.campaign_id,
         j.mode,
         j.attempt_count,
         j.max_attempts,
         candidate.reclaimed`,
      [input.workerId, input.leaseSeconds]
    );

    await client.query("commit");

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      runId: row.run_id,
      campaignId: row.campaign_id,
      mode: row.mode,
      attemptCount: Number(row.attempt_count),
      maxAttempts: Number(row.max_attempts),
      reclaimed: Boolean(row.reclaimed)
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeRunJob(input: {
  runId: string;
  status: "completed" | "failed" | "cancelled";
  lastError?: string | null;
  workerId?: string;
}): Promise<boolean> {
  const result = await query(
    `update run_jobs
     set status = $2,
         lease_owner = null,
         leased_at = null,
         lease_expires_at = null,
         locked_by = null,
         locked_at = null,
         last_error = $3,
         updated_at = now()
     where run_id = $1
       and ($4::text is null or lease_owner = $4)`,
    [input.runId, input.status, input.lastError ?? null, input.workerId ?? null]
  );

  return result.rowCount > 0;
}

export async function requeueRunJob(input: {
  runId: string;
  delaySeconds: number;
  lastError: string;
  workerId?: string;
}): Promise<boolean> {
  const result = await query(
    `update run_jobs
     set status = 'queued',
         lease_owner = null,
         leased_at = null,
         lease_expires_at = null,
         locked_by = null,
         locked_at = null,
         next_attempt_at = now() + make_interval(secs => $2),
         available_at = now() + make_interval(secs => $2),
         last_error = $3,
         updated_at = now()
     where run_id = $1
       and ($4::text is null or lease_owner = $4)`,
    [input.runId, input.delaySeconds, input.lastError, input.workerId ?? null]
  );

  return result.rowCount > 0;
}

export async function extendRunJobLease(input: {
  runId: string;
  workerId: string;
  leaseSeconds: number;
}): Promise<boolean> {
  const result = await query(
    `update run_jobs
     set leased_at = now(),
         lease_expires_at = now() + make_interval(secs => $3),
         locked_at = now(),
         updated_at = now()
     where run_id = $1
       and status = 'running'
       and lease_owner = $2`,
    [input.runId, input.workerId, input.leaseSeconds]
  );

  return result.rowCount > 0;
}

export async function getRunJobAttempts(
  runId: string
): Promise<{ attemptCount: number; maxAttempts: number } | null> {
  const result = await query<AttemptsRow>(
    `select attempt_count, max_attempts
     from run_jobs
     where run_id = $1`,
    [runId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts)
  };
}

export async function queueDepth(): Promise<number> {
  const result = await query<CountRow>(
    `select count(*)::int as count
     from run_jobs j
     join campaigns c on c.id = j.campaign_id
     where j.status = 'queued'
       and j.next_attempt_at <= now()
       and c.lifecycle_status = 'active'`
  );

  return Number(result.rows[0]?.count ?? 0);
}
