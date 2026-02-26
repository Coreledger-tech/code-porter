import { describe, expect, it, vi } from "vitest";

const { getSignedUrlMock } = vi.hoisted(() => {
  return {
    getSignedUrlMock: vi.fn(async () => "https://signed.example/object")
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => {
  return {
    getSignedUrl: getSignedUrlMock
  };
});

import {
  buildS3ObjectUrl,
  evidenceUrlMode,
  generateS3ObjectUrl,
  resolveS3EvidenceConfig
} from "./s3.js";

describe("s3 evidence utilities", () => {
  it("builds path-style public object URLs", () => {
    const url = buildS3ObjectUrl(
      {
        publicEndpoint: "http://localhost:9000",
        forcePathStyle: true,
        bucket: "code-porter-evidence"
      },
      "project/campaign/run/evidence.zip"
    );

    expect(url).toBe(
      "http://localhost:9000/code-porter-evidence/project/campaign/run/evidence.zip"
    );
  });

  it("generates signed URL in signed mode", async () => {
    const url = await generateS3ObjectUrl({
      client: {} as any,
      config: {
        bucket: "code-porter-evidence",
        urlMode: "signed",
        signedUrlTtlSeconds: 3600,
        publicEndpoint: "http://localhost:9000",
        forcePathStyle: true
      },
      objectKey: "p/c/r/evidence.zip"
    });

    expect(url).toBe("https://signed.example/object");
    expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
  });

  it("generates public URL in public mode", async () => {
    const url = await generateS3ObjectUrl({
      client: {} as any,
      config: {
        bucket: "code-porter-evidence",
        urlMode: "public",
        signedUrlTtlSeconds: 3600,
        publicEndpoint: "http://localhost:9000",
        forcePathStyle: true
      },
      objectKey: "p/c/r/manifest.json"
    });

    expect(url).toBe("http://localhost:9000/code-porter-evidence/p/c/r/manifest.json");
  });

  it("resolves configuration and evidence URL mode defaults", () => {
    const config = resolveS3EvidenceConfig({
      S3_ENDPOINT: "http://minio:9000",
      S3_PUBLIC_ENDPOINT: "http://localhost:9000",
      S3_BUCKET: "code-porter-evidence",
      S3_ACCESS_KEY_ID: "minioadmin",
      S3_SECRET_ACCESS_KEY: "minioadmin",
      S3_FORCE_PATH_STYLE: "true",
      EVIDENCE_URL_MODE: "signed"
    });

    expect(config?.bucket).toBe("code-porter-evidence");
    expect(config?.urlMode).toBe("signed");
    expect(evidenceUrlMode({ EVIDENCE_STORE_MODE: "local" })).toBe("local_proxy");
    expect(evidenceUrlMode({ EVIDENCE_STORE_MODE: "s3", EVIDENCE_URL_MODE: "public" })).toBe(
      "public"
    );
  });
});
