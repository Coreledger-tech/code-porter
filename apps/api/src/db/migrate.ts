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
     check (status in ('queued', 'running', 'completed', 'failed', 'needs_review', 'blocked'))`
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

export async function runMigrations(): Promise<void> {
  await waitForDatabase(15, 1000);

  const schemaPath = resolve(process.cwd(), "apps/api/src/db/schema.sql");
  const schemaSql = await readFile(schemaPath, "utf8");

  await dbPool.query(schemaSql);
  await ensureProjectsShape();
  await ensureRunsShape();
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
