import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { executeWorkflow } from "@code-porter/core/src/workflow/index.js";
import { YamlPolicyEngine } from "@code-porter/core/src/policy.js";
import type {
  Campaign,
  RunEventLevel,
  RunEventType,
  Project,
  Run,
  RunFailureKind,
  RunMode,
  RunStatus
} from "@code-porter/core/src/models.js";
import type { EvidenceStorePort, PreparedWorkspace, WorkspaceCleanupPolicy } from "@code-porter/core/src/workflow-runner.js";
import {
  EvidenceBudgetExceededError,
  FileEvidenceWriter,
  LocalEvidenceStore,
  S3CompatibleEvidenceStore,
  isS3Mode,
  ZipEvidenceStore
} from "@code-porter/evidence/src/index.js";
import {
  createSemanticRetrievalProviderFromEnv,
  StubKnowledgePublisher
} from "@code-porter/knowledge/src/index.js";
import { DefaultRecipeEngine } from "@code-porter/recipes/src/engine.js";
import type { Recipe } from "@code-porter/recipes/src/types.js";
import { MavenCompilerPluginBumpRecipe } from "@code-porter/recipes/src/recipes/maven-compiler-plugin-bump.js";
import { MavenCompilerTarget17Recipe } from "@code-porter/recipes/src/recipes/maven-compiler-target17.js";
import { MavenFailsafeSafeRecipe } from "@code-porter/recipes/src/recipes/maven-failsafe-safe.js";
import { MavenJarPluginBumpRecipe } from "@code-porter/recipes/src/recipes/maven-jar-plugin-bump.js";
import { MavenLombokPluginJava17BumpRecipe } from "@code-porter/recipes/src/recipes/maven-lombok-plugin-java17-bump.js";
import { MavenLombokDelombokPreparePackageRecipe } from "@code-porter/recipes/src/recipes/maven-lombok-delombok-prepare-package.js";
import { MavenNashornIgnoreImportRewriteRecipe } from "@code-porter/recipes/src/recipes/maven-nashorn-ignore-import-rewrite.js";
import { MavenJunitIgnoreCompatRecipe } from "@code-porter/recipes/src/recipes/maven-junit-ignore-compat.js";
import { MavenNashornNamespaceRewriteRecipe } from "@code-porter/recipes/src/recipes/maven-nashorn-namespace-rewrite.js";
import { MavenNashornCoreTestDependencyRecipe } from "@code-porter/recipes/src/recipes/maven-nashorn-core-test-dependency.js";
import { MavenJunitIgnoreCompatV2Recipe } from "@code-porter/recipes/src/recipes/maven-junit-ignore-compat-v2.js";
import { MavenSurefireSafeRecipe } from "@code-porter/recipes/src/recipes/maven-surefire-safe.js";
import {
  CompositeDeterministicRemediator,
  DefaultVerifier,
  MavenCompileDeterministicRemediator,
  MavenDeterministicRemediator,
  MavenTestRuntimeDeterministicRemediator
} from "@code-porter/verifier/src/index.js";
import { GradleJava17BaselineRecipe } from "@code-porter/recipes/src/recipes/gradle-java17-baseline.js";
import { GradleWrapperJava17MinRecipe } from "@code-porter/recipes/src/recipes/gradle-wrapper-java17-min.js";
import { GradleGuardedPropertiesBaselineRecipe } from "@code-porter/recipes/src/recipes/gradle-guarded-properties-baseline.js";
import {
  createGitHubAuthProvider,
  GitHubPRProvider,
  GitHubRepoProvider,
  LocalRepoProvider,
  RepoOperationError,
  WorkspaceManager
} from "@code-porter/workspace/src/index.js";
import { metrics } from "./observability/metrics.js";
import { logError, logInfo, logWarn } from "./observability/logger.js";
import { redactSecrets, redactUnknown } from "./observability/redact.js";
import { query } from "./db/client.js";
import { queueDepth } from "./run-queue.js";

interface CampaignWithProject {
  campaign_id: string;
  campaign_created_at: string;
  policy_id: string;
  recipe_pack: string;
  target_selector: string | null;
  lifecycle_status: "active" | "paused";
  paused_at: string | null;
  resumed_at: string | null;
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

interface RunExecutionContextRow extends CampaignWithProject {
  run_id: string;
  run_mode: RunMode;
  run_status: RunStatus;
  run_started_at: string;
  run_evidence_path: string | null;
  run_attempt_count: number;
  run_max_attempts: number;
}

interface CountRow {
  count: number;
}

interface RunEventRow {
  id: number;
}

interface RunStateRow {
  status: RunStatus;
  summary: Record<string, unknown>;
}

interface LeaseOwnerRow {
  lease_owner: string | null;
}

interface RunControlRow {
  id: string;
  mode: RunMode;
  status: RunStatus;
  summary: Record<string, unknown>;
}

interface RunJobStatusRow {
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
}

interface EventInsertInput {
  level: RunEventLevel;
  eventType: RunEventType;
  step?: string | null;
  message: string;
  payload?: Record<string, unknown>;
}

export class RunThrottleError extends Error {
  readonly limitType: "project" | "global";
  readonly currentInflight: number;
  readonly limit: number;
  readonly retryHint: string;

