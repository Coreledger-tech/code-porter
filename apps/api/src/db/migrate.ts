import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dbPool } from "./client.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

async function waitForDatabase(maxAttempts: number, delayMs: number): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await dbPool.query("select 1");
      return;
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }
      // eslint-disable-next-line no-console
      console.log(`Database not ready (attempt ${attempt}/${maxAttempts}), retrying...`);
      await sleep(delayMs);
    }
  }
}

async function ensureRunStatusConstraint(): Promise<void> {
  await dbPool.query(
    `alter table if exists runs
     drop constraint if exists runs_status_check`
  );

  await dbPool.query(
    `alter table if exists runs
     add constraint runs_status_check
     check (status in ('queued', 'running', 'cancelling', 'cancelled', 'completed', 'failed', 'needs_review', 'blocked'))`
  );
}

async function ensureCampaignLifecycleShape(): Promise<void> {
  await dbPool.query(
    `alter table if exists campaigns
     add column if not exists lifecycle_status text`
  );
  await dbPool.query(
    `alter table if exists campaigns
     add column if not exists paused_at timestamptz`
  );
  await dbPool.query(
    `alter table if exists campaigns
     add column if not exists resumed_at timestamptz`
  );

  await dbPool.query(
    `update campaigns
     set lifecycle_status = 'active'
     where lifecycle_status is null`
  );

  await dbPool.query(
    `alter table if exists campaigns
     alter column lifecycle_status set default 'active'`
  );
  await dbPool.query(
    `alter table if exists campaigns
     alter column lifecycle_status set not null`
  );

  await dbPool.query(
    `alter table if exists campaigns
     drop constraint if exists campaigns_lifecycle_status_check`
  );
  await dbPool.query(
    `alter table if exists campaigns
     add constraint campaigns_lifecycle_status_check
     check (lifecycle_status in ('active', 'paused'))`
  );

  await dbPool.query(
    `create index if not exists idx_campaigns_lifecycle_status
     on campaigns(lifecycle_status)`
  );
}

async function ensureProjectsShape(): Promise<void> {
  await dbPool.query(
    `alter table if exists projects
     add column if not exists type text`
  );
  await dbPool.query(
    `alter table if exists projects
     add column if not exists owner text`
  );
  await dbPool.query(
    `alter table if exists projects
     add column if not exists repo text`
  );
  await dbPool.query(
    `alter table if exists projects
     add column if not exists clone_url text`
  );
  await dbPool.query(
    `alter table if exists projects
     add column if not exists default_branch text`
  );

  await dbPool.query(
    `update projects
     set type = 'local'
     where type is null`
  );

  await dbPool.query(
    `alter table if exists projects
     alter column type set default 'local'`
  );

  await dbPool.query(
    `alter table if exists projects
     alter column type set not null`
  );

  await dbPool.query(
    `alter table if exists projects
     alter column local_path drop not null`
  );

  await dbPool.query(
    `alter table if exists projects
     drop constraint if exists projects_type_check`
  );

  await dbPool.query(
    `alter table if exists projects
     drop constraint if exists projects_type_requirements_check`
  );

  await dbPool.query(
    `alter table if exists projects
     add constraint projects_type_check
     check (type in ('local', 'github'))`
  );

  await dbPool.query(
    `alter table if exists projects
     add constraint projects_type_requirements_check
     check (
       (type = 'local' and local_path is not null and owner is null and repo is null)
       or (type = 'github' and owner is not null and repo is not null)
     )`
  );
}

async function ensureRunsShape(): Promise<void> {
  await dbPool.query(
    `alter table if exists runs
     add column if not exists pr_url text`
  );
}

async function ensureRunPrLifecycleShape(): Promise<void> {
  await dbPool.query(
    `alter table if exists runs
     add column if not exists pr_number int`
  );
  await dbPool.query(
    `alter table if exists runs
     add column if not exists pr_state text`
  );
  await dbPool.query(
    `alter table if exists runs
     add column if not exists pr_opened_at timestamptz`
  );
  await dbPool.query(
    `alter table if exists runs
     add column if not exists merged_at timestamptz`
  );
  await dbPool.query(
    `alter table if exists runs
     add column if not exists closed_at timestamptz`
  );
  await dbPool.query(
    `alter table if exists runs
     add column if not exists last_ci_state text`
  );
  await dbPool.query(
    `alter table if exists runs
     add column if not exists last_ci_checked_at timestamptz`
  );

  await dbPool.query(
    `alter table if exists runs
     drop constraint if exists runs_pr_state_check`
  );
  await dbPool.query(
    `alter table if exists runs
     add constraint runs_pr_state_check
     check (pr_state in ('open', 'merged', 'closed') or pr_state is null)`
  );

  await dbPool.query(
    `create index if not exists idx_runs_pr_state
     on runs(pr_state)`
  );
  await dbPool.query(
    `create index if not exists idx_runs_pr_number
     on runs(pr_number)`
  );
  await dbPool.query(
    `create index if not exists idx_runs_pr_open_poll
     on runs(pr_state, started_at)
     where pr_url is not null`
  );
}

