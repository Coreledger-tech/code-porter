import { resolve } from "node:path";
import { keepLocalEvidenceDisk } from "@code-porter/evidence/src/index.js";
import { cleanupEntriesOlderThan, ttlDaysFromEnv } from "./cleanup.js";

function isS3EvidenceMode(): boolean {
  return (process.env.EVIDENCE_STORE_MODE ?? "local").toLowerCase() === "s3";
}

async function cleanupRoot(root: string, ttlDays: number): Promise<void> {
  const result = await cleanupEntriesOlderThan({
    root,
    ttlDays
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        operation: "cleanup:evidence",
        root: result.root,
        ttlDays,
        deleted: result.deleted.length,
        kept: result.kept.length,
        skipped: result.skipped
      },
      null,
      2
    )
  );
}

async function main(): Promise<void> {
  if (!isS3EvidenceMode()) {
    // eslint-disable-next-line no-console
    console.log("cleanup:evidence skipped: EVIDENCE_STORE_MODE is not s3");
    return;
  }

  if (!keepLocalEvidenceDisk()) {
    // eslint-disable-next-line no-console
    console.log("cleanup:evidence skipped: EVIDENCE_KEEP_LOCAL_DISK is false");
    return;
  }

  const ttlDays = ttlDaysFromEnv(process.env.EVIDENCE_CACHE_TTL_DAYS, 7);
  const evidenceRoot = resolve(process.cwd(), process.env.EVIDENCE_ROOT ?? "./evidence");
  const exportRoot = resolve(process.cwd(), process.env.EVIDENCE_EXPORT_ROOT ?? "./evidence-exports");

  await cleanupRoot(evidenceRoot, ttlDays);
  await cleanupRoot(exportRoot, ttlDays);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("cleanup:evidence failed", error);
  process.exitCode = 1;
});
