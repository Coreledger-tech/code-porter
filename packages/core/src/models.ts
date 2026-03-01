export type BuildSystem = "maven" | "gradle" | "node" | "python" | "go" | "unknown";
export type ProjectType = "local" | "github";
export type EvidenceLinkMode = "signed" | "public" | "local_proxy";
export type EvidenceStorage = "local_fs" | "s3";
export type GitHubAuthMode = "pat" | "app";
export type CampaignLifecycleStatus = "active" | "paused";
export type PullRequestState = "open" | "merged" | "closed";
export type GradleProjectType = "jvm" | "android" | "unknown";
export type BuildSystemDisposition =
  | "supported"
  | "excluded_by_policy"
  | "unsupported_subtype"
  | "no_supported_manifest";

export type RunMode = "plan" | "apply";

export type RunStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed"
  | "needs_review"
  | "blocked";

export type CheckStatus = "passed" | "failed" | "not_run";
export type RunFailureKind =
  | "auth"
  | "repo_write"
  | "workspace_prepare"
  | "workspace_cleanup"
  | "unsupported_build_system"
  | "budget_guardrail"
  | "cancelled"
  | "retry_exhausted"
  | "lease_reclaimed";
export type VerifyFailureKind =
  | "code_compile_failure"
  | "code_test_failure"
  | "code_failure"
  | "tool_missing"
  | "artifact_resolution"
  | "repo_unreachable"
  | "budget_exceeded"
  | "java17_plugin_incompat"
  | "unknown";

export interface Project {
  id: string;
  name: string;
  type: ProjectType;
  localPath?: string;
  owner?: string;
  repo?: string;
  cloneUrl?: string;
  defaultBranch?: string;
  createdAt: string;
}

export interface Campaign {
  id: string;
  projectId: string;
  policyId: string;
  recipePack: string;
  targetSelector?: string;
  lifecycleStatus?: CampaignLifecycleStatus;
  pausedAt?: string;
  resumedAt?: string;
  createdAt: string;
}

export interface Run {
  id: string;
  campaignId: string;
  mode: RunMode;
  status: RunStatus;
  confidenceScore?: number;
  evidencePath: string;
  branchName?: string;
  prUrl?: string;
  prNumber?: number | null;
  prState?: PullRequestState | null;
  prOpenedAt?: string | null;
  mergedAt?: string | null;
  closedAt?: string | null;
  lastCiState?: string | null;
  lastCiCheckedAt?: string | null;
  startedAt: string;
  finishedAt?: string;
}

