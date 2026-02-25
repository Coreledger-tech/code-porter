import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dbPool } from "./client.js";

async function runMigrations(): Promise<void> {
  const schemaPath = resolve(process.cwd(), "apps/api/src/db/schema.sql");
  const schemaSql = await readFile(schemaPath, "utf8");

  await dbPool.query(schemaSql);

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

runMigrations()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Migration failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await dbPool.end();
  });
