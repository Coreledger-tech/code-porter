import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { executeWorkflow } from "@code-porter/core/src/workflow/index.js";
import type {
  Campaign,
  Project,
  Run,
  RunFailureKind,
  RunMode,
  RunStatus
} from "@code-porter/core/src/models.js";
import type { PreparedWorkspace, WorkspaceCleanupPolicy } from "@code-porter/core/src/workflow-runner.js";
import {
  FileEvidenceWriter,
  LocalEvidenceStore,
  ZipEvidenceStore
} from "@code-porter/evidence/src/index.js";
import { StubKnowledgePublisher } from "@code-porter/knowledge/src/publisher.js";
import { DefaultRecipeEngine } from "@code-porter/recipes/src/engine.js";
import { MavenCompilerPluginBumpRecipe } from "@code-porter/recipes/src/recipes/maven-compiler-plugin-bump.js";
import { MavenCompilerTarget17Recipe } from "@code-porter/recipes/src/recipes/maven-compiler-target17.js";
import { MavenSurefireSafeRecipe } from "@code-porter/recipes/src/recipes/maven-surefire-safe.js";
import {
  DefaultVerifier,
  MavenDeterministicRemediator
} from "@code-porter/verifier/src/index.js";
import {
  GitHubPRProvider,
  GitHubRepoProvider,
  LocalRepoProvider,
  RepoOperationError,
  WorkspaceManager
} from "@code-porter/workspace/src/index.js";
import { query } from "./db/client.js";