  constructor(input: {
    limitType: "project" | "global";
    currentInflight: number;
    limit: number;
    retryHint: string;
  }) {
    super(
      `${input.limitType} inflight limit exceeded (${input.currentInflight}/${input.limit})`
    );
    this.name = "RunThrottleError";
    this.limitType = input.limitType;
    this.currentInflight = input.currentInflight;
    this.limit = input.limit;
    this.retryHint = input.retryHint;
  }
}

export class CampaignPausedError extends Error {
  readonly campaignId: string;
  readonly lifecycleStatus: "paused";

  constructor(campaignId: string) {
    super(`Campaign '${campaignId}' is paused`);
    this.name = "CampaignPausedError";
    this.campaignId = campaignId;
    this.lifecycleStatus = "paused";
  }
}

class RunCancelledError extends Error {
  readonly reason?: string;

  constructor(message: string, reason?: string) {
    super(message);
    this.name = "RunCancelledError";
    this.reason = reason;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function parsePrNumberFromUrl(prUrl: string): number | null {
  const match = prUrl.match(/\/pull\/(\d+)(?:\/.*)?$/i);
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  return Number.isInteger(value) ? value : null;
}

const DEFAULT_RECIPE_PACK = "java-maven-plugin-modernize";

function buildJavaMavenCoreRecipes(): Recipe[] {
  return [
    new MavenCompilerTarget17Recipe(),
    new MavenCompilerPluginBumpRecipe(),
    new MavenSurefireSafeRecipe()
  ];
}

function buildJavaMavenPluginModernizeRecipes(): Recipe[] {
  return [
    new MavenCompilerTarget17Recipe(),
    new MavenCompilerPluginBumpRecipe(),
    new MavenSurefireSafeRecipe(),
    new MavenFailsafeSafeRecipe(),
    new MavenJarPluginBumpRecipe()
  ];
}

function buildJavaMavenLombokJava17Recipes(): Recipe[] {
  return [
    new MavenCompilerTarget17Recipe(),
    new MavenCompilerPluginBumpRecipe(),
    new MavenLombokPluginJava17BumpRecipe(),
    new MavenSurefireSafeRecipe(),
    new MavenFailsafeSafeRecipe(),
    new MavenJarPluginBumpRecipe()
  ];
}

function buildJavaMavenLombokDelombokCompatRecipes(): Recipe[] {
  return [
    new MavenCompilerTarget17Recipe(),
    new MavenCompilerPluginBumpRecipe(),
    new MavenLombokPluginJava17BumpRecipe(),
    new MavenLombokDelombokPreparePackageRecipe(),
    new MavenSurefireSafeRecipe(),
    new MavenFailsafeSafeRecipe(),
    new MavenJarPluginBumpRecipe()
  ];
}

function buildJavaMavenTestCompatRecipes(): Recipe[] {
  return [
    new MavenCompilerTarget17Recipe(),
    new MavenCompilerPluginBumpRecipe(),
    new MavenLombokPluginJava17BumpRecipe(),
    new MavenLombokDelombokPreparePackageRecipe(),
    new MavenNashornIgnoreImportRewriteRecipe(),
    new MavenJunitIgnoreCompatRecipe(),
    new MavenSurefireSafeRecipe(),
    new MavenFailsafeSafeRecipe(),
    new MavenJarPluginBumpRecipe()
  ];
}

function buildJavaMavenTestCompatV2Recipes(): Recipe[] {
  return [
    new MavenCompilerTarget17Recipe(),
    new MavenCompilerPluginBumpRecipe(),
    new MavenLombokPluginJava17BumpRecipe(),
    new MavenLombokDelombokPreparePackageRecipe(),
    new MavenNashornNamespaceRewriteRecipe(),
    new MavenJunitIgnoreCompatV2Recipe(),
    new MavenNashornCoreTestDependencyRecipe(),
    new MavenSurefireSafeRecipe(),
    new MavenFailsafeSafeRecipe(),
    new MavenJarPluginBumpRecipe()
  ];
}

function buildJavaGradleJava17BaselineRecipes(): Recipe[] {
  return [new GradleWrapperJava17MinRecipe(), new GradleJava17BaselineRecipe()];
}

function buildJavaGradleGuardedBaselineRecipes(): Recipe[] {
  return [new GradleWrapperJava17MinRecipe(), new GradleGuardedPropertiesBaselineRecipe()];
}

const RECIPE_PACK_FACTORIES: Record<string, () => Recipe[]> = {
  "java-maven-core": buildJavaMavenCoreRecipes,
  "java-maven-plugin-modernize": buildJavaMavenPluginModernizeRecipes,
  "java-maven-lombok-java17-pack": buildJavaMavenLombokJava17Recipes,
  "java-maven-lombok-delombok-compat-pack": buildJavaMavenLombokDelombokCompatRecipes,
  "java-maven-test-compat-pack": buildJavaMavenTestCompatRecipes,
  "java-maven-test-compat-v2-pack": buildJavaMavenTestCompatV2Recipes,
  "java-gradle-java17-baseline-pack": buildJavaGradleJava17BaselineRecipes,
  "java-gradle-guarded-baseline-pack": buildJavaGradleGuardedBaselineRecipes
};

export function listSupportedRecipePacks(): string[] {
  return Object.keys(RECIPE_PACK_FACTORIES);
}

export function defaultRecipePackId(): string {
  return DEFAULT_RECIPE_PACK;
}

function createRecipeEngineForPack(recipePack: string): DefaultRecipeEngine {
  const factory = RECIPE_PACK_FACTORIES[recipePack];
  if (!factory) {
    throw new RepoOperationError(
      `Unsupported recipe pack '${recipePack}'. Supported packs: ${listSupportedRecipePacks().join(", ")}`,
      "workspace_prepare"
    );
  }
  return new DefaultRecipeEngine(factory());
}

function buildRunEvidencePath(projectId: string, campaignId: string, runId: string): string {
  const evidenceRoot = process.env.EVIDENCE_ROOT ?? "./evidence";
  return resolve(process.cwd(), evidenceRoot, projectId, campaignId, runId);
}

function createQueuedRun(campaignId: string, mode: RunMode): Run {
  const now = nowIso();
  return {
    id: randomUUID(),
    campaignId,
    mode,
    status: "queued",
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
    lifecycleStatus: row.lifecycle_status,
    pausedAt: row.paused_at ?? undefined,
    resumedAt: row.resumed_at ?? undefined,
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
       c.lifecycle_status,
       c.paused_at::text,
       c.resumed_at::text,
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

async function loadRunExecutionContext(runId: string): Promise<RunExecutionContextRow | null> {
  const { rows } = await query<RunExecutionContextRow>(
    `select
       r.id as run_id,
       r.mode as run_mode,
       r.status as run_status,
       r.started_at::text as run_started_at,
       r.evidence_path as run_evidence_path,
       coalesce(j.attempt_count, j.attempts, 0) as run_attempt_count,
       coalesce(j.max_attempts, 3) as run_max_attempts,
       c.id as campaign_id,
       c.created_at::text as campaign_created_at,
       c.policy_id,
       c.recipe_pack,
       c.target_selector,
       c.lifecycle_status,
       c.paused_at::text,
       c.resumed_at::text,
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
     from runs r
     join campaigns c on c.id = r.campaign_id
     join projects p on p.id = c.project_id
     join policies pol on pol.id = c.policy_id
     left join run_jobs j on j.run_id = r.id
     where r.id = $1`,
    [runId]
  );

  return rows[0] ?? null;
}

async function countInflightRuns(projectId: string): Promise<{
  globalInflight: number;
  projectInflight: number;
}> {
  const [global, project] = await Promise.all([
    query<CountRow>(
      `select count(*)::int as count
       from runs
       where status in ('queued', 'running', 'cancelling')`
    ),
    query<CountRow>(
      `select count(*)::int as count
       from runs r
       join campaigns c on c.id = r.campaign_id
       where c.project_id = $1
         and r.status in ('queued', 'running', 'cancelling')`,
      [projectId]
    )
  ]);

  return {
    globalInflight: Number(global.rows[0]?.count ?? 0),
    projectInflight: Number(project.rows[0]?.count ?? 0)
  };
}

async function enforceInflightThrottle(context: CampaignWithProject): Promise<void> {
  const policyEngine = new YamlPolicyEngine();
  const policyPath = resolve(process.cwd(), context.policy_config_path);
  const policy = await policyEngine.load(policyPath);

  const inflight = await countInflightRuns(context.project_id);

  if (inflight.projectInflight >= policy.maxInflightRunsPerProject) {
    throw new RunThrottleError({
      limitType: "project",
      currentInflight: inflight.projectInflight,
      limit: policy.maxInflightRunsPerProject,
      retryHint: "Retry after one or more runs for this project finishes."
    });
  }

  if (inflight.globalInflight >= policy.maxInflightRunsGlobal) {
    throw new RunThrottleError({
      limitType: "global",
      currentInflight: inflight.globalInflight,
      limit: policy.maxInflightRunsGlobal,
      retryHint: "Retry after one or more in-flight runs finishes."
    });
  }
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
  eventPayload?: Record<string, unknown>;
} {
  if (error instanceof RunCancelledError) {
    return {
      status: "cancelled",
      failureKind: "cancelled",
      message: redactSecrets(error.message)
    };
  }

  if (error instanceof RepoOperationError) {
    return {
      status: "blocked",
      failureKind: error.failureKind,
      message: redactSecrets(error.message)
    };
  }

  if (error instanceof EvidenceBudgetExceededError) {
    return {
      status: "blocked",
      failureKind: "budget_guardrail",
      message: redactSecrets(error.message),
      eventPayload: {
        budgetKey: error.budgetKey,
        limit: error.limit,
        observed: error.observed,
        actionTaken: "blocked"
      }
    };
  }

  const message = redactSecrets(
    error instanceof Error ? error.message : "Workflow execution failed"
  );
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

export async function appendRunEvent(runId: string, event: EventInsertInput): Promise<number> {
  const payload = (redactUnknown(event.payload ?? {}) ?? {}) as Record<string, unknown>;
  const safeMessage = redactSecrets(event.message);

  const result = await query<RunEventRow>(
    `insert into run_events (run_id, level, event_type, step, message, payload)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     returning id`,
    [runId, event.level, event.eventType, event.step ?? null, safeMessage, JSON.stringify(payload)]
  );

  return Number(result.rows[0]?.id ?? 0);
}

async function getRunState(runId: string): Promise<RunStateRow | null> {
  const result = await query<RunStateRow>(
    `select status, summary
     from runs
     where id = $1`,
    [runId]
  );

  return result.rows[0] ?? null;
}

async function getRunCancellationState(runId: string): Promise<{
  cancelled: boolean;
  reason?: string;
}> {
  const state = await getRunState(runId);
  if (!state) {
    return { cancelled: false };
  }

  if (state.status !== "cancelling" && state.status !== "cancelled") {
    return { cancelled: false };
  }

  const reason =
    typeof state.summary?.cancelReason === "string"
      ? state.summary.cancelReason
      : undefined;
  return {
    cancelled: true,
    reason
  };
}

async function isRunLeaseOwnedByWorker(runId: string, workerId: string): Promise<boolean> {
  const result = await query<LeaseOwnerRow>(
    `select lease_owner
     from run_jobs
     where run_id = $1`,
    [runId]
  );

  const owner = result.rows[0]?.lease_owner;
  return owner === workerId;
}

export async function enqueueCampaignRun(campaignId: string, mode: RunMode): Promise<{ runId: string; status: RunStatus }> {
  const context = await loadCampaignContext(campaignId);
  if (!context) {
    throw new Error(`Campaign '${campaignId}' not found`);
  }

  if (context.lifecycle_status === "paused") {
    throw new CampaignPausedError(campaignId);
  }

  await enforceInflightThrottle(context);

  const run = createQueuedRun(campaignId, mode);
  const runEvidencePath = buildRunEvidencePath(context.project_id, context.campaign_id, run.id);

  await query(
    `insert into runs (id, campaign_id, mode, status, evidence_path, started_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [run.id, campaignId, mode, "queued", runEvidencePath, run.startedAt]
  );

  await query(
    `insert into run_jobs (
       run_id, campaign_id, mode, status,
       attempt_count, attempts, max_attempts,
       next_attempt_at, available_at
     )
     values ($1, $2, $3, 'queued', 0, 0, 3, now(), now())`,
    [run.id, campaignId, mode]
  );

  await appendRunEvent(run.id, {
    level: "info",
    eventType: "lifecycle",
    message: "Run enqueued",
    payload: {
      mode,
      campaignId,
      projectId: context.project_id
    }
  });

  metrics.incrementRunsEnqueued(mode);
  metrics.setQueueDepth(await queueDepth());
  logInfo("run_enqueued", "Run queued for async execution", {
    runId: run.id,
    campaignId,
    projectId: context.project_id
  }, { mode });

  return {
    runId: run.id,
    status: "queued"
  };
}

export async function pauseCampaign(campaignId: string): Promise<{
  campaignId: string;
  lifecycleStatus: "paused";
  pausedAt: string;
}> {
  const result = await query<{ paused_at: string }>(
    `update campaigns
     set lifecycle_status = 'paused',
         paused_at = now()
     where id = $1
     returning paused_at::text`,
    [campaignId]
  );

  const pausedAt = result.rows[0]?.paused_at;
  if (!pausedAt) {
    throw new Error(`Campaign '${campaignId}' not found`);
  }

  return {
    campaignId,
    lifecycleStatus: "paused",
    pausedAt
  };
}

export async function resumeCampaign(campaignId: string): Promise<{
  campaignId: string;
  lifecycleStatus: "active";
  resumedAt: string;
}> {
  const result = await query<{ resumed_at: string }>(
    `update campaigns
     set lifecycle_status = 'active',
         resumed_at = now()
     where id = $1
     returning resumed_at::text`,
    [campaignId]
  );

  const resumedAt = result.rows[0]?.resumed_at;
  if (!resumedAt) {
    throw new Error(`Campaign '${campaignId}' not found`);
  }

  return {
    campaignId,
    lifecycleStatus: "active",
    resumedAt
  };
}

export async function cancelRun(runId: string, reason?: string): Promise<{
  runId: string;
  status: RunStatus;
  queueStatus: "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  message?: string;
}> {
  const runResult = await query<RunControlRow>(
    `select id, mode, status, summary
     from runs
     where id = $1`,
    [runId]
  );
  const run = runResult.rows[0];
  if (!run) {
    throw new Error(`Run '${runId}' not found`);
  }

  const runJobResult = await query<RunJobStatusRow>(
    `select status
     from run_jobs
     where run_id = $1`,
    [runId]
  );
  const queueStatus = runJobResult.rows[0]?.status ?? "unknown";
  const now = nowIso();
  const terminalStatuses = new Set<RunStatus>([
    "completed",
    "needs_review",
    "blocked",
    "failed",
    "cancelled"
  ]);

  if (terminalStatuses.has(run.status)) {
    return {
      runId,
      status: run.status,
      queueStatus,
      message: "already terminal"
    };
  }

  const mergedSummary = {
    ...(run.summary ?? {}),
    cancelRequestedAt: now,
    cancelReason: reason ?? "cancel requested by operator"
  };

  if (run.status === "queued") {
    await query(
      `update runs
       set status = 'cancelled',
           summary = $2::jsonb,
           finished_at = now()
       where id = $1`,
      [runId, JSON.stringify(redactUnknown({ ...mergedSummary, cancelledAt: now }))]
    );
    await query(
      `update run_jobs
       set status = 'cancelled',
           lease_owner = null,
           leased_at = null,
           lease_expires_at = null,
           locked_by = null,
           locked_at = null,
           updated_at = now()
       where run_id = $1`,
      [runId]
    );
    await appendRunEvent(runId, {
      level: "warn",
      eventType: "lifecycle",
      step: "run",
      message: "Run cancelled while queued",
      payload: { reason: reason ?? "cancel requested by operator" }
    });
    metrics.incrementRunsCancelled(run.mode);
    return {
      runId,
      status: "cancelled",
      queueStatus: "cancelled"
    };
  }

  await query(
    `update runs
     set status = 'cancelling',
         summary = $2::jsonb
     where id = $1`,
    [runId, JSON.stringify(redactUnknown(mergedSummary))]
  );

  await appendRunEvent(runId, {
    level: "warn",
    eventType: "lifecycle",
    step: "run",
    message: "Run cancellation requested",
    payload: { reason: reason ?? "cancel requested by operator" }
  });

  return {
    runId,
    status: "cancelling",
    queueStatus
  };
}

export async function executeRunById(runId: string, workerId: string): Promise<{ runId: string; status: RunStatus }> {
  const context = await loadRunExecutionContext(runId);
  if (!context) {
    throw new Error(`Run '${runId}' not found`);
  }

  if (context.run_status === "cancelled") {
    return {
      runId: context.run_id,
      status: "cancelled"
    };
  }

  const project = rowToProject(context);
  const campaign = rowToCampaign(context);
  const run: Run = {
    id: context.run_id,
    campaignId: context.campaign_id,
    mode: context.run_mode,
    status: "running",
    startedAt: context.run_started_at,
    evidencePath: context.run_evidence_path ?? ""
  };

  if (context.run_status === "queued") {
    await query(
      `update runs
       set status = 'running'
       where id = $1 and status = 'queued'`,
      [runId]
    );
  }

  await appendRunEvent(runId, {
    level: "info",
    eventType: "lifecycle",
    message: "Worker started run execution",
    payload: {
      workerId,
      mode: run.mode
    }
  });

  logInfo("run_started", "Worker executing run", {
    runId,
    campaignId: campaign.id,
    projectId: project.id,
    workerId
  }, {
    mode: run.mode,
    attempt: context.run_attempt_count,
    maxAttempts: context.run_max_attempts
  });

  const recipePack = campaign.recipePack?.trim() || DEFAULT_RECIPE_PACK;
  const recipeEngine = createRecipeEngineForPack(recipePack);

  const evidenceRoot = resolve(process.cwd(), process.env.EVIDENCE_ROOT ?? "./evidence");
  const evidenceExportRoot = resolve(
    process.cwd(),
    process.env.EVIDENCE_EXPORT_ROOT ?? "./evidence-exports"
  );
  const workspaceRoot = resolve(process.cwd(), process.env.WORKSPACE_ROOT ?? "./workspaces");
  const workspaceManager = new WorkspaceManager(workspaceRoot);

  const remediator =
    process.env.ENABLE_DETERMINISTIC_REMEDIATOR === "false"
      ? undefined
      : new CompositeDeterministicRemediator([
          new MavenDeterministicRemediator(),
          new MavenCompileDeterministicRemediator(),
          new MavenTestRuntimeDeterministicRemediator()
        ]);

  const evidenceWriter = new FileEvidenceWriter(evidenceRoot);
  const semanticRetrievalProvider = createSemanticRetrievalProviderFromEnv();
  const baseEvidenceStore = new ZipEvidenceStore(
    new LocalEvidenceStore(evidenceWriter),
    evidenceExportRoot
  );
  let githubAuthProvider: ReturnType<typeof createGitHubAuthProvider> | undefined;
  let repoProvider: LocalRepoProvider | GitHubRepoProvider = new LocalRepoProvider(
    workspaceManager
  );

  let preparedWorkspace: PreparedWorkspace | undefined;
  let finalStatus: RunStatus = "failed";
  let finalSummary: Record<string, unknown> = {};
  let finalConfidenceScore: number | null = null;
  let finalBranchName: string | null = null;
  let finalPrUrl: string | null = null;
  let finalPrNumber: number | null = null;
  let finalPrState: "open" | "merged" | "closed" | null = null;
  let finalPrOpenedAt: string | null = null;
  let finalMergedAt: string | null = null;
  let finalClosedAt: string | null = null;
  let finalLastCiState: string | null = null;
  let finalLastCiCheckedAt: string | null = null;
  let manifestArtifacts:
    | Array<{
        type: string;
        path: string;
        sha256: string;
        storageType: "local_fs" | "s3";
        bucket: string | null;
        objectKey: string | null;
      }>
    | undefined;
  let workflowResult:
    | Awaited<ReturnType<typeof executeWorkflow>>
    | undefined;

  try {
    if (project.type === "github") {
      try {
        githubAuthProvider = createGitHubAuthProvider();
      } catch (error) {
        throw new RepoOperationError(
          error instanceof Error
            ? error.message
            : "GitHub authentication configuration is invalid",
          "auth"
        );
      }
      repoProvider = new GitHubRepoProvider(workspaceManager, githubAuthProvider);
    }

    let evidenceStore: EvidenceStorePort = baseEvidenceStore;
    if (isS3Mode()) {
      const s3Store = S3CompatibleEvidenceStore.fromEnv(baseEvidenceStore);
      if (!s3Store) {
        throw new Error(
          "EVIDENCE_STORE_MODE is set to s3 but S3 configuration is incomplete"
        );
      }
      evidenceStore = s3Store;
    }

    preparedWorkspace = await repoProvider.prepareWorkspace({
      project,
      runId: run.id,
      campaignId: campaign.id,
      mode: run.mode,
      baseRefHint: campaign.targetSelector
    });
    const workspace = preparedWorkspace;

    if (run.mode === "apply") {
      workspace.branchName = await workspaceManager.createBranch(
        workspace.workspacePath,
        campaign.id,
        run.id
      );
    }

    const cancellationState = await getRunCancellationState(run.id);
    if (cancellationState.cancelled) {
      throw new RunCancelledError(
        "Run cancelled before workflow execution started",
        cancellationState.reason
      );
    }

    workflowResult = await executeWorkflow({
      project,
      campaign,
      run,
      mode: run.mode,
      policyPath: resolve(process.cwd(), context.policy_config_path),
      evidenceRoot,
      workingRepoPath: workspace.workspacePath,
      workspace,
      recipeEngine,
      verifier: new DefaultVerifier(),
      evidenceWriter,
      evidenceStore,
      knowledgePublisher: new StubKnowledgePublisher(),
      semanticRetrievalProvider,
      remediator,
      onStepEvent: async (event) => {
        const cancelled = await getRunCancellationState(run.id);
        if (cancelled.cancelled) {
          throw new RunCancelledError(
            "Run cancellation requested by operator",
            cancelled.reason
          );
        }

        await appendRunEvent(run.id, {
          level:
            event.eventType === "error"
              ? "error"
              : event.eventType === "warning"
                ? "warn"
                : "info",
          eventType: event.eventType,
          step: event.step,
          message: event.message,
          payload: event.payload
        });
      }
    });

    const cancellationAfterWorkflow = await getRunCancellationState(run.id);
    if (cancellationAfterWorkflow.cancelled) {
      throw new RunCancelledError(
        "Run cancellation requested by operator",
        cancellationAfterWorkflow.reason
      );
    }

    workspace.commitAfter =
      typeof workflowResult.summary.applySummary === "object" &&
      workflowResult.summary.applySummary !== null &&
      typeof (workflowResult.summary.applySummary as Record<string, unknown>).commitAfter === "string"
        ? ((workflowResult.summary.applySummary as Record<string, unknown>).commitAfter as string)
        : undefined;

    finalStatus = workflowResult.status;
    finalSummary = { ...workflowResult.summary };
    finalConfidenceScore = workflowResult.confidenceScore?.score ?? null;
    finalBranchName = workflowResult.branchName ?? workspace.branchName ?? null;
    manifestArtifacts = [
      ...workflowResult.manifest.artifacts.map((artifact) => ({
        type: artifact.type,
        path: artifact.path,
        sha256: artifact.sha256,
        storageType: "local_fs" as const,
        bucket: null,
        objectKey: null
      })),
      ...((workflowResult.manifest.exports ?? []).map((artifact) => ({
        type: artifact.type,
        path: artifact.path,
        sha256: artifact.sha256,
        storageType: artifact.storageType ?? "local_fs",
        bucket: artifact.bucket ?? null,
        objectKey: artifact.objectKey ?? null
      })))
    ];

    if (project.type === "github" && run.mode === "apply" && finalBranchName) {
      const cancellationBeforePr = await getRunCancellationState(run.id);
      if (cancellationBeforePr.cancelled) {
        throw new RunCancelledError(
          "Run cancellation requested by operator",
          cancellationBeforePr.reason
        );
      }

      const apply = extractApplySummary(workflowResult.summary);

      if (apply.commitAfter) {
        await appendRunEvent(run.id, {
          level: "info",
          eventType: "step_start",
          step: "pr_create",
          message: "Creating GitHub pull request"
        });

        const prProvider = new GitHubPRProvider(githubAuthProvider);
        const pr = await prProvider.createPullRequest({
          project,
          workspacePath: workspace.workspacePath,
          branchName: finalBranchName,
          baseBranch: workspace.defaultBranch,
          runId: run.id,
          summary: workflowResult.summary,
          changedFiles: apply.changedFiles,
          changedLines: apply.changedLines,
          recipesApplied: apply.recipesApplied,
          confidenceScore: finalConfidenceScore,
          blockedReason:
            typeof workflowResult.summary.blockedReason === "string"
              ? workflowResult.summary.blockedReason
              : undefined
        });

        finalPrUrl = pr.prUrl;
        finalPrNumber = pr.prNumber ?? parsePrNumberFromUrl(pr.prUrl);
        finalPrState = "open";
        finalPrOpenedAt = nowIso();
        finalSummary.prUrl = pr.prUrl;
        finalSummary.prState = "open";
        if (finalPrNumber !== null) {
          finalSummary.prNumber = finalPrNumber;
        }

        await appendRunEvent(run.id, {
          level: "info",
          eventType: "step_end",
          step: "pr_create",
          message: "GitHub pull request created",
          payload: {
            prUrl: pr.prUrl
          }
        });
      }
    }
  } catch (error) {
    const mapped = mapFailure(error);
    finalStatus = mapped.status;
    finalConfidenceScore = null;
    const existingState = await getRunState(run.id);
    const existingSummary =
      existingState?.summary && typeof existingState.summary === "object"
        ? existingState.summary
        : {};

    finalSummary = {
      ...existingSummary,
      status: mapped.status,
      ...(mapped.status === "cancelled"
        ? {
            cancelledAt: nowIso(),
            cancelReason:
              typeof (existingSummary as Record<string, unknown>).cancelReason === "string"
                ? (existingSummary as Record<string, unknown>).cancelReason
                : mapped.message
          }
        : {
            error: mapped.message
          }),
      ...(mapped.failureKind ? { failureKind: mapped.failureKind } : {}),
      ...(mapped.status === "blocked" ? { blockedReason: mapped.message } : {})
    };

    if (mapped.failureKind && mapped.failureKind !== "cancelled") {
      metrics.incrementRunFailure(mapped.failureKind);
    }

    await appendRunEvent(run.id, {
      level: mapped.status === "cancelled" ? "warn" : "error",
      eventType: mapped.status === "cancelled" ? "lifecycle" : "error",
      step: "run",
      message:
        mapped.status === "cancelled"
          ? "Run cancelled by operator request"
          : mapped.message,
      payload: {
        ...(mapped.failureKind ? { failureKind: mapped.failureKind } : {}),
        ...(mapped.eventPayload ?? {})
      }
    });
  } finally {
    if (preparedWorkspace) {
      try {
        await appendRunEvent(run.id, {
          level: "info",
          eventType: "step_start",
          step: "workspace_cleanup",
          message: "Cleaning up workspace"
        });

        await workspaceManager.cleanupWorkspace({
          workspacePath: preparedWorkspace.workspacePath,
          status: finalStatus,
          policy: getWorkspaceCleanupPolicy()
        });

        await appendRunEvent(run.id, {
          level: "info",
          eventType: "step_end",
          step: "workspace_cleanup",
          message: "Workspace cleanup completed"
        });
      } catch (error) {
        const message = redactSecrets(
          error instanceof Error ? error.message : "workspace cleanup failed"
        );
        finalSummary.workspaceCleanupWarning = message;
        await appendRunEvent(run.id, {
          level: "warn",
          eventType: "warning",
          step: "workspace_cleanup",
          message,
          payload: {
            failureKind: "workspace_cleanup"
          }
        });
      }
    }
  }

  const cancellationBeforeFinalize = await getRunCancellationState(run.id);
  if (cancellationBeforeFinalize.cancelled && finalStatus !== "cancelled") {
    finalStatus = "cancelled";
    finalConfidenceScore = null;
    finalSummary = {
      ...finalSummary,
      status: "cancelled",
      failureKind: "cancelled",
      cancelledAt: nowIso(),
      cancelReason:
        cancellationBeforeFinalize.reason ?? "cancel requested by operator"
    };
  }

  const leaseOwned = await isRunLeaseOwnedByWorker(run.id, workerId);
  if (!leaseOwned) {
    throw new Error("Worker lease ownership lost before run finalization");
  }

  await query(
    `update runs
     set status = $2,
         confidence_score = $3,
         evidence_path = $4,
         branch_name = $5,
         pr_url = $6,
         pr_number = $7,
         pr_state = $8,
         pr_opened_at = $9,
         merged_at = $10,
         closed_at = $11,
         last_ci_state = $12,
         last_ci_checked_at = $13,
         summary = $14::jsonb,
         finished_at = now()
     where id = $1
       and (
         status in ('queued', 'running', 'cancelling')
         or (status = 'cancelled' and $2 = 'cancelled')
       )`,
    [
      run.id,
      finalStatus,
      finalConfidenceScore,
      context.run_evidence_path,
      finalBranchName,
      finalPrUrl,
      finalPrNumber,
      finalPrState,
      finalPrOpenedAt,
      finalMergedAt,
      finalClosedAt,
      finalLastCiState,
      finalLastCiCheckedAt,
      JSON.stringify(redactUnknown(finalSummary))
    ]
  );

  if (manifestArtifacts) {
    for (const artifact of manifestArtifacts) {
      await query(
        `insert into evidence_artifacts (id, run_id, type, path, sha256, storage_type, bucket, object_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          run.id,
          artifact.type,
          artifact.path,
          artifact.sha256,
          artifact.storageType,
          artifact.bucket,
          artifact.objectKey
        ]
      );
    }
  }

  await appendRunEvent(run.id, {
    level: "info",
    eventType: "lifecycle",
    message: "Run finished",
    payload: {
      status: finalStatus,
      confidenceScore: finalConfidenceScore
    }
  });

  const durationSeconds =
    (Date.now() - new Date(run.startedAt).getTime()) / 1000;
  metrics.incrementRunOutcome(run.mode, finalStatus);
  metrics.observeRunDuration(run.mode, finalStatus, durationSeconds);

  if (workflowResult?.verifySummary) {
    const attempts = [
      ...(workflowResult.verifySummary.compile.attempts ?? []),
      ...(workflowResult.verifySummary.tests.attempts ?? [])
    ];
    for (const attempt of attempts) {
      if (attempt.retryReason) {
        metrics.incrementVerifierRetry(
          workflowResult.verifySummary.buildSystem,
          attempt.retryReason
        );
      }
    }
  }

  if (workflowResult?.remediationActions) {
    for (const action of workflowResult.remediationActions) {
      metrics.incrementRemediationAction(action.action, action.status);
    }
  }

  if (finalStatus === "failed") {
    const failureKind =
      typeof finalSummary.failureKind === "string"
        ? finalSummary.failureKind
        : "unknown";
    metrics.incrementRunFailure(failureKind);
  }

  logInfo("run_finished", "Run execution finished", {
    runId,
    campaignId: campaign.id,
    projectId: project.id,
    workerId,
    durationMs: Math.round(durationSeconds * 1000)
  }, {
    status: finalStatus,
    queueAttempt: context.run_attempt_count
  });

  return {
    runId: run.id,
    status: finalStatus
  };
}

export async function executeCampaignRun(campaignId: string, mode: RunMode): Promise<{ runId: string; status: RunStatus }> {
  return enqueueCampaignRun(campaignId, mode);
}
