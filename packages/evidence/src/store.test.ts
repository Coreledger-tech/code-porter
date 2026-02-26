import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunContext } from "@code-porter/core/src/workflow-runner.js";
import { LocalEvidenceStore, ZipEvidenceStore } from "./store.js";
import { FileEvidenceWriter } from "./writer.js";

describe("ZipEvidenceStore", () => {
  it("creates evidence.zip and appends export hash metadata to manifest", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "code-porter-evidence-root-"));
    const exportRoot = await mkdtemp(join(tmpdir(), "code-porter-evidence-exports-"));
    const writer = new FileEvidenceWriter(evidenceRoot);
    const store = new ZipEvidenceStore(new LocalEvidenceStore(writer), exportRoot);

    const runCtx: RunContext = {
      projectId: "project-1",
      campaignId: "campaign-1",
      runId: "run-1",
      evidenceRoot
    };

    await writer.write(runCtx, "run.json", { status: "running" });
    await writer.write(runCtx, "verify.json", { compile: { status: "passed" } });

    const result = await store.finalizeAndExport(runCtx);

    expect(result.zip).toBeDefined();
    expect(result.zip?.type).toBe("evidence.zip");
    expect(result.zip?.sha256.length).toBeGreaterThan(0);
    if (result.zip) {
      await access(result.zip.path);
    }

    const manifestPath = join(evidenceRoot, "project-1", "campaign-1", "run-1", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      exports?: Array<{ type: string; sha256: string }>;
    };

    expect(manifest.exports?.some((entry) => entry.type === "evidence.zip")).toBe(true);
  });
});