export type RunJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface RunJob {
  runId: string;
  campaignId: string;
  mode: RunMode;
  status: RunJobStatus;
  attempts: number;
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  nextAttemptAt: string;
  lockedBy?: string | null;
  lockedAt?: string | null;
  leaseOwner?: string | null;
  leasedAt?: string | null;
  leaseExpiresAt?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RunEventLevel = "info" | "warn" | "error";
export type RunEventType = "step_start" | "step_end" | "warning" | "error" | "lifecycle";

export interface RunEvent {
  id: number;
  runId: string;
  level: RunEventLevel;
  eventType: RunEventType;
  step: string | null;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface EvidenceArtifact {
  id: string;
  runId: string;
  type: string;
  path: string;
  sha256: string;
  createdAt: string;
}

export interface PolicyConfig {
  maxChangeLines: number;
  maxFilesChanged: number;
  requireTestsIfPresent: boolean;
  maxInflightRunsPerProject: number;
  maxInflightRunsGlobal: number;
  maxVerifyMinutesPerRun: number;
  maxVerifyRetries: number;
  maxEvidenceZipBytes: number;
  defaultRecipePack: string;
  allowedBuildSystems: BuildSystem[];
  verifyFailureMode: "deny" | "warn";
  verify: {
    blockingFailureKinds: VerifyFailureKind[];
    nonBlockingFailureKinds: VerifyFailureKind[];
    retryOnCachedResolution: boolean;
    maven: {
      forceUpdate: boolean;
      prefetchPlugins: boolean;
      purgeLocalCache: boolean;
    };
  };
  remediation?: {
    mavenCompile?: {
      enabled: boolean;
      maxIterations: number;
      maxFilesChangedPerIteration: number;
      maxLinesChangedPerIteration: number;
      maxFilesChangedTotal: number;
      maxLinesChangedTotal: number;
      allowedFixes: Array<
        | "ensure_maven_compiler_plugin_for_lombok"
        | "ensure_lombok_annotation_processor_path"
        | "remove_proc_none"
      >;
    };
  };
  confidenceThresholds: {
    pass: number;
    needsReview: number;
  };
}

export interface Policy {
  id: string;
  name: string;
  configPath: string;
  config: PolicyConfig;
}

export interface BuildSystemDetection {
  buildSystem: BuildSystem;
  manifestPath: string;
  buildRoot: string;
  depth: number;
}

export interface ScanResult {
  buildSystem: BuildSystem;
  hasTests: boolean;
  metadata: {
    gitBranch: string | null;
    toolAvailability: {
      mvn: boolean;
      gradle: boolean;
      npm: boolean;
      node: boolean;
    };
    detectedFiles: string[];
    detectedBuildSystems?: BuildSystem[];
    detectedProjects?: BuildSystemDetection[];
    selectedManifestPath?: string | null;
    selectedBuildRoot?: string | null;
    buildSystemDisposition?: BuildSystemDisposition;
    buildSystemReason?: string;
    gradleWrapperPath?: string | null;
    gradleProjectType?: GradleProjectType | null;
  };
}

export interface PlanMetrics {
  buildSystem: BuildSystem;
  filesChanged: number;
  linesChanged: number;
  selectedManifestPath?: string | null;
  selectedBuildRoot?: string | null;
  buildSystemDisposition?: BuildSystemDisposition;
  buildSystemReason?: string;
}

export interface VerifyAttempt {
  command: string;
  args: string[];
  status: CheckStatus;
  exitCode?: number;
  output?: string;
  failureKind?: VerifyFailureKind;
  retryReason?: string;
}

export interface CheckResult {
  status: CheckStatus;
  command?: string;
  exitCode?: number;
  reason?: string;
  output?: string;
  timedOut?: boolean;
  failureKind?: VerifyFailureKind;
  budgetKey?: "maxVerifyMinutesPerRun" | "maxVerifyRetries" | "maxEvidenceZipBytes";
  budgetLimit?: number;
  budgetObserved?: number;
  attempts?: VerifyAttempt[];
  blockedReason?: string;
}

export interface VerifySummary {
  buildSystem: BuildSystem;
  hasTests: boolean;
  compile: CheckResult;
  tests: CheckResult;
  staticChecks: CheckResult;
  remediationSuggestions?: string[];
}

export type PolicyDecisionStatus = "allow" | "deny" | "warn";

export interface PolicyDecision {
  id: string;
  stage: "scan" | "plan" | "verify";
  status: PolicyDecisionStatus;
  reason: string;
  blocking: boolean;
}

export interface ScoreResult {
  score: number;
  classification: "pass" | "needs_review" | "blocked";
  breakdown: {
    compilePoints: number;
    testPoints: number;
    staticPoints: number;
    changeSizePoints: number;
    violationPenalty: number;
  };
}

export type PullRequestMergeState = "open" | "merged" | "closed" | "unknown";

export interface SummaryRecentRun {
  runId: string;
  campaignId: string;
  status: RunStatus;
  queueStatus: RunJobStatus | "unknown";
  startedAt: string;
  finishedAt: string | null;
  durationSec: number | null;
  prUrl: string | null;
  mergeState: PullRequestMergeState;
  prNumber?: number | null;
  prState?: PullRequestState | null;
  prOpenedAt?: string | null;
  mergedAt?: string | null;
  closedAt?: string | null;
}

export interface AggregateSummary {
  windowDays: number;
  recentLimit: number;
  totalsByStatus: Record<string, number>;
  failureKinds: Record<string, number>;
  retryCount: number;
  cancelledCount: number;
  durations: {
    p50Sec: number | null;
    p95Sec: number | null;
  };
  recentRuns: SummaryRecentRun[];
}

export interface PilotWorstOffender {
  projectId: string;
  projectName: string;
  totalRuns: number;
  blockedRuns: number;
  blockedRate: number;
  topFailureKind: string;
}

export interface PilotReport {
  window: "7d" | "30d";
  generatedAt: string;
  totalsByStatus: Record<string, number>;
  topFailureKinds: Array<{ failureKind: string; count: number }>;
  blockedByFailureKind: Array<{ failureKind: string; count: number }>;
  prOutcomes: {
    opened: number;
    merged: number;
    closedUnmerged: number;
    open: number;
    mergeRate: number;
  };
  timeToGreen: {
    sampleSize: number;
    p50Hours: number | null;
    p90Hours: number | null;
  };
  retryRate: {
    retriedRuns: number;
    totalRuns: number;
    rate: number;
  };
  worstOffendersByProject: PilotWorstOffender[];
}
