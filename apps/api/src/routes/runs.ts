import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { Router } from "express";
import {
  createS3Client,
  evidenceUrlMode,
  generateS3ObjectUrl,
  getS3ObjectStream,
  isS3Mode,
  resolveS3EvidenceConfig
} from "@code-porter/evidence/src/index.js";
import { query } from "../db/client.js";
import { cancelRun } from "../workflow-service.js";

interface RunRow {
  id: string;
  campaign_id: string;
  status: string;
  confidence_score: number | null;
  evidence_path: string | null;
  branch_name: string | null;
  pr_url: string | null;
  pr_number: number | null;
  pr_state: "open" | "merged" | "closed" | null;
  pr_opened_at: string | null;
  merged_at: string | null;
  closed_at: string | null;
  last_ci_state: string | null;
  last_ci_checked_at: string | null;
  summary: Record<string, unknown>;
}

interface RunJobRow {
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  lease_owner: string | null;
  leased_at: string | null;
  lease_expires_at: string | null;
}

interface ArtifactRow {
  type: string;
  path: string;
  storage_type: "local_fs" | "s3";
  bucket: string | null;
  object_key: string | null;
}

interface LatestEventRow {
  step: string | null;
  created_at: string;
}

interface EventRow {
  id: number;
  run_id: string;
  level: "info" | "warn" | "error";
  event_type: "step_start" | "step_end" | "warning" | "error" | "lifecycle";
  step: string | null;
  message: string;
  payload: Record<string, unknown>;
  created_at: string;
}

function resolveApiBaseUrl(req: {
  protocol?: string;
  get?: (name: string) => string | undefined;
}): string {
  const configured = process.env.BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  const host = req.get?.("host") ?? "localhost:3000";
  const protocol = req.protocol ?? "http";
  return `${protocol}://${host}`;
}

