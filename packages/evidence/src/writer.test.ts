import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FileEvidenceWriter } from "./writer.js";

describe("FileEvidenceWriter", () => {
  it("writes artifacts and finalizes manifest", async () => {
    const base = await mkdtemp(join(tmpdir(), "code-porter-evidence-"));
    const writer = new FileEvidenceWriter(base);
    const runContext = {
      projectId: "project-1",
      campaignId: "campaign-1",
      runId: "run-1",
      evidenceRoot: base
    };

    await writer.write(runContext, "scan.json", { buildSystem: "maven" });
    await writer.write(runContext, "artifacts/diff.patch", "diff --git a/pom.xml b/pom.xml");

    const manifest = await writer.finalize(runContext);

    expect(manifest.runId).toBe("run-1");
    expect(manifest.artifacts.length).toBe(2);
    expect(manifest.artifacts.every((artifact) => artifact.sha256.length === 64)).toBe(true);

    const manifestPath = resolve(base, "project-1/campaign-1/run-1/manifest.json");
    const manifestFile = await readFile(manifestPath, "utf8");
    expect(JSON.parse(manifestFile).artifacts.length).toBe(2);
  });
});
