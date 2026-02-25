import type {
  Campaign,
  PlanMetrics,
  PolicyConfig,
  PolicyDecision,
  Project,
  Run,
  RunMode,
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

export interface EvidenceManifest {
  runId: string;
  artifacts: EvidenceManifestArtifact[];
}

export interface EvidenceWriterPort {
  write(runCtx: RunContext, artifactType: string, data: unknown): Promise<string>;
  finalize(runCtx: RunContext): Promise<EvidenceManifest>;
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
  confidenceScore: ScoreResult;
  evidencePath: string;
  branchName?: string;
  summary: Record<string, unknown>;
  policyDecisions: PolicyDecision[];
  manifest: EvidenceManifest;
}

export interface WorkflowRunner {
  start(runRequest: RunRequest): Promise<{ runId: string }>;
  get(runId: string): Promise<Run | undefined>;
}