function pickArtifact(
  artifacts: ArtifactRow[],
  type: string,
  preferredStorage: "local_fs" | "s3"
): ArtifactRow | null {
  const candidates = artifacts.filter((artifact) => artifact.type === type);
  if (candidates.length === 0) {
    return null;
  }

  return (
    candidates.find((artifact) => artifact.storage_type === preferredStorage) ??
    candidates[0]
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function streamFile(input: {
  path: string;
  contentType: string;
  fileName?: string;
  res: {
    setHeader: (name: string, value: string) => void;
    headersSent?: boolean;
    status: (code: number) => { json: (body: unknown) => void };
    end: () => void;
  };
}): Promise<void> {
  const exists = await fileExists(input.path);
  if (!exists) {
    input.res.status(404).json({ error: "artifact not found" });
    return;
  }

  input.res.setHeader("Content-Type", input.contentType);
  if (input.fileName) {
    input.res.setHeader("Content-Disposition", `attachment; filename=\"${input.fileName}\"`);
  }

  const stream = createReadStream(input.path);
  stream.on("error", () => {
    if (!input.res.headersSent) {
      input.res.status(500).json({ error: "failed to read artifact" });
    } else {
      input.res.end();
    }
  });
  stream.pipe(input.res as any);
}

async function resolveS3Url(artifact: ArtifactRow | null): Promise<string | null> {
  if (!artifact || artifact.storage_type !== "s3" || !artifact.bucket || !artifact.object_key) {
    return null;
  }

  const config = resolveS3EvidenceConfig();
  if (!config) {
    return null;
  }

  const urlClient = createS3Client({
    ...config,
    endpoint: config.publicEndpoint
  });

  try {
    return await generateS3ObjectUrl({
      client: urlClient,
      config,
      objectKey: artifact.object_key
    });
  } catch {
    return null;
  }
}

async function streamFromS3Artifact(input: {
  artifact: ArtifactRow;
  contentType: string;
  fileName?: string;
  res: {
    setHeader: (name: string, value: string) => void;
    status: (code: number) => { json: (body: unknown) => void };
  };
}): Promise<boolean> {
  if (
    input.artifact.storage_type !== "s3" ||
    !input.artifact.bucket ||
    !input.artifact.object_key
  ) {
    return false;
  }

  const config = resolveS3EvidenceConfig();
  if (!config) {
    return false;
  }

  try {
    const client = createS3Client(config);
    const stream = await getS3ObjectStream({
      client,
      bucket: input.artifact.bucket,
      objectKey: input.artifact.object_key
    });

    input.res.setHeader("Content-Type", input.contentType);
    if (input.fileName) {
      input.res.setHeader(
        "Content-Disposition",
        `attachment; filename=\"${input.fileName}\"`
      );
    }

    (stream as any).pipe(input.res as any);
    return true;
  } catch {
    return false;
  }
}

export function runsRouter(): Router {
  const router = Router();

  router.post("/runs/:id/cancel", async (req, res, next) => {
    try {
      const runId = req.params.id;
      const body = req.body as { reason?: string } | undefined;
      const result = await cancelRun(runId, body?.reason);
      return res.json(result);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return res.status(404).json({ error: "run not found" });
      }
      return next(error);
    }
  });

  router.get("/runs/:id", async (req, res) => {
    const runId = req.params.id;

    const runQuery = await query<RunRow>(
      `select id,
              campaign_id,
              status,
              confidence_score,
              evidence_path,
              branch_name,
              pr_url,
              pr_number,
              pr_state,
              pr_opened_at::text,
              merged_at::text,
              closed_at::text,
              last_ci_state,
              last_ci_checked_at::text,
              summary
       from runs where id = $1`,
      [runId]
    );

    const run = runQuery.rows[0];
    if (!run) {
      return res.status(404).json({ error: "run not found" });
    }

    const artifacts = await query<ArtifactRow>(
      `select type, path, storage_type, bucket, object_key
       from evidence_artifacts
       where run_id = $1
       order by created_at asc`,
      [runId]
    );
    const runJob = await query<RunJobRow>(
      `select status, lease_owner, leased_at::text, lease_expires_at::text
       from run_jobs
       where run_id = $1`,
      [runId]
    );
    const latestEvent = await query<LatestEventRow>(
      `select step, created_at::text
       from run_events
       where run_id = $1
       order by id desc
       limit 1`,
      [runId]
    );

    const preferredStorage: "local_fs" | "s3" = isS3Mode() ? "s3" : "local_fs";
    const zipArtifact = pickArtifact(artifacts.rows, "evidence.zip", preferredStorage);
    const manifestArtifact = pickArtifact(artifacts.rows, "manifest.json", preferredStorage);

    const storage =
      zipArtifact?.storage_type ?? manifestArtifact?.storage_type ?? "local_fs";
    const mode = evidenceUrlMode();

    let evidenceZipUrl: string | null = null;
    let evidenceManifestUrl: string | null = null;

    if (storage === "s3") {
      evidenceZipUrl = await resolveS3Url(zipArtifact);
      evidenceManifestUrl = await resolveS3Url(manifestArtifact);
    }

    const apiBase = resolveApiBaseUrl(req);

    if (!evidenceZipUrl) {
      evidenceZipUrl = `${apiBase}/runs/${run.id}/evidence.zip`;
    }

    if (!evidenceManifestUrl) {
      evidenceManifestUrl = `${apiBase}/runs/${run.id}/evidence.manifest`;
    }

    return res.json({
      id: run.id,
      campaignId: run.campaign_id,
      status: run.status,
      confidenceScore: run.confidence_score,
      evidencePath: run.evidence_path,
      branchName: run.branch_name,
      prUrl: run.pr_url,
      prNumber: run.pr_number,
      prState: run.pr_state,
      prOpenedAt: run.pr_opened_at,
      mergedAt: run.merged_at,
      closedAt: run.closed_at,
      lastCiState: run.last_ci_state,
      lastCiCheckedAt: run.last_ci_checked_at,
      evidenceZipUrl,
      evidenceManifestUrl,
      evidenceUrlMode: storage === "s3" ? mode : "local_proxy",
      evidenceStorage: storage,
      queueStatus: runJob.rows[0]?.status ?? "completed",
      cancelRequestedAt:
        typeof run.summary?.cancelRequestedAt === "string"
          ? run.summary.cancelRequestedAt
          : null,
      lease: runJob.rows[0]
        ? {
            owner: runJob.rows[0].lease_owner,
            leasedAt: runJob.rows[0].leased_at,
            leaseExpiresAt: runJob.rows[0].lease_expires_at
          }
        : null,
      currentStep: latestEvent.rows[0]?.step ?? null,
      lastEventAt: latestEvent.rows[0]?.created_at ?? null,
      summary: run.summary,
      evidenceArtifacts: artifacts.rows
    });
  });

  router.get("/runs/:id/events", async (req, res) => {
    const runId = req.params.id;
    const afterIdRaw = req.query.afterId as string | undefined;
    const limitRaw = req.query.limit as string | undefined;

    const afterId = Math.max(0, Number(afterIdRaw ?? "0") || 0);
    const limit = Math.min(500, Math.max(1, Number(limitRaw ?? "100") || 100));

    const runQuery = await query<RunRow>(
      `select id,
              campaign_id,
              status,
              confidence_score,
              evidence_path,
              branch_name,
              pr_url,
              pr_number,
              pr_state,
              pr_opened_at::text,
              merged_at::text,
              closed_at::text,
              last_ci_state,
              last_ci_checked_at::text,
              summary
       from runs where id = $1`,
      [runId]
    );
    if (!runQuery.rows[0]) {
      return res.status(404).json({ error: "run not found" });
    }

    const events = await query<EventRow>(
      `select id,
              run_id,
              level,
              event_type,
              step,
              message,
              payload,
              created_at::text
       from run_events
       where run_id = $1
         and id > $2
       order by id asc
       limit $3`,
      [runId, afterId, limit]
    );

    const mapped = events.rows.map((event) => ({
      id: Number(event.id),
      runId: event.run_id,
      level: event.level,
      eventType: event.event_type,
      step: event.step,
      message: event.message,
      payload: event.payload ?? {},
      createdAt: event.created_at
    }));

    const nextAfterId = mapped.length > 0 ? mapped[mapped.length - 1].id : afterId;
    return res.json({
      runId,
      events: mapped,
      nextAfterId
    });
  });

  router.get("/runs/:id/evidence.zip", async (req, res) => {
    const runId = req.params.id;

    const runQuery = await query<RunRow>(
      `select id, evidence_path
       from runs where id = $1`,
      [runId]
    );

    const run = runQuery.rows[0];
    if (!run) {
      return res.status(404).json({ error: "run not found" });
    }

    const artifacts = await query<ArtifactRow>(
      `select type, path, storage_type, bucket, object_key
       from evidence_artifacts
       where run_id = $1 and type = 'evidence.zip'
       order by created_at desc`,
      [runId]
    );

    const preferredStorage: "local_fs" | "s3" = isS3Mode() ? "s3" : "local_fs";
    const zipArtifact = pickArtifact(artifacts.rows, "evidence.zip", preferredStorage);

    if (!zipArtifact) {
      return res.status(404).json({ error: "evidence zip not found" });
    }

    if (zipArtifact.storage_type === "s3") {
      const remoteUrl = await resolveS3Url(zipArtifact);
      if (remoteUrl) {
        return res.redirect(302, remoteUrl);
      }

      const proxied = await streamFromS3Artifact({
        artifact: zipArtifact,
        contentType: "application/zip",
        fileName: `${runId}-evidence.zip`,
        res
      });
      if (proxied) {
        return;
      }
    }

    await streamFile({
      path: zipArtifact.path,
      contentType: "application/zip",
      fileName: `${runId}-evidence.zip`,
      res
    });
  });

  router.get("/runs/:id/evidence.manifest", async (req, res) => {
    const runId = req.params.id;

    const runQuery = await query<RunRow>(
      `select id, evidence_path
       from runs where id = $1`,
      [runId]
    );

    const run = runQuery.rows[0];
    if (!run) {
      return res.status(404).json({ error: "run not found" });
    }

    const artifacts = await query<ArtifactRow>(
      `select type, path, storage_type, bucket, object_key
       from evidence_artifacts
       where run_id = $1 and type = 'manifest.json'
       order by created_at desc`,
      [runId]
    );

    const preferredStorage: "local_fs" | "s3" = isS3Mode() ? "s3" : "local_fs";
    const manifestArtifact = pickArtifact(artifacts.rows, "manifest.json", preferredStorage);

    if (manifestArtifact?.storage_type === "s3") {
      const remoteUrl = await resolveS3Url(manifestArtifact);
      if (remoteUrl) {
        return res.redirect(302, remoteUrl);
      }

      const proxied = await streamFromS3Artifact({
        artifact: manifestArtifact,
        contentType: "application/json",
        res
      });
      if (proxied) {
        return;
      }
    }

    const localManifestPath = manifestArtifact?.path ?? (run.evidence_path ? join(run.evidence_path, "manifest.json") : null);
    if (!localManifestPath) {
      return res.status(404).json({ error: "evidence manifest not found" });
    }

    await streamFile({
      path: localManifestPath,
      contentType: "application/json",
      res
    });
  });

  return router;
}
