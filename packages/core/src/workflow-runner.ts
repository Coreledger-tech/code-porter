import type {
  Campaign,
  EvidenceStorage,
  PlanMetrics,
  PolicyConfig,
  PolicyDecision,
  Project,
  Run,
  RunMode,
  RunStatus,
  ScanResult,
  ScoreResult,
  VerifySummary
} from "./models.js";

export type FileMap = Record<string, string>;

export interface PlannedEdit {
  filePath: string;
  recipeId: string;
  description: string;
  lineDelta: number;
  changeType: "update" | "noop";
  before?: string;
  after?: string;
}

export interface AppliedChange {
  filePath: string;
  recipeId: string;
  description: string;
  changed: boolean;
  addedLines: number;
  removedLines: number;
}

export interface RecipePlanItem {
  recipeId: string;
  explanation: string;
  edits: PlannedEdit[];
  advisories: string[];
}

export interface RecipePlanResult {
  recipes: RecipePlanItem[];
  plannedEdits: PlannedEdit[];
  advisories: string[];
}

export interface RecipeApplyResult {
  files: FileMap;
  recipesApplied: string[];
  changes: AppliedChange[];
  advisories: string[];
}

export interface RecipeEnginePort {
  listRecipeIds(): string[];
  plan(scan: ScanResult, files: FileMap): RecipePlanResult;
  apply(scan: ScanResult, files: FileMap): RecipeApplyResult;
}

export interface PolicyEngine {
  load(path: string): Promise<PolicyConfig>;
  evaluatePlan(input: PlanMetrics, policy: PolicyConfig): PolicyDecision[];
  evaluateVerify(input: VerifySummary, policy: PolicyConfig): PolicyDecision[];
}

export interface VerifierPort {
  run(scan: ScanResult, repoPath: string, policy: PolicyConfig): Promise<VerifySummary>;
}

export interface RemediationAction {
  action: string;
  status: "applied" | "skipped" | "failed";
  command?: string;
  args?: string[];
  output?: string;
  reason?: string;
  filesChanged?: number;
  linesChanged?: number;
}

export interface RemediationArtifact {
  type: string;
  data: unknown;
}

export interface RemediationResult {
  applied: boolean;
  actions: RemediationAction[];
  verifySummary: VerifySummary;
  reason?: string;
  artifacts?: RemediationArtifact[];
  summary?: {
    changedFiles: number;
    changedLines: number;
    rulesApplied: string[];
    commitAfter?: string;
  };
}

export interface DeterministicRemediator {
  appliesTo(input: {
    scan: ScanResult;
    verify: VerifySummary;
    policy: PolicyConfig;
  }): boolean;
  run(input: {
    scan: ScanResult;
    verify: VerifySummary;
    repoPath: string;
    policy: PolicyConfig;
    verifier: VerifierPort;
  }): Promise<RemediationResult>;
}

export interface RunContext {
  projectId: string;
  campaignId: string;
  runId: string;
  evidenceRoot: string;
}

export interface EvidenceManifestArtifact {
  type: string;
  path: string;
  sha256: string;
  size: number;
}

export interface EvidenceExportArtifact {
  type: string;
  path: string;
  sha256: string;
  size: number;
  storageType?: EvidenceStorage;
  bucket?: string;
  objectKey?: string;
}

export interface EvidenceManifest {
  runId: string;
  artifacts: EvidenceManifestArtifact[];
  exports?: EvidenceExportArtifact[];
}

export interface EvidenceWriterPort {
  write(runCtx: RunContext, artifactType: string, data: unknown): Promise<string>;
  finalize(runCtx: RunContext): Promise<EvidenceManifest>;
}

export interface EvidenceStorePort {
  finalizeAndExport(
    runCtx: RunContext,
    options?: {
      maxEvidenceZipBytes?: number;
    }
  ): Promise<{
    manifest: EvidenceManifest;
    zip?: EvidenceExportArtifact;
    exports?: EvidenceExportArtifact[];
  }>;
}

export interface KnowledgePublisherPort {
  publishRunSummary(input: {
    runId: string;
    campaignId: string;
    projectId: string;
    summary: string;
    evidencePath: string;
  }): Promise<{ published: boolean; location?: string; reason?: string }>;
}

export interface SemanticRetrievalHit {
  filePath: string;
  score: number;
  reason?: string;
}

export interface SemanticRetrievalResult {
  provider: string;
  topK: number;
  query: string;
  hits: SemanticRetrievalHit[];
  metadata?: Record<string, unknown>;
}

export interface SemanticRetrievalProvider {
  readonly enabled: boolean;
  retrieve(input: {
    repoPath: string;
    scan: ScanResult;
    verify: VerifySummary;
    topK: number;
    filePaths: string[];
  }): Promise<SemanticRetrievalResult>;
}

export interface RunRequest {
  project: Project;
  campaign: Campaign;
  run: Run;
  policyPath: string;
  mode: RunMode;
  evidenceRoot: string;
}

export interface WorkflowExecutionResult {
  status: Run["status"];
  confidenceScore: ScoreResult | null;
  evidencePath: string;
  branchName?: string;
  evidenceZip?: EvidenceExportArtifact;
  summary: Record<string, unknown>;
  policyDecisions: PolicyDecision[];
  manifest: EvidenceManifest;
  verifySummary?: VerifySummary;
  remediationActions?: RemediationAction[];
}

export type WorkspaceCleanupPolicy =
  | "always_delete"
  | "delete_on_success_keep_on_failure"
  | "always_keep";

export interface PreparedWorkspace {
  workspacePath: string;
  resolvedBaseRef: string;
  commitBefore: string;
  defaultBranch: string;
  cloneUrlUsed: string;
  sourceRef: string;
  branchName?: string;
  commitAfter?: string;
}

export interface WorkspaceManagerPort {
  ensureCleanTree(repoPath: string): Promise<void>;
  createWorkspace(runId: string): Promise<string>;
  checkoutBase(repoPath: string, ref: string): Promise<{ ref: string; commit: string }>;
  createBranch(repoPath: string, campaignId: string, runId: string): Promise<string>;
  cleanupWorkspace(input: {
    workspacePath: string;
    status: RunStatus;
    policy: WorkspaceCleanupPolicy;
  }): Promise<void>;
}

export interface RepoProviderPort {
  prepareWorkspace(input: {
    project: Project;
    runId: string;
    campaignId: string;
    mode: RunMode;
    baseRefHint?: string;
  }): Promise<PreparedWorkspace>;
}

export interface PRProviderPort {
  createPullRequest(input: {
    project: Project;
    workspacePath: string;
    branchName: string;
    baseBranch: string;
    runId: string;
    summary: Record<string, unknown>;
    changedFiles: number;
    changedLines: number;
    recipesApplied: string[];
    confidenceScore: number | null;
    blockedReason?: string;
  }): Promise<{ prUrl: string; prNumber?: number | null }>;
}

export interface WorkflowRunner {
  start(runRequest: RunRequest): Promise<{ runId: string }>;
  get(runId: string): Promise<Run | undefined>;
}