async function ensureRunJobsShape(): Promise<void> {
  await dbPool.query(
    `create table if not exists run_jobs (
      run_id text primary key references runs(id) on delete cascade,
      campaign_id text not null references campaigns(id) on delete cascade,
      mode text not null,
      status text not null,
      attempts int not null default 0,
      max_attempts int not null default 3,
      available_at timestamptz not null default now(),
      locked_by text,
      locked_at timestamptz,
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`
  );

  await dbPool.query(
    `alter table if exists run_jobs
     add column if not exists attempt_count int`
  );
  await dbPool.query(
    `alter table if exists run_jobs
     add column if not exists next_attempt_at timestamptz`
  );
  await dbPool.query(
    `alter table if exists run_jobs
     add column if not exists lease_owner text`
  );
  await dbPool.query(
    `alter table if exists run_jobs
     add column if not exists leased_at timestamptz`
  );
  await dbPool.query(
    `alter table if exists run_jobs
     add column if not exists lease_expires_at timestamptz`
  );

  await dbPool.query(
    `update run_jobs
     set attempt_count = coalesce(attempt_count, attempts, 0)
     where attempt_count is null`
  );
  await dbPool.query(
    `update run_jobs
     set next_attempt_at = coalesce(next_attempt_at, available_at, now())
     where next_attempt_at is null`
  );
  await dbPool.query(
    `update run_jobs
     set lease_owner = coalesce(lease_owner, locked_by),
         leased_at = coalesce(leased_at, locked_at),
         lease_expires_at = coalesce(
           lease_expires_at,
           case
             when locked_at is not null
             then locked_at + make_interval(secs => 300)
             else null
           end
         )`
  );

  await dbPool.query(
    `alter table if exists run_jobs
     alter column attempt_count set default 0`
  );
  await dbPool.query(
    `alter table if exists run_jobs
     alter column attempt_count set not null`
  );
  await dbPool.query(
    `alter table if exists run_jobs
     alter column next_attempt_at set default now()`
  );
  await dbPool.query(
    `alter table if exists run_jobs
     alter column next_attempt_at set not null`
  );

  await dbPool.query(
    `alter table if exists run_jobs
     drop constraint if exists run_jobs_mode_check`
  );
  await dbPool.query(
    `alter table if exists run_jobs
     add constraint run_jobs_mode_check
     check (mode in ('plan', 'apply'))`
  );

  await dbPool.query(
    `alter table if exists run_jobs
     drop constraint if exists run_jobs_status_check`
  );
  await dbPool.query(
    `alter table if exists run_jobs
     add constraint run_jobs_status_check
     check (status in ('queued', 'running', 'completed', 'failed', 'cancelled'))`
  );

  await dbPool.query(
    `create index if not exists idx_run_jobs_status_available
     on run_jobs(status, available_at, created_at)`
  );
  await dbPool.query(
    `create index if not exists idx_run_jobs_locked_at
     on run_jobs(locked_at)`
  );
  await dbPool.query(
    `create index if not exists idx_run_jobs_claim
     on run_jobs(status, next_attempt_at, lease_expires_at, campaign_id, created_at)`
  );
}

async function ensureRunEventsShape(): Promise<void> {
  await dbPool.query(
    `create table if not exists run_events (
      id bigserial primary key,
      run_id text not null references runs(id) on delete cascade,
      level text not null,
      event_type text not null,
      step text,
      message text not null,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )`
  );

  await dbPool.query(
    `alter table if exists run_events
     drop constraint if exists run_events_level_check`
  );
  await dbPool.query(
    `alter table if exists run_events
     add constraint run_events_level_check
     check (level in ('info', 'warn', 'error'))`
  );

  await dbPool.query(
    `alter table if exists run_events
     drop constraint if exists run_events_event_type_check`
  );
  await dbPool.query(
    `alter table if exists run_events
     add constraint run_events_event_type_check
     check (event_type in ('step_start', 'step_end', 'warning', 'error', 'lifecycle'))`
  );

  await dbPool.query(
    `create index if not exists idx_run_events_run_id_id
     on run_events(run_id, id)`
  );
}

async function ensureEvidenceArtifactsShape(): Promise<void> {
  await dbPool.query(
    `alter table if exists evidence_artifacts
     add column if not exists storage_type text`
  );
  await dbPool.query(
    `alter table if exists evidence_artifacts
     add column if not exists bucket text`
  );
  await dbPool.query(
    `alter table if exists evidence_artifacts
     add column if not exists object_key text`
  );

  await dbPool.query(
    `update evidence_artifacts
     set storage_type = 'local_fs'
     where storage_type is null`
  );

  await dbPool.query(
    `alter table if exists evidence_artifacts
     alter column storage_type set default 'local_fs'`
  );
  await dbPool.query(
    `alter table if exists evidence_artifacts
     alter column storage_type set not null`
  );

  await dbPool.query(
    `alter table if exists evidence_artifacts
     drop constraint if exists evidence_artifacts_storage_type_check`
  );
  await dbPool.query(
    `alter table if exists evidence_artifacts
     add constraint evidence_artifacts_storage_type_check
     check (storage_type in ('local_fs', 's3'))`
  );
}

export async function runMigrations(): Promise<void> {
  await waitForDatabase(15, 1000);

  const schemaPath = resolve(process.cwd(), "apps/api/src/db/schema.sql");
  const schemaSql = await readFile(schemaPath, "utf8");

  await dbPool.query(schemaSql);
  await ensureCampaignLifecycleShape();
  await ensureProjectsShape();
  await ensureRunsShape();
  await ensureRunPrLifecycleShape();
  await ensureRunJobsShape();
  await ensureRunEventsShape();
  await ensureEvidenceArtifactsShape();
  await ensureRunStatusConstraint();

  const policyPath = process.env.POLICY_DEFAULT_PATH ?? "./policies/default.yaml";

  await dbPool.query(
    `insert into policies (id, name, config_path)
     values ($1, $2, $3)
     on conflict (id)
     do update set
       name = excluded.name,
       config_path = excluded.config_path`,
    ["default", "Default Policy", policyPath]
  );

  // eslint-disable-next-line no-console
  console.log("Migrations complete");
}

async function main(): Promise<void> {
  await runMigrations();
}

const isMain = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  main()
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error("Migration failed", error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await dbPool.end();
    });
}
