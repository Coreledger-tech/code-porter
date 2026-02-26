import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "@code-porter/core/src/workflow-runner.js";

const { createS3ClientMock, uploadFileToS3Mock } = vi.hoisted(() => {
  return {
    createS3ClientMock: vi.fn(() => ({ send: vi.fn() })),
    uploadFileToS3Mock: vi.fn(async () => undefined)
  };
});

vi.mock("./s3.js", async () => {
  const actual = await vi.importActual<typeof import("./s3.js")>("./s3.js");
  return {
    ...actual,
    createS3Client: createS3ClientMock,
    uploadFileToS3: uploadFileToS3Mock
  };
});

import {
  LocalEvidenceStore,
  S3CompatibleEvidenceStore,
  ZipEvidenceStore
} from "./store.js";
import { FileEvidenceWriter } from "./writer.js";

describe("S3CompatibleEvidenceStore", () => {
  beforeEach(() => {
    createS3ClientMock.mockClear();
    uploadFileToS3Mock.mockClear();
  });

  it("uploads zip and manifest and returns remote export metadata", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "code-porter-evidence-root-"));
    const exportRoot = await mkdtemp(join(tmpdir(), "code-porter-evidence-exports-"));
    const writer = new FileEvidenceWriter(evidenceRoot);
    const base = new ZipEvidenceStore(new LocalEvidenceStore(writer), exportRoot);
    const store = new S3CompatibleEvidenceStore(base, {
      endpoint: "http://minio:9000",
      publicEndpoint: "http://localhost:9000",
      region: "us-east-1",
      bucket: "code-porter-evidence",
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
      forcePathStyle: true,
      signedUrlTtlSeconds: 3600,
      urlMode: "signed"
    });

    const runCtx: RunContext = {
      projectId: "project-1",
      campaignId: "campaign-1",
      runId: "run-1",
      evidenceRoot
    };

    await writer.write(runCtx, "run.json", { status: "running" });
    await writer.write(runCtx, "verify.json", { compile: { status: "passed" } });

    const result = await store.finalizeAndExport(runCtx);

    expect(uploadFileToS3Mock).toHaveBeenCalledTimes(2);
    expect(result.zip?.storageType).toBe("s3");
    expect(
      result.exports?.some(
        (artifact) => artifact.type === "evidence.zip" && artifact.storageType === "s3"
      )
    ).toBe(true);
    expect(
      result.exports?.some(
        (artifact) => artifact.type === "manifest.json" && artifact.storageType === "s3"
      )
    ).toBe(true);

    const manifestPath = join(evidenceRoot, "project-1", "campaign-1", "run-1", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      artifacts: Array<{ type: string; sha256: string }>;
    };

    expect(manifest.artifacts.length).toBe(2);
    expect(manifest.artifacts.every((artifact) => artifact.sha256.length === 64)).toBe(true);
  });
});
