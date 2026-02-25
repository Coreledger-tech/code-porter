import { Router } from "express";
import { query } from "../db/client.js";

interface RunRow {
  id: string;
  campaign_id: string;
  status: string;
  confidence_score: number | null;
  evidence_path: string | null;
  branch_name: string | null;
  summary: Record<string, unknown>;
}

interface ArtifactRow {
  type: string;
  path: string;
}

export function runsRouter(): Router {
  const router = Router();

  router.get("/runs/:id", async (req, res) => {
    const runId = req.params.id;

    const runQuery = await query<RunRow>(
      `select id, campaign_id, status, confidence_score, evidence_path, branch_name, summary
       from runs where id = $1`,
      [runId]
    );

    const run = runQuery.rows[0];
    if (!run) {
      return res.status(404).json({ error: "run not found" });
    }

    const artifacts = await query<ArtifactRow>(
      `select type, path
       from evidence_artifacts
       where run_id = $1
       order by created_at asc`,
      [runId]
    );

    return res.json({
      id: run.id,
      campaignId: run.campaign_id,
      status: run.status,
      confidenceScore: run.confidence_score,
      evidencePath: run.evidence_path,
      branchName: run.branch_name,
      summary: run.summary,
      evidenceArtifacts: artifacts.rows
    });
  });

  return router;
}
