import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type {
  EvidenceManifest,
  EvidenceWriterPort,
  RunContext
} from "@code-porter/core/src/workflow-runner.js";

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

function hashBuffer(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

export class FileEvidenceWriter implements EvidenceWriterPort {
  constructor(private readonly baseRoot: string) {}

  private runDir(runCtx: RunContext): string {
    return resolve(
      this.baseRoot,
      runCtx.projectId,
      runCtx.campaignId,
      runCtx.runId
    );
  }

  async write(runCtx: RunContext, artifactType: string, data: unknown): Promise<string> {
    const runDir = this.runDir(runCtx);
    await ensureDir(runDir);

    const target = join(runDir, artifactType);
    await ensureDir(join(target, ".."));

    if (typeof data === "string" || artifactType.endsWith(".patch")) {
      await writeFile(target, typeof data === "string" ? data : JSON.stringify(data), "utf8");
    } else {
      await writeFile(target, JSON.stringify(data, null, 2), "utf8");
    }

    return target;
  }

  async finalize(runCtx: RunContext): Promise<EvidenceManifest> {
    const runDir = this.runDir(runCtx);
    await ensureDir(runDir);

    const files = (await listFiles(runDir)).filter((filePath) => !filePath.endsWith("manifest.json"));

    const artifacts = [];

    for (const filePath of files) {
      const content = await readFile(filePath);
      const details = await stat(filePath);
      artifacts.push({
        type: relative(runDir, filePath),
        path: filePath,
        sha256: hashBuffer(content),
        size: details.size
      });
    }

    const manifest: EvidenceManifest = {
      runId: runCtx.runId,
      artifacts
    };

    await writeFile(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    return manifest;
  }
}