interface CampaignWithProject {
  campaign_id: string;
  campaign_created_at: string;
  policy_id: string;
  recipe_pack: string;
  target_selector: string | null;
  project_id: string;
  project_name: string;
  project_type: "local" | "github";
  local_path: string | null;
  owner: string | null;
  repo: string | null;
  clone_url: string | null;
  default_branch: string | null;
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
    type: row.project_type,
    localPath: row.local_path ?? undefined,
    owner: row.owner ?? undefined,
    repo: row.repo ?? undefined,
    cloneUrl: row.clone_url ?? undefined,
    defaultBranch: row.default_branch ?? undefined,
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
       p.type as project_type,
       p.local_path,
       p.owner,
       p.repo,
       p.clone_url,
       p.default_branch,
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

function getWorkspaceCleanupPolicy(): WorkspaceCleanupPolicy {
  const raw = process.env.WORKSPACE_CLEANUP_POLICY ?? "delete_on_success_keep_on_failure";
  if (
    raw === "always_delete" ||
    raw === "always_keep" ||
    raw === "delete_on_success_keep_on_failure"
  ) {
    return raw;
  }
  return "delete_on_success_keep_on_failure";
}

function mapFailure(error: unknown): {
  status: RunStatus;
  failureKind?: RunFailureKind;
  message: string;
} {
  if (error instanceof RepoOperationError) {
    return {
      status: "blocked",
      failureKind: error.failureKind,
      message: error.message
    };
  }

  const message = error instanceof Error ? error.message : "Workflow execution failed";
  if (message.toLowerCase().startsWith("apply blocked:")) {
    return {
      status: "blocked",
      failureKind: "workspace_prepare",
      message
    };
  }

  return {
    status: "failed",
    message
  };
}

function extractApplySummary(summary: Record<string, unknown>): {
  changedFiles: number;
  changedLines: number;
  recipesApplied: string[];
  commitAfter?: string;
} {
  const applySummary = (summary.applySummary ?? {}) as Record<string, unknown>;
  return {
    changedFiles: Number(summary.changedFiles ?? applySummary.changedFiles ?? 0),
    changedLines: Number(summary.changedLines ?? applySummary.changedLines ?? 0),
    recipesApplied: Array.isArray(applySummary.recipesApplied)
      ? (applySummary.recipesApplied.filter((value): value is string => typeof value === "string"))
      : [],
    commitAfter:
      typeof applySummary.commitAfter === "string" ? applySummary.commitAfter : undefined
  };
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
    new MavenCompilerPluginBumpRecipe(),
    new MavenSurefireSafeRecipe()
  ]);

  const evidenceRoot = resolve(process.cwd(), process.env.EVIDENCE_ROOT ?? "./evidence");
  const evidenceExportRoot = resolve(
    process.cwd(),
    process.env.EVIDENCE_EXPORT_ROOT ?? "./evidence-exports"
  );
  const workspaceRoot = resolve(process.cwd(), process.env.WORKSPACE_ROOT ?? "./workspaces");
  const workspaceManager = new WorkspaceManager(workspaceRoot);

  const useDeterministicRemediator =
    process.env.ENABLE_DETERMINISTIC_REMEDIATOR === "true";
  const remediator = useDeterministicRemediator
    ? new MavenDeterministicRemediator()
    : undefined;

  const evidenceWriter = new FileEvidenceWriter(evidenceRoot);
  const evidenceStore = new ZipEvidenceStore(
    new LocalEvidenceStore(evidenceWriter),
    evidenceExportRoot
  );

  const repoProvider =
    project.type === "github"
      ? new GitHubRepoProvider(workspaceManager)
      : new LocalRepoProvider(workspaceManager);

  let preparedWorkspace: PreparedWorkspace | undefined;
  let finalStatus: RunStatus = "failed";
  let finalSummary: Record<string, unknown> = {};
  let finalConfidenceScore: number | null = null;
  let finalBranchName: string | null = null;
  let finalPrUrl: string | null = null;
  let manifestArtifacts:
    | Array<{
        type: string;
        path: string;
        sha256: string;
      }>
    | undefined;

  try {
    preparedWorkspace = await repoProvider.prepareWorkspace({
      project,
      runId: run.id,
      campaignId: campaign.id,
      mode,
      baseRefHint: campaign.targetSelector
    });
    const workspace = preparedWorkspace;

    if (mode === "apply") {
      workspace.branchName = await workspaceManager.createBranch(
        workspace.workspacePath,
        campaign.id,
        run.id
      );
    }

    const result = await executeWorkflow({
      project,
      campaign,
      run,
      mode,
      policyPath: resolve(process.cwd(), context.policy_config_path),
      evidenceRoot,
      workingRepoPath: workspace.workspacePath,
      workspace,
      recipeEngine,
      verifier: new DefaultVerifier(),
      evidenceWriter,
      evidenceStore,
      knowledgePublisher: new StubKnowledgePublisher(),
      remediator
    });

    workspace.commitAfter =
      typeof result.summary.applySummary === "object" &&
      result.summary.applySummary !== null &&
      typeof (result.summary.applySummary as Record<string, unknown>).commitAfter === "string"
        ? ((result.summary.applySummary as Record<string, unknown>).commitAfter as string)
        : undefined;

    finalStatus = result.status;
    finalSummary = { ...result.summary };
    finalConfidenceScore = result.confidenceScore?.score ?? null;
    finalBranchName = result.branchName ?? workspace.branchName ?? null;
    manifestArtifacts = [
      ...result.manifest.artifacts.map((artifact) => ({
        type: artifact.type,
        path: artifact.path,
        sha256: artifact.sha256
      })),
      ...((result.manifest.exports ?? []).map((artifact) => ({
        type: artifact.type,
        path: artifact.path,
        sha256: artifact.sha256
      })))
    ];

    if (project.type === "github" && mode === "apply" && finalBranchName) {
      const apply = extractApplySummary(result.summary);

      if (apply.commitAfter) {
        const prProvider = new GitHubPRProvider();
        const pr = await prProvider.createPullRequest({
          project,
          workspacePath: workspace.workspacePath,
          branchName: finalBranchName,
          baseBranch: workspace.defaultBranch,
          runId: run.id,
          summary: result.summary,
          changedFiles: apply.changedFiles,
          changedLines: apply.changedLines,
          recipesApplied: apply.recipesApplied,
          confidenceScore: finalConfidenceScore,
          blockedReason:
            typeof result.summary.blockedReason === "string"
              ? result.summary.blockedReason
              : undefined
        });

        finalPrUrl = pr.prUrl;
        finalSummary.prUrl = pr.prUrl;
      }
    }
  } catch (error) {
    const mapped = mapFailure(error);
    finalStatus = mapped.status;
    finalConfidenceScore = null;
    finalSummary = {
      status: mapped.status,
      error: mapped.message,
      ...(mapped.failureKind ? { failureKind: mapped.failureKind } : {}),
      ...(mapped.status === "blocked" ? { blockedReason: mapped.message } : {})
    };
  } finally {
    if (preparedWorkspace) {
      try {
        await workspaceManager.cleanupWorkspace({
          workspacePath: preparedWorkspace.workspacePath,
          status: finalStatus,
          policy: getWorkspaceCleanupPolicy()
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "workspace cleanup failed";
        finalSummary.workspaceCleanupWarning = message;
      }
    }
  }

  await query(
    `update runs
     set status = $2,
         confidence_score = $3,
         evidence_path = $4,
         branch_name = $5,
         pr_url = $6,
         summary = $7::jsonb,
         finished_at = now()
     where id = $1`,
    [
      run.id,
      finalStatus,
      finalConfidenceScore,
      runEvidencePath,
      finalBranchName,
      finalPrUrl,
      JSON.stringify(finalSummary)
    ]
  );

  if (manifestArtifacts) {
    for (const artifact of manifestArtifacts) {
      await query(
        `insert into evidence_artifacts (id, run_id, type, path, sha256)
         values ($1, $2, $3, $4, $5)`,
        [randomUUID(), run.id, artifact.type, artifact.path, artifact.sha256]
      );
    }
  }

  return {
    runId: run.id,
    status: finalStatus
  };
}
