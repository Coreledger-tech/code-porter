import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import type {
  EvidenceExportArtifact,
  EvidenceManifest,
  EvidenceStorePort,
  EvidenceWriterPort,
  RunContext
} from "@code-porter/core/src/workflow-runner.js";
import {
  createS3Client,
  keepLocalEvidenceDisk,
  resolveS3EvidenceConfig,
  type S3EvidenceConfig,
  uploadFileToS3
} from "./s3.js";

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
  await mkdir(dirname(input.targetZipPath), { recursive: true });

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

function s3Uri(bucket: string, objectKey: string): string {
  return `s3://${bucket}/${objectKey}`;
}

export class LocalEvidenceStore implements EvidenceStorePort {
  constructor(private readonly writer: EvidenceWriterPort) {}

  async finalizeAndExport(runCtx: RunContext): Promise<{
    manifest: EvidenceManifest;
    zip?: EvidenceExportArtifact;
    exports?: EvidenceExportArtifact[];
  }> {
    const manifest = await this.writer.finalize(runCtx);
    return { manifest, exports: manifest.exports ?? [] };
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
    exports?: EvidenceExportArtifact[];
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
      size: details.size,
      storageType: "local_fs"
    };

    const exports = [...(baseResult.manifest.exports ?? []), exportArtifact];

    const updatedManifest: EvidenceManifest = {
      ...baseResult.manifest,
      exports
    };

    await writeFile(join(source, "manifest.json"), JSON.stringify(updatedManifest, null, 2), "utf8");

    return {
      manifest: updatedManifest,
      zip: exportArtifact,
      exports
    };
  }
}

export class S3CompatibleEvidenceStore implements EvidenceStorePort {
  private readonly uploadClient;
  private readonly keepLocalDisk: boolean;

  constructor(
    private readonly baseStore: EvidenceStorePort,
    private readonly config: S3EvidenceConfig,
    options?: { keepLocalDisk?: boolean }
  ) {
    this.uploadClient = createS3Client(config);
    this.keepLocalDisk = options?.keepLocalDisk ?? keepLocalEvidenceDisk();
  }

  static fromEnv(baseStore: EvidenceStorePort): S3CompatibleEvidenceStore | null {
    const config = resolveS3EvidenceConfig();
    if (!config) {
      return null;
    }

    return new S3CompatibleEvidenceStore(baseStore, config, {
      keepLocalDisk: keepLocalEvidenceDisk()
    });
  }

  async finalizeAndExport(runCtx: RunContext): Promise<{
    manifest: EvidenceManifest;
    zip?: EvidenceExportArtifact;
    exports?: EvidenceExportArtifact[];
  }> {
    const baseResult = await this.baseStore.finalizeAndExport(runCtx);

    if (!baseResult.zip) {
      throw new Error("S3 evidence export requires a local evidence.zip artifact");
    }

    const runEvidenceDir = runDir(runCtx);
    const manifestPath = join(runEvidenceDir, "manifest.json");
    const objectPrefix = `${runCtx.projectId}/${runCtx.campaignId}/${runCtx.runId}`;

    const zipKey = `${objectPrefix}/evidence.zip`;
    const manifestKey = `${objectPrefix}/manifest.json`;

    await uploadFileToS3({
      client: this.uploadClient,
      bucket: this.config.bucket,
      objectKey: zipKey,
      filePath: baseResult.zip.path,
      contentType: "application/zip"
    });

    const remoteZipArtifact: EvidenceExportArtifact = {
      type: "evidence.zip",
      path: s3Uri(this.config.bucket, zipKey),
      sha256: baseResult.zip.sha256,
      size: baseResult.zip.size,
      storageType: "s3",
      bucket: this.config.bucket,
      objectKey: zipKey
    };

    const mergedManifestExports = [
      ...(baseResult.manifest.exports ?? []),
      remoteZipArtifact
    ].filter((artifact, index, artifacts) => {
      return (
        artifacts.findIndex(
          (candidate) =>
            candidate.type === artifact.type &&
            candidate.path === artifact.path &&
            candidate.sha256 === artifact.sha256
        ) === index
      );
    });

    const mergedManifest: EvidenceManifest = {
      ...baseResult.manifest,
      exports: mergedManifestExports
    };

    await writeFile(manifestPath, JSON.stringify(mergedManifest, null, 2), "utf8");

    const manifestDetails = await stat(manifestPath);
    const manifestSha = await hashFile(manifestPath);

    await uploadFileToS3({
      client: this.uploadClient,
      bucket: this.config.bucket,
      objectKey: manifestKey,
      filePath: manifestPath,
      contentType: "application/json"
    });

    const remoteManifestArtifact: EvidenceExportArtifact = {
      type: "manifest.json",
      path: s3Uri(this.config.bucket, manifestKey),
      sha256: manifestSha,
      size: manifestDetails.size,
      storageType: "s3",
      bucket: this.config.bucket,
      objectKey: manifestKey
    };

    const exports: EvidenceExportArtifact[] = [
      ...(baseResult.exports ?? []),
      ...mergedManifestExports,
      remoteManifestArtifact
    ].filter((artifact, index, artifacts) => {
      return (
        artifacts.findIndex(
          (candidate) =>
            candidate.type === artifact.type &&
            candidate.path === artifact.path &&
            candidate.sha256 === artifact.sha256
        ) === index
      );
    });

    if (!this.keepLocalDisk) {
      await rm(runEvidenceDir, { recursive: true, force: true });
      await rm(baseResult.zip.path, { force: true });
    }

    return {
      manifest: mergedManifest,
      zip: remoteZipArtifact,
      exports
    };
  }
}

export class S3EvidenceStore extends S3CompatibleEvidenceStore {}
