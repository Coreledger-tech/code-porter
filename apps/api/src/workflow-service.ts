import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { executeWorkflow } from "@code-porter/core/src/workflow/index.js";
import { YamlPolicyEngine } from "@code-porter/core/src/policy.js";
import type {
  Campaign,
  MergeChecklistSummary,
  PullRequestMergeMethod,
  RunEventLevel,
  RunEventType,
  Project,
  Run,
  RunFailureKind,
  RunMode,
  RunStatus,
  ScanResult
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
  chooseKeeperCandidate,
  buildSupersededComment,
  inferChecklist,
  type KeeperCandidate
} from "./pr-keeper.js";
import {
  evaluateMergeChecklist,
  type MergeChecklistArtifact
} from "./merge-checklist.js";
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

interface KeeperCandidateRow {
  id: string;
  status: RunStatus;
  pr_url: string;
  pr_number: number | null;
  pr_state: "open" | "merged" | "closed" | null;
  finished_at: string | null;
  summary: Record<string, unknown>;
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

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveArtifactRoot(input: {
  evidenceRoot: string;
  projectId: string;
  campaignId: string;
  runId: string;
}): string {
  return resolve(input.evidenceRoot, input.projectId, input.campaignId, input.runId);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeKeeperSummary(summary: Record<string, unknown>): Record<string, unknown> {
  return {
    ...summary,
    keeperCandidate:
      typeof summary.keeperCandidate === "boolean" ? summary.keeperCandidate : false,
    keeperChosen:
      typeof summary.keeperChosen === "boolean" ? summary.keeperChosen : false,
    keeperMerged:
      typeof summary.keeperMerged === "boolean" ? summary.keeperMerged : false,
    mergeReady:
      typeof summary.mergeReady === "boolean" ? summary.mergeReady : false,
    supersededByPrNumber:
      typeof summary.supersededByPrNumber === "number" ? summary.supersededByPrNumber : null,
    supersededClosedCount:
      typeof summary.supersededClosedCount === "number" ? summary.supersededClosedCount : 0
  };
}

function normalizeMergeChecklistSummary(
  summary: Record<string, unknown>,
  checklist?: MergeChecklistSummary
): Record<string, unknown> {
  return {
    ...normalizeKeeperSummary(summary),
    ...(checklist ? { mergeChecklist: checklist } : {})
  };
}

type ManifestArtifactRecord = {
  type: string;
  path: string;
  sha256: string;
  storageType: "local_fs" | "s3";
  bucket: string | null;
  objectKey: string | null;
};

function replaceManifestArtifact(
  artifacts: ManifestArtifactRecord[],
  artifact: ManifestArtifactRecord
): ManifestArtifactRecord[] {
  const index = artifacts.findIndex(
    (candidate) => candidate.type === artifact.type && candidate.path === artifact.path
  );
  if (index >= 0) {
    artifacts[index] = artifact;
    return artifacts;
  }

  const sameTypeIndex = artifacts.findIndex((candidate) => candidate.type === artifact.type);
  if (sameTypeIndex >= 0) {
    artifacts[sameTypeIndex] = artifact;
    return artifacts;
  }

  artifacts.push(artifact);
  return artifacts;
}

async function writeSupplementalEvidenceArtifact(input: {
  evidenceWriter: FileEvidenceWriter;
  evidenceRoot: string;
  projectId: string;
  campaignId: string;
  runId: string;
  artifactType: string;
  data: unknown;
}): Promise<{
  type: string;
  path: string;
  sha256: string;
  storageType: "local_fs";
  bucket: null;
  objectKey: null;
}> {
  const path = await input.evidenceWriter.write(
    {
      projectId: input.projectId,
      campaignId: input.campaignId,
      runId: input.runId,
      evidenceRoot: input.evidenceRoot
    },
    input.artifactType,
    input.data
  );

  const buffer = await readFile(path);
  return {
    type: input.artifactType,
    path,
    sha256: sha256(buffer),
    storageType: "local_fs",
    bucket: null,
    objectKey: null
  };
}

function toKeeperCandidate(
  row: KeeperCandidateRow
): KeeperCandidate | null {
  const prNumber = row.pr_number ?? parsePrNumberFromUrl(row.pr_url);
  if (!prNumber) {
    return null;
  }

  const summary = asRecord(row.summary);
  return {
    runId: row.id,
    prNumber,
    prUrl: row.pr_url,
    status: row.status,
    mergeChecklist: inferChecklist(summary, row.status),
    changedFiles: Number(summary.changedFiles ?? 0),
    changedLines: Number(summary.changedLines ?? 0),
    finishedAt: row.finished_at
  };
}

async function loadOpenKeeperCandidates(input: {
  projectId: string;
  baseBranch: string;
  excludeRunId: string;
}): Promise<KeeperCandidateRow[]> {
  const result = await query<KeeperCandidateRow>(
    `select r.id,
            r.status,
            r.pr_url,
            r.pr_number,
            r.pr_state,
            r.finished_at::text,
            coalesce(r.summary, '{}'::jsonb) as summary
     from runs r
     join campaigns c on c.id = r.campaign_id
     where c.project_id = $1
       and r.id <> $2
       and r.pr_url is not null
       and coalesce(r.pr_state, 'open') = 'open'
       and coalesce(r.summary#>>'{workspace,defaultBranch}', '') = $3
       and r.status in ('completed', 'needs_review', 'blocked', 'failed', 'cancelled')`,
    [input.projectId, input.excludeRunId, input.baseBranch]
  );

  return result.rows;
}

async function updateRunSummary(runId: string, mutate: (summary: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const state = await getRunState(runId);
  const summary = normalizeMergeChecklistSummary(asRecord(state?.summary));
  const nextSummary = normalizeMergeChecklistSummary(mutate(summary));

  await query(
    `update runs
     set summary = $2::jsonb
     where id = $1`,
    [runId, JSON.stringify(redactUnknown(nextSummary))]
  );
}

async function markSupersededRun(input: {
  runId: string;
  keeperPrNumber: number;
  keeperPrUrl: string;
}): Promise<void> {
  await updateRunSummary(input.runId, (summary) => ({
    ...summary,
    prState: "closed",
    keeperCandidate: false,
    keeperChosen: false,
    mergeReady: false,
    supersededByPrNumber: input.keeperPrNumber
  }));
  await query(
    `update runs
     set pr_state = 'closed',
         closed_at = coalesce(closed_at, now())
     where id = $1`,
    [input.runId]
  );

  await appendRunEvent(input.runId, {
    level: "info",
    eventType: "lifecycle",
    step: "pr_keeper",
    message: `Pull request superseded by #${input.keeperPrNumber}`,
    payload: {
      keeperPrNumber: input.keeperPrNumber,
      keeperPrUrl: input.keeperPrUrl
    }
  });
}

async function incrementKeeperSupersededClosedCount(runId: string, count: number): Promise<void> {
  if (count <= 0) {
    return;
  }

  await updateRunSummary(runId, (summary) => ({
    ...summary,
    keeperCandidate: true,
    keeperChosen: true,
    supersededClosedCount: Number(summary.supersededClosedCount ?? 0) + count
  }));
}

async function setKeeperMergeReady(input: {
  runId: string;
  mergeReady: boolean;
}): Promise<void> {
  await updateRunSummary(input.runId, (summary) => ({
    ...summary,
    keeperCandidate: true,
    keeperChosen: true,
    mergeReady: input.mergeReady
  }));
}

function isStrictSafeAutoMergeEligible(input: {
  summary: Record<string, unknown>;
  status: RunStatus;
  policy: Awaited<ReturnType<YamlPolicyEngine["load"]>>;
}): boolean {
  const { summary, status, policy } = input;
  if (!policy.pullRequests?.autoMerge.enabled) {
    return false;
  }

  const mergeChecklist = inferChecklist(summary, status);
  const scan = asRecord(summary.scan);
  const blockedReason = typeof summary.blockedReason === "string" ? summary.blockedReason : null;
  const policyViolations = Number(summary.policyViolations ?? 0);
  const changedFiles = Number(summary.changedFiles ?? 0);
  const changedLines = Number(summary.changedLines ?? 0);
  const changedFilePaths = Array.isArray(mergeChecklist.changedFilePaths)
    ? mergeChecklist.changedFilePaths
    : [];

  return (
    summary.mode === "apply" &&
    status === "completed" &&
    scan.selectedBuildSystem === "maven" &&
    scan.buildSystemDisposition === "supported" &&
    mergeChecklist.passed === true &&
    blockedReason === null &&
    policyViolations === 0 &&
    policy.pullRequests.autoMerge.allowedBuildSystems.includes("maven") &&
    changedFiles <= policy.pullRequests.autoMerge.maxFilesChanged &&
    changedLines <= policy.pullRequests.autoMerge.maxLinesChanged &&
    changedFilePaths.length === 1 &&
    changedFilePaths[0] === "pom.xml"
  );
}

async function markKeeperMergedRun(input: {
  runId: string;
  mergedAt: string;
}): Promise<void> {
  await updateRunSummary(input.runId, (summary) => ({
    ...summary,
    prState: "merged",
    keeperCandidate: true,
    keeperChosen: true,
    keeperMerged: true,
    mergeReady: true
  }));

  await query(
    `update runs
     set pr_state = 'merged',
         merged_at = coalesce(merged_at, $2::timestamptz),
         closed_at = coalesce(closed_at, $2::timestamptz)
     where id = $1`,
    [input.runId, input.mergedAt]
  );
}

async function rewriteRunJsonArtifact(input: {
  evidenceRoot: string;
  projectId: string;
  campaignId: string;
  runId: string;
  finalStatus: RunStatus;
  finalSummary: Record<string, unknown>;
  finalBranchName: string | null;
  finalPrUrl: string | null;
  finalPrNumber: number | null;
  finalPrState: "open" | "merged" | "closed" | null;
  finalPrOpenedAt: string | null;
  finalMergedAt: string | null;
  finalClosedAt: string | null;
}): Promise<ManifestArtifactRecord | null> {
  const artifactRoot = resolveArtifactRoot(input);
  const runJsonPath = join(artifactRoot, "run.json");

  try {
    const existing = JSON.parse(await readFile(runJsonPath, "utf8")) as Record<string, unknown>;
    const updated = {
      ...existing,
      status: input.finalStatus,
      branchName: input.finalBranchName,
      prUrl: input.finalPrUrl,
      prNumber: input.finalPrNumber,
      prState: input.finalPrState,
      prOpenedAt: input.finalPrOpenedAt,
      mergedAt: input.finalMergedAt,
      closedAt: input.finalClosedAt,
      summary: redactUnknown(input.finalSummary)
    };
    const serialized = `${JSON.stringify(updated, null, 2)}\n`;
    await writeFile(runJsonPath, serialized, "utf8");
    return {
      type: "run.json",
      path: runJsonPath,
      sha256: sha256(Buffer.from(serialized)),
      storageType: "local_fs",
      bucket: null,
      objectKey: null
    };
  } catch {
    return null;
  }
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

function buildJavaMavenTestCompatStage8Recipes(): Recipe[] {
  return buildJavaMavenTestCompatV2Recipes();
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
  "java-maven-test-compat-stage8-pack": buildJavaMavenTestCompatStage8Recipes,
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

export async function executeRunById(
  runId: string,
  workerId: string,
  options?: {
    signal?: AbortSignal;
  }
): Promise<{ runId: string; status: RunStatus }> {
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
  let manifestArtifacts: ManifestArtifactRecord[] | undefined;
  let activePolicyConfig: Awaited<ReturnType<YamlPolicyEngine["load"]>> | undefined;
  let workflowResult:
    | Awaited<ReturnType<typeof executeWorkflow>>
    | undefined;
  const executionAbortController = new AbortController();
  const abortExecution = (reason: string): void => {
    if (!executionAbortController.signal.aborted) {
      executionAbortController.abort(reason);
    }
  };
  const forwardedAbortListener = (): void => {
    abortExecution(
      typeof options?.signal?.reason === "string"
        ? options.signal.reason
        : "worker requested execution abort"
    );
  };
  if (options?.signal?.aborted) {
    forwardedAbortListener();
  } else {
    options?.signal?.addEventListener("abort", forwardedAbortListener, {
      once: true
    });
  }
  const cancellationPollMsRaw = Number(process.env.RUN_CANCELLATION_POLL_MS ?? "1000");
  const cancellationPollMs =
    Number.isFinite(cancellationPollMsRaw) && cancellationPollMsRaw > 0
      ? Math.floor(cancellationPollMsRaw)
      : 1000;
  const cancellationPollHandle = setInterval(() => {
    void getRunCancellationState(run.id).then((cancelled) => {
      if (cancelled.cancelled) {
        abortExecution(cancelled.reason ?? "cancel requested by operator");
      }
    });
  }, cancellationPollMs);

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
      verifier: new DefaultVerifier({
        signal: executionAbortController.signal
      }),
      evidenceWriter,
      evidenceStore,
      knowledgePublisher: new StubKnowledgePublisher(),
      semanticRetrievalProvider,
      remediator,
      executionSignal: executionAbortController.signal,
      isCancellationRequested: async () => (await getRunCancellationState(run.id)).cancelled,
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
    finalSummary = normalizeMergeChecklistSummary(finalSummary);
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

    if (run.mode === "apply" && workflowResult.verifySummary) {
      await appendRunEvent(run.id, {
        level: "info",
        eventType: "step_start",
        step: "merge_checklist",
        message: "Evaluating merge checklist"
      });

      const checklistPolicy = await new YamlPolicyEngine().load(
        resolve(process.cwd(), context.policy_config_path)
      );
      activePolicyConfig = checklistPolicy;
      const artifactRoot = resolveArtifactRoot({
        evidenceRoot,
        projectId: project.id,
        campaignId: campaign.id,
        runId: run.id
      });
      const scanResult = JSON.parse(
        await readFile(join(artifactRoot, "scan.json"), "utf8")
      ) as ScanResult;
      const apply = extractApplySummary(workflowResult.summary);
      const checklist = await evaluateMergeChecklist({
        workspacePath: workspace.workspacePath,
        evidencePath: artifactRoot,
        commitBefore: workspace.commitBefore,
        commitAfter: apply.commitAfter,
        changedFiles: apply.changedFiles,
        changedLines: apply.changedLines,
        policy: checklistPolicy,
        scan: scanResult,
        verifySummary: workflowResult.verifySummary,
        summary: workflowResult.summary
      });

      finalSummary = normalizeMergeChecklistSummary(finalSummary, checklist.summary);
      manifestArtifacts.push(
        await writeSupplementalEvidenceArtifact({
          evidenceWriter,
          evidenceRoot,
          projectId: project.id,
          campaignId: campaign.id,
          runId: run.id,
          artifactType: "merge-checklist.json",
          data: checklist.artifact
        })
      );

      if (!checklist.summary.passed) {
        if (finalStatus === "completed") {
          finalStatus = "needs_review";
        }
        finalSummary = {
          ...finalSummary,
          ...(typeof finalSummary.failureKind === "string"
            ? {}
            : { failureKind: "manual_review_required" }),
          prCreationSkippedReason: `Merge checklist failed: ${checklist.summary.reasons.join("; ")}`
        };
      }

      await appendRunEvent(run.id, {
        level: checklist.summary.passed ? "info" : "warn",
        eventType: checklist.summary.passed ? "step_end" : "warning",
        step: "merge_checklist",
        message: checklist.summary.passed
          ? "Merge checklist passed"
          : "Merge checklist failed",
        payload: {
          passed: checklist.summary.passed,
          reasons: checklist.summary.reasons
        }
      });
    }

    if (project.type === "github" && run.mode === "apply" && finalBranchName) {
      const cancellationBeforePr = await getRunCancellationState(run.id);
      if (cancellationBeforePr.cancelled) {
        throw new RunCancelledError(
          "Run cancellation requested by operator",
          cancellationBeforePr.reason
        );
      }

      const apply = extractApplySummary(workflowResult.summary);
      const prPolicy =
        activePolicyConfig ??
        (await new YamlPolicyEngine().load(resolve(process.cwd(), context.policy_config_path)));

      const mergeChecklist = inferChecklist(finalSummary, finalStatus);
      if (apply.commitAfter && mergeChecklist.passed) {
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

        if (finalPrNumber !== null && prPolicy.pullRequests?.keeper.enabled !== false) {
          const existingCandidateRows = await loadOpenKeeperCandidates({
            projectId: project.id,
            baseBranch: workspace.defaultBranch,
            excludeRunId: run.id
          });
          const existingCandidates = existingCandidateRows
            .map((row) => toKeeperCandidate(row))
            .filter((candidate): candidate is KeeperCandidate => candidate !== null);
          const currentCandidate: KeeperCandidate = {
            runId: run.id,
            prNumber: finalPrNumber,
            prUrl: pr.prUrl,
            status: finalStatus,
            mergeChecklist,
            changedFiles: apply.changedFiles,
            changedLines: apply.changedLines,
            finishedAt: finalSummary.finishedAt as string | undefined
          };
          const keeper = chooseKeeperCandidate([...existingCandidates, currentCandidate]);
          finalSummary.keeperCandidate = keeper.runId === run.id;
          finalSummary.keeperChosen = keeper.runId === run.id;
          finalSummary.supersededByPrNumber = keeper.runId === run.id ? null : keeper.prNumber;

          const prProvider = new GitHubPRProvider(githubAuthProvider);
          let supersededClosedCount = 0;

          for (const candidate of existingCandidates) {
            if (candidate.runId === keeper.runId) {
              continue;
            }

            try {
              await prProvider.commentOnPullRequest({
                project,
                prNumber: candidate.prNumber,
                body: buildSupersededComment(keeper.prNumber)
              });
              await prProvider.closePullRequest({
                project,
                prNumber: candidate.prNumber
              });
              await markSupersededRun({
                runId: candidate.runId,
                keeperPrNumber: keeper.prNumber,
                keeperPrUrl: keeper.prUrl
              });
              supersededClosedCount += 1;
            } catch (error) {
              finalSummary.keeperAutomationWarning = redactSecrets(
                error instanceof Error ? error.message : String(error)
              );
            }
          }

          if (keeper.runId !== run.id) {
            try {
              await prProvider.commentOnPullRequest({
                project,
                prNumber: finalPrNumber,
                body: buildSupersededComment(keeper.prNumber)
              });
              await prProvider.closePullRequest({
                project,
                prNumber: finalPrNumber
              });
              finalPrState = "closed";
              finalClosedAt = nowIso();
              finalSummary.prState = "closed";
              supersededClosedCount += 1;
            } catch (error) {
              finalSummary.keeperAutomationWarning = redactSecrets(
                error instanceof Error ? error.message : String(error)
              );
            }
          }

          if (keeper.runId === run.id) {
            finalSummary.supersededClosedCount = supersededClosedCount;
          } else {
            await incrementKeeperSupersededClosedCount(keeper.runId, supersededClosedCount);
          }

          const keeperShouldBeMergeReady =
            prPolicy.pullRequests?.mergeReady.enabled !== false && keeper.mergeChecklist.passed;
          let keeperMergeReadyApplied = false;

          if (keeperShouldBeMergeReady) {
            try {
              await prProvider.addLabelsToPullRequest({
                project,
                prNumber: keeper.prNumber,
                labels: [prPolicy.pullRequests?.mergeReady.label ?? "code-porter:merge-ready"]
              });
              keeperMergeReadyApplied = true;
              await appendRunEvent(run.id, {
                level: "info",
                eventType: "lifecycle",
                step: "pr_keeper",
                message: `Keeper PR marked merge-ready`,
                payload: {
                  keeperPrNumber: keeper.prNumber,
                  label: prPolicy.pullRequests?.mergeReady.label ?? "code-porter:merge-ready"
                }
              });
            } catch (error) {
              finalSummary.keeperAutomationWarning = redactSecrets(
                error instanceof Error ? error.message : String(error)
              );
            }
          }

          if (keeper.runId === run.id) {
            finalSummary.mergeReady = keeperMergeReadyApplied;
          } else if (keeperMergeReadyApplied) {
            await setKeeperMergeReady({
              runId: keeper.runId,
              mergeReady: true
            });
          }

          const keeperSummaryForMerge =
            keeper.runId === run.id
              ? {
                  ...finalSummary,
                  changedFiles: apply.changedFiles,
                  changedLines: apply.changedLines,
                  mergeChecklist: mergeChecklist
                }
              : asRecord(existingCandidateRows.find((candidate) => candidate.id === keeper.runId)?.summary);

          if (
            keeperMergeReadyApplied &&
            isStrictSafeAutoMergeEligible({
              summary: keeperSummaryForMerge,
              status: keeper.status,
              policy: prPolicy
            })
          ) {
            try {
              await prProvider.mergePullRequest({
                project,
                prNumber: keeper.prNumber,
                mergeMethod:
                  (prPolicy.pullRequests?.autoMerge.mergeMethod as PullRequestMergeMethod) ?? "squash"
              });
              const mergedAt = nowIso();
              if (keeper.runId === run.id) {
                finalPrState = "merged";
                finalMergedAt = mergedAt;
                finalClosedAt = mergedAt;
                finalSummary.prState = "merged";
                finalSummary.keeperMerged = true;
              } else {
                await markKeeperMergedRun({
                  runId: keeper.runId,
                  mergedAt
                });
              }
              await appendRunEvent(run.id, {
                level: "info",
                eventType: "lifecycle",
                step: "pr_keeper",
                message: `Keeper PR auto-merged`,
                payload: {
                  keeperPrNumber: keeper.prNumber,
                  mergeMethod: prPolicy.pullRequests?.autoMerge.mergeMethod ?? "squash"
                }
              });
            } catch (error) {
              finalSummary.keeperAutomationWarning = redactSecrets(
                error instanceof Error ? error.message : String(error)
              );
            }
          }
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
      } else if (apply.commitAfter && !mergeChecklist.passed) {
        await appendRunEvent(run.id, {
          level: "warn",
          eventType: "warning",
          step: "pr_create",
          message: "Pull request creation skipped because merge checklist failed",
          payload: {
            reasons: mergeChecklist.reasons
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
    clearInterval(cancellationPollHandle);
    options?.signal?.removeEventListener("abort", forwardedAbortListener);
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

  finalSummary = normalizeMergeChecklistSummary(
    finalSummary,
    inferChecklist(finalSummary, finalStatus)
  );

  if (manifestArtifacts) {
    const rewrittenRunArtifact = await rewriteRunJsonArtifact({
      evidenceRoot,
      projectId: project.id,
      campaignId: campaign.id,
      runId: run.id,
      finalStatus,
      finalSummary,
      finalBranchName,
      finalPrUrl,
      finalPrNumber,
      finalPrState,
      finalPrOpenedAt,
      finalMergedAt,
      finalClosedAt
    });
    if (rewrittenRunArtifact) {
      replaceManifestArtifact(manifestArtifacts, rewrittenRunArtifact);
    }
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
