import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { executeWorkflow } from "@code-porter/core/src/workflow/index.js";
import type { Campaign, Project, Run, RunMode, RunStatus } from "@code-porter/core/src/models.js";
import { FileEvidenceWriter } from "@code-porter/evidence/src/writer.js";
import { StubKnowledgePublisher } from "@code-porter/knowledge/src/publisher.js";
import { DefaultRecipeEngine } from "@code-porter/recipes/src/engine.js";
import { MavenCompilerTarget17Recipe } from "@code-porter/recipes/src/recipes/maven-compiler-target17.js";
import { MavenSurefireSafeRecipe } from "@code-porter/recipes/src/recipes/maven-surefire-safe.js";
import { DefaultVerifier } from "@code-porter/verifier/src/index.js";
import { query } from "./db/client.js";

interface CampaignWithProject {
  campaign_id: string;
  campaign_created_at: string;
  policy_id: string;
  recipe_pack: string;
  target_selector: string | null;
  project_id: string;
  project_name: string;
  local_path: string;
  project_created_at: string;
  policy_config_path: string;
}

function buildRunEvidencePath(projectId: string, campaignId: string, runId: string): string {
  const evidenceRoot = process.env.EVIDENCE_ROOT ?? "./evidence";
  return resolve(process.cwd(), evidenceRoot, projectId, campaignId, runId);
}

function createRun(campaignId: string, mode: RunMode): Run {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    campaignId,
    mode,
    status: "running",
    evidencePath: "",
    startedAt: now
  };
}

function rowToProject(row: CampaignWithProject): Project {
  return {
    id: row.project_id,
    name: row.project_name,
    localPath: row.local_path,
    createdAt: row.project_created_at
  };
}

function rowToCampaign(row: CampaignWithProject): Campaign {
  return {
    id: row.campaign_id,
    projectId: row.project_id,
    policyId: row.policy_id,
    recipePack: row.recipe_pack,
    targetSelector: row.target_selector ?? undefined,
    createdAt: row.campaign_created_at
  };
}

async function loadCampaignContext(campaignId: string): Promise<CampaignWithProject | null> {
  const { rows } = await query<CampaignWithProject>(
    `select
       c.id as campaign_id,
       c.created_at::text as campaign_created_at,
       c.policy_id,
       c.recipe_pack,
       c.target_selector,
       p.id as project_id,
       p.name as project_name,
       p.local_path,
       p.created_at::text as project_created_at,
       pol.config_path as policy_config_path
     from campaigns c
     join projects p on p.id = c.project_id
     join policies pol on pol.id = c.policy_id
     where c.id = $1`,
    [campaignId]
  );

  return rows[0] ?? null;
}

export async function executeCampaignRun(campaignId: string, mode: RunMode): Promise<{ runId: string; status: RunStatus }> {
  const context = await loadCampaignContext(campaignId);
  if (!context) {
    throw new Error(`Campaign '${campaignId}' not found`);
  }

  const run = createRun(campaignId, mode);
  const runEvidencePath = buildRunEvidencePath(context.project_id, context.campaign_id, run.id);

  await query(
    `insert into runs (id, campaign_id, mode, status, evidence_path, started_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [run.id, campaignId, mode, "running", runEvidencePath, run.startedAt]
  );

  const project = rowToProject(context);
  const campaign = rowToCampaign(context);

  const recipeEngine = new DefaultRecipeEngine([
    new MavenCompilerTarget17Recipe(),
    new MavenSurefireSafeRecipe()
  ]);

  const evidenceRoot = resolve(process.cwd(), process.env.EVIDENCE_ROOT ?? "./evidence");

  try {
    const result = await executeWorkflow({
      project,
      campaign,
      run,
      mode,
      policyPath: resolve(process.cwd(), context.policy_config_path),
      evidenceRoot,
      recipeEngine,
      verifier: new DefaultVerifier(),
      evidenceWriter: new FileEvidenceWriter(evidenceRoot),
      knowledgePublisher: new StubKnowledgePublisher()
    });

    await query(
      `update runs
       set status = $2,
           confidence_score = $3,
           evidence_path = $4,
           branch_name = $5,
           summary = $6::jsonb,
           finished_at = now()
       where id = $1`,
      [
        run.id,
        result.status,
        result.confidenceScore.score,
        runEvidencePath,
        result.branchName ?? null,
        JSON.stringify(result.summary)
      ]
    );

    for (const artifact of result.manifest.artifacts) {
      await query(
        `insert into evidence_artifacts (id, run_id, type, path, sha256)
         values ($1, $2, $3, $4, $5)`,
        [randomUUID(), run.id, artifact.type, artifact.path, artifact.sha256]
      );
    }

    return {
      runId: run.id,
      status: result.status
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workflow execution failed";

    await query(
      `update runs
       set status = $2,
           summary = $3::jsonb,
           finished_at = now()
       where id = $1`,
      [run.id, "failed", JSON.stringify({ error: message })]
    );

    return {
      runId: run.id,
      status: "failed"
    };
  }
}
