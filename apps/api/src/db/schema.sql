create table if not exists projects (
  id text primary key,
  name text not null,
  type text not null default 'local' check (type in ('local', 'github')),
  local_path text,
  owner text,
  repo text,
  clone_url text,
  default_branch text,
  constraint projects_type_requirements_check check (
    (type = 'local' and local_path is not null and owner is null and repo is null)
    or (type = 'github' and owner is not null and repo is not null)
  ),
  created_at timestamptz not null default now()
);

create table if not exists policies (
  id text primary key,
  name text not null,
  config_path text not null,
  created_at timestamptz not null default now()
);

create table if not exists campaigns (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  policy_id text not null references policies(id),
  recipe_pack text not null,
  target_selector text,
  lifecycle_status text not null default 'active' check (lifecycle_status in ('active', 'paused')),
  paused_at timestamptz,
  resumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists runs (
  id text primary key,
  campaign_id text not null references campaigns(id) on delete cascade,
  mode text not null check (mode in ('plan', 'apply')),
  status text not null check (status in ('queued', 'running', 'cancelling', 'cancelled', 'completed', 'failed', 'needs_review', 'blocked')),
  confidence_score int,
  evidence_path text,
  branch_name text,
  pr_url text,
  pr_number int,
  pr_state text check (pr_state in ('open', 'merged', 'closed')),
  pr_opened_at timestamptz,
  merged_at timestamptz,
  closed_at timestamptz,
  last_ci_state text,
  last_ci_checked_at timestamptz,
  summary jsonb not null default '{}'::jsonb,
  started_at timestamptz not null,
  finished_at timestamptz
);

create table if not exists run_jobs (
  run_id text primary key references runs(id) on delete cascade,
  campaign_id text not null references campaigns(id) on delete cascade,
  mode text not null check (mode in ('plan', 'apply')),
  status text not null check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  attempt_count int not null default 0,
  attempts int not null default 0,
  max_attempts int not null default 3,
  next_attempt_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  lease_owner text,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  locked_by text,
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists run_events (
  id bigserial primary key,
  run_id text not null references runs(id) on delete cascade,
  level text not null check (level in ('info', 'warn', 'error')),
  event_type text not null check (event_type in ('step_start', 'step_end', 'warning', 'error', 'lifecycle')),
  step text,
  message text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists evidence_artifacts (
  id text primary key,
  run_id text not null references runs(id) on delete cascade,
  type text not null,
  path text not null,
  sha256 text not null,
  storage_type text not null default 'local_fs' check (storage_type in ('local_fs', 's3')),
  bucket text,
  object_key text,
  created_at timestamptz not null default now()
);

create index if not exists idx_campaigns_project on campaigns(project_id);
create index if not exists idx_runs_campaign on runs(campaign_id);
create index if not exists idx_run_jobs_status_available on run_jobs(status, available_at, created_at);
create index if not exists idx_run_jobs_locked_at on run_jobs(locked_at);
create index if not exists idx_run_events_run_id_id on run_events(run_id, id);
create index if not exists idx_artifacts_run on evidence_artifacts(run_id);
