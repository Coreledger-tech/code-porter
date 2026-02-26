import { createReadStream } from "node:fs";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type EvidenceUrlMode = "signed" | "public";

export interface S3EvidenceConfig {
  endpoint: string;
  publicEndpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  signedUrlTtlSeconds: number;
  urlMode: EvidenceUrlMode;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }

  return fallback;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function normalizeMode(value: string | undefined): EvidenceUrlMode {
  return value === "public" ? "public" : "signed";
}

export function resolveS3EvidenceConfig(
  env: NodeJS.ProcessEnv = process.env
): S3EvidenceConfig | null {
  const endpoint = env.S3_ENDPOINT?.trim();
  const bucket = env.S3_BUCKET?.trim();
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    endpoint,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT?.trim() || endpoint,
    region: env.S3_REGION?.trim() || "us-east-1",
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: readBoolean(env.S3_FORCE_PATH_STYLE, true),
    signedUrlTtlSeconds: readPositiveInt(env.EVIDENCE_SIGNED_URL_TTL_SECONDS, 3600),
    urlMode: normalizeMode(env.EVIDENCE_URL_MODE)
  };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function encodeObjectKey(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function buildS3ObjectUrl(
  config: Pick<S3EvidenceConfig, "publicEndpoint" | "forcePathStyle" | "bucket">,
  objectKey: string
): string {
  const endpoint = trimSlash(config.publicEndpoint);
  const encodedKey = encodeObjectKey(objectKey);

  if (config.forcePathStyle) {
    return `${endpoint}/${encodeURIComponent(config.bucket)}/${encodedKey}`;
  }

  const parsed = new URL(endpoint);
  const host = parsed.host;
  const protocol = parsed.protocol;
  return `${protocol}//${encodeURIComponent(config.bucket)}.${host}/${encodedKey}`;
}

export function createS3Client(
  config: Pick<
    S3EvidenceConfig,
    "endpoint" | "region" | "accessKeyId" | "secretAccessKey" | "forcePathStyle"
  >
): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
}

export async function uploadFileToS3(input: {
  client: S3Client;
  bucket: string;
  objectKey: string;
  filePath: string;
  contentType: string;
}): Promise<void> {
  await input.client.send(
    new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.objectKey,
      Body: createReadStream(input.filePath),
      ContentType: input.contentType
    })
  );
}

export async function generateS3ObjectUrl(input: {
  client: S3Client;
  config: Pick<
    S3EvidenceConfig,
    "bucket" | "urlMode" | "signedUrlTtlSeconds" | "publicEndpoint" | "forcePathStyle"
  >;
  objectKey: string;
}): Promise<string> {
  if (input.config.urlMode === "public") {
    return buildS3ObjectUrl(
      {
        publicEndpoint: input.config.publicEndpoint,
        forcePathStyle: input.config.forcePathStyle,
        bucket: input.config.bucket
      },
      input.objectKey
    );
  }

  return getSignedUrl(
    input.client,
    new GetObjectCommand({
      Bucket: input.config.bucket,
      Key: input.objectKey
    }),
    { expiresIn: input.config.signedUrlTtlSeconds }
  );
}

export async function getS3ObjectStream(input: {
  client: S3Client;
  bucket: string;
  objectKey: string;
}): Promise<NodeJS.ReadableStream> {
  const result = await input.client.send(
    new GetObjectCommand({
      Bucket: input.bucket,
      Key: input.objectKey
    })
  );

  if (!result.Body) {
    throw new Error("S3 object body is empty");
  }

  return result.Body as NodeJS.ReadableStream;
}

export function isS3Mode(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.EVIDENCE_STORE_MODE ?? "local").toLowerCase() === "s3";
}

export function keepLocalEvidenceDisk(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBoolean(env.EVIDENCE_KEEP_LOCAL_DISK, true);
}

export function evidenceUrlMode(
  env: NodeJS.ProcessEnv = process.env
): "signed" | "public" | "local_proxy" {
  if (!isS3Mode(env)) {
    return "local_proxy";
  }
  return normalizeMode(env.EVIDENCE_URL_MODE);
}
