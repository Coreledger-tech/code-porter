import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import type {
  EvidenceExportArtifact,
  EvidenceManifest,
  EvidenceStorePort,
  EvidenceWriterPort,
  RunContext
} from "@code-porter/core/src/workflow-runner.js";

function runDir(runCtx: RunContext): string {
  return resolve(runCtx.evidenceRoot, runCtx.projectId, runCtx.campaignId, runCtx.runId);
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
      continue;
    }
    files.push(fullPath);
  }

  return files;
}

async function buildZip(input: {
  sourceDir: string;
  targetZipPath: string;
}): Promise<void> {
  await mkdir(join(input.targetZipPath, ".."), { recursive: true });

  const files = await listFiles(input.sourceDir);
  const zipFile = new yazl.ZipFile();

  for (const filePath of files) {
    const zipPath = relative(input.sourceDir, filePath);
    zipFile.addFile(filePath, zipPath);
  }

  const output = createWriteStream(input.targetZipPath);
  zipFile.end();
  await pipeline(zipFile.outputStream, output);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", (chunk) => {
    hash.update(chunk);
  });

  await new Promise<void>((resolveHash, rejectHash) => {
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash());
  });

  return hash.digest("hex");
}

export class LocalEvidenceStore implements EvidenceStorePort {
  constructor(private readonly writer: EvidenceWriterPort) {}

  async finalizeAndExport(runCtx: RunContext): Promise<{
    manifest: EvidenceManifest;
    zip?: EvidenceExportArtifact;
  }> {
    const manifest = await this.writer.finalize(runCtx);
    return { manifest };
  }
}

export class ZipEvidenceStore implements EvidenceStorePort {
  constructor(
    private readonly baseStore: EvidenceStorePort,
    private readonly exportRoot: string
  ) {}

  async finalizeAndExport(runCtx: RunContext): Promise<{
    manifest: EvidenceManifest;
    zip?: EvidenceExportArtifact;
  }> {
    const baseResult = await this.baseStore.finalizeAndExport(runCtx);

    const source = runDir(runCtx);
    const zipOutputDir = resolve(
      this.exportRoot,
      runCtx.projectId,
      runCtx.campaignId,
      runCtx.runId
    );
    const zipPath = join(zipOutputDir, "evidence.zip");

    await buildZip({
      sourceDir: source,
      targetZipPath: zipPath
    });

    const zipSha256 = await hashFile(zipPath);
    const details = await stat(zipPath);

    const exportArtifact: EvidenceExportArtifact = {
      type: "evidence.zip",
      path: zipPath,
      sha256: zipSha256,
      size: details.size
    };

    const updatedManifest: EvidenceManifest = {
      ...baseResult.manifest,
      exports: [...(baseResult.manifest.exports ?? []), exportArtifact]
    };

    await writeFile(join(source, "manifest.json"), JSON.stringify(updatedManifest, null, 2), "utf8");

    return {
      manifest: updatedManifest,
      zip: exportArtifact
    };
  }
}

export class S3EvidenceStore implements EvidenceStorePort {
  constructor(private readonly baseStore: EvidenceStorePort) {}

  async finalizeAndExport(runCtx: RunContext): Promise<{
    manifest: EvidenceManifest;
    zip?: EvidenceExportArtifact;
  }> {
    // TODO: Upload manifest and artifacts to object storage and return signed URLs.
    return this.baseStore.finalizeAndExport(runCtx);
  }
}
