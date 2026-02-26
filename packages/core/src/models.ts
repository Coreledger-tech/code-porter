export type BuildSystem = "maven" | "gradle" | "node" | "unknown";
export type ProjectType = "local" | "github";

export type RunMode = "plan" | "apply";

export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "needs_review"
  | "blocked";

export type CheckStatus = "passed" | "failed" | "not_run";
export type RunFailureKind = "auth" | "repo_write" | "workspace_prepare" | "workspace_cleanup";
export type VerifyFailureKind =
  | "code_failure"
  | "tool_missing"
  | "artifact_resolution"
  | "repo_unreachable"
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
  startedAt: string;
  finishedAt?: string;
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
  };
}

export interface PlanMetrics {
  buildSystem: BuildSystem;
  filesChanged: number;
  linesChanged: number;
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
  failureKind?: VerifyFailureKind;
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
