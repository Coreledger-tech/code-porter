import { resolve } from "node:path";
import { cleanupEntriesOlderThan, ttlDaysFromEnv } from "./cleanup.js";

async function main(): Promise<void> {
  const workspaceRoot = resolve(process.cwd(), process.env.WORKSPACE_ROOT ?? "./workspaces");
  const ttlDays = ttlDaysFromEnv(process.env.WORKSPACE_TTL_DAYS, 7);

  const result = await cleanupEntriesOlderThan({
    root: workspaceRoot,
    ttlDays
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        operation: "cleanup:workspaces",
        ttlDays,
        root: result.root,
        deleted: result.deleted.length,
        kept: result.kept.length,
        skipped: result.skipped
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("cleanup:workspaces failed", error);
  process.exitCode = 1;
});
