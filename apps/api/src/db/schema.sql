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
  created_at timestamptz not null default now()
);

create table if not exists runs (
  id text primary key,
  campaign_id text not null references campaigns(id) on delete cascade,
  mode text not null check (mode in ('plan', 'apply')),
  status text not null check (status in ('queued', 'running', 'completed', 'failed', 'needs_review', 'blocked')),
  confidence_score int,
  evidence_path text,
  branch_name text,
  pr_url text,
  summary jsonb not null default '{}'::jsonb,
  started_at timestamptz not null,
  finished_at timestamptz
);

create table if not exists evidence_artifacts (
  id text primary key,
  run_id text not null references runs(id) on delete cascade,
  type text not null,
  path text not null,
  sha256 text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_campaigns_project on campaigns(project_id);
create index if not exists idx_runs_campaign on runs(campaign_id);
create index if not exists idx_artifacts_run on evidence_artifacts(run_id);
