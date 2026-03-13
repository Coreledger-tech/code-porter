import { resolve } from "node:path";
import type {
  BuildSystemDisposition,
  PolicyConfig,
  PolicyDecision,
  Project,
  Run,
  RunMode,
  RunStatus,
  ScanResult,
  ScoreResult,
  VerifyFailureKind,
  VerifySummary
} from "../models.js";
import { computeConfidenceScore } from "../scoring.js";
import {
  countPolicyViolations,
  hasBlockingDecision,
  YamlPolicyEngine
} from "../policy.js";
import type {
  DeterministicRemediator,
  EvidenceStorePort,
  EvidenceWriterPort,
  KnowledgePublisherPort,
  SemanticRetrievalProvider,
  RemediationAction,
  RecipeEnginePort,
  VerifierPort,
  WorkflowExecutionResult
} from "../workflow-runner.js";
import { runApplyStep } from "./apply-step.js";
import { loadCandidateFiles, runPlanStep } from "./plan-step.js";
import { runScanStep } from "./scan-step.js";

function nowIso(): string {
  return new Date().toISOString();
}

const RETRIEVAL_REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /ghp_[A-Za-z0-9]{20,}/g, replacement: "ghp_[REDACTED]" },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: "github_pat_[REDACTED]" },
  { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "AKIA[REDACTED]" },
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: "xox[REDACTED]" }
];

function sanitizeRetrievalString(value: string): string {
  let sanitized = value;
  for (const { pattern, replacement } of RETRIEVAL_REDACTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

function sanitizeRetrievalValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeRetrievalString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRetrievalValue(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    next[key] = sanitizeRetrievalValue(item);
  }
  return next;
}

function annotateScanForPolicy(scan: ScanResult, policy: PolicyConfig): ScanResult {
  const selectedManifestPath = scan.metadata.selectedManifestPath ?? null;
  const selectedBuildRoot = scan.metadata.selectedBuildRoot ?? null;

  if (scan.metadata.buildSystemDisposition === "no_supported_manifest") {
    return {
      ...scan,
      metadata: {
        ...scan.metadata,
        buildSystemDisposition: "no_supported_manifest" as BuildSystemDisposition,
        buildSystemReason:
          scan.metadata.buildSystemReason ?? "No supported build manifest found in root or depth<=2"
      }
    };
  }

  if (!policy.allowedBuildSystems.includes(scan.buildSystem)) {
    return {
      ...scan,
      metadata: {
        ...scan.metadata,
        buildSystemDisposition: "excluded_by_policy" as BuildSystemDisposition,
        buildSystemReason: `Build system '${scan.buildSystem}' excluded by policy (manifest: '${selectedManifestPath ?? "none"}', build root: '${selectedBuildRoot ?? "."}')`
      }
    };
  }

  if (
    scan.buildSystem === "gradle" &&
    scan.metadata.gradleProjectType &&
    scan.metadata.gradleProjectType !== "jvm"
  ) {
    const subtype = scan.metadata.gradleProjectType;
    const guardedAndroidAllowed =
      subtype === "android" && policy.gradle?.allowAndroidBaselineApply === true;
    return {
      ...scan,
      metadata: {
        ...scan.metadata,
        buildSystemDisposition: (guardedAndroidAllowed
          ? "supported"
          : "unsupported_subtype") as BuildSystemDisposition,
        buildSystemReason: guardedAndroidAllowed
          ? "Gradle Android baseline apply mode is enabled; deterministic guarded baseline will run while full Gradle task execution remains out of scope"
          : subtype === "android"
            ? "Gradle Android projects are out of scope for the Stage 3 JVM-only lane"
            : "Gradle project type could not be classified as JVM for the Stage 3 minimal lane"
      }
    };
  }

  return {
    ...scan,
    metadata: {
      ...scan.metadata,
      buildSystemDisposition: "supported" as BuildSystemDisposition,
      buildSystemReason:
        scan.metadata.buildSystemReason ??
        `Selected build system '${scan.buildSystem}' from '${selectedManifestPath ?? "none"}'`
    }
  };
}

function resolveBuildRootPath(workingRepoPath: string, selectedBuildRoot?: string | null): string {
  if (!selectedBuildRoot || selectedBuildRoot === ".") {
    return workingRepoPath;
  }

  return resolve(workingRepoPath, selectedBuildRoot);
}

function summarizeStatus(
  status: RunStatus,
  mode: RunMode,
  project: Project,
  extra: Record<string, unknown>
): Record<string, unknown> {
  return {
    status,
    mode,
    projectId: project.id,
    finishedAt: nowIso(),
    ...extra
  };
}

function verifyForPlanMode(
  buildSystem: VerifySummary["buildSystem"],
  hasTests: boolean
): VerifySummary {
  return {
    buildSystem,
    hasTests,
    compile: {
      status: "not_run",
      reason: "plan mode does not execute verifier commands"
    },
    tests: {
      status: "not_run",
      reason: "plan mode does not execute verifier commands"
    },
    staticChecks: {
      status: "not_run",
      reason: "plan mode does not execute verifier commands"
    },
    remediationSuggestions: []
  };
}

const GUARDED_ANDROID_BASELINE_REASON =
  "Guarded Android baseline apply mode skips Gradle task execution; run full Android CI outside Code Porter before merge";
const GUARDED_ANDROID_BASELINE_NOOP_REASON =
  "Guarded Android baseline is already satisfied; no deterministic wrapper or gradle.properties changes were required";

function verifyForGuardedAndroidMode(
  buildSystem: VerifySummary["buildSystem"],
  hasTests: boolean
): VerifySummary {
  return {
    buildSystem,
    hasTests,
    compile: {
      status: "not_run",
      reason: GUARDED_ANDROID_BASELINE_REASON
    },
    tests: {
      status: "not_run",
      reason: GUARDED_ANDROID_BASELINE_REASON
    },
    staticChecks: {
      status: "passed",
      reason: "Guarded Android baseline mode skips compile/test execution"
    },
    remediationSuggestions: [
      "Run full Android CI (assemble/test) outside Code Porter before merge",
      "Use this PR as a deterministic Java 17 baseline proposal"
    ]
  };
}

function gatherVerifyFailureKinds(summary: VerifySummary): VerifyFailureKind[] {
  const kinds: VerifyFailureKind[] = [];

  if (summary.compile.status !== "passed" && summary.compile.failureKind) {
    kinds.push(summary.compile.failureKind);
  }

  if (summary.tests.status !== "passed" && summary.tests.failureKind) {
    kinds.push(summary.tests.failureKind);
  }

  return [...new Set(kinds)];
}

function derivePrimaryVerifyFailureKind(summary: VerifySummary): VerifyFailureKind | undefined {
  if (summary.compile.status === "failed" && summary.compile.failureKind) {
    return summary.compile.failureKind;
  }

  if (summary.tests.status === "failed" && summary.tests.failureKind) {
    return summary.tests.failureKind;
  }

  if (summary.staticChecks.status === "failed" && summary.staticChecks.failureKind) {
    return summary.staticChecks.failureKind;
  }

  for (const check of [summary.compile, summary.tests, summary.staticChecks]) {
    if (check.status !== "passed" && check.failureKind) {
      return check.failureKind;
    }
  }

  return undefined;
}

function deriveBlockedReason(
  summary: VerifySummary,
  policy: PolicyConfig
): string | undefined {
  const failureKinds = gatherVerifyFailureKinds(summary);

  if (failureKinds.length === 0) {
    return undefined;
  }

  const isOnlyNonBlocking = failureKinds.every((kind) =>
    policy.verify.nonBlockingFailureKinds.includes(kind)
  );

  if (!isOnlyNonBlocking) {
    return undefined;
  }

  const explicitReasons = [
    summary.compile.blockedReason,
    summary.tests.blockedReason,
    summary.staticChecks.blockedReason
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  if (explicitReasons.length > 0) {
    return explicitReasons.join("; ");
  }

  const checks: string[] = [];
  if (summary.compile.status !== "passed") {
    checks.push(`compile(${summary.compile.failureKind ?? "unknown"})`);
  }
  if (summary.tests.status !== "passed") {
    checks.push(`tests(${summary.tests.failureKind ?? "unknown"})`);
  }

  return `Verification blocked by infrastructure: ${checks.join(", ")}`;
}

function collectBudgetSignals(summary: VerifySummary): Array<{
  check: "compile" | "tests" | "staticChecks";
  budgetKey?: string;
  limit?: number;
  observed?: number;
}> {
  const checks: Array<{
    name: "compile" | "tests" | "staticChecks";
    value: VerifySummary["compile"];
  }> = [
    { name: "compile", value: summary.compile },
    { name: "tests", value: summary.tests },
    { name: "staticChecks", value: summary.staticChecks }
  ];

  return checks
    .filter((entry) => entry.value.failureKind === "budget_exceeded")
    .map((entry) => ({
      check: entry.name,
      budgetKey: entry.value.budgetKey,
      limit: entry.value.budgetLimit,
      observed: entry.value.budgetObserved
    }));
}

function hasFailedVerifyChecks(summary: VerifySummary): boolean {
  return [summary.compile, summary.tests, summary.staticChecks].some(
    (check) => check.status === "failed"
  );
}

function buildBlockedScoreArtifact(blockedReason: string): {
  score: null;
  classification: "blocked";
  reason: string;
} {
  return {
    score: null,
    classification: "blocked",
    reason: blockedReason
  };
}

export async function executeWorkflow(input: {
  project: Project;
  campaign: { id: string; policyId: string };
  run: Run;
  mode: RunMode;
  policyPath: string;
  evidenceRoot: string;
  workingRepoPath: string;
  workspace: {
    workspacePath: string;
    resolvedBaseRef: string;
    commitBefore: string;
    defaultBranch: string;
    cloneUrlUsed: string;
    sourceRef: string;
    branchName?: string;
  };
  recipeEngine: RecipeEnginePort;
  verifier: VerifierPort;
  evidenceWriter: EvidenceWriterPort;
  evidenceStore: EvidenceStorePort;
  knowledgePublisher?: KnowledgePublisherPort;
  semanticRetrievalProvider?: SemanticRetrievalProvider;
  remediator?: DeterministicRemediator;
  executionSignal?: AbortSignal;
  isCancellationRequested?: () => Promise<boolean>;
  onStepEvent?: (event: {
    eventType: "step_start" | "step_end" | "warning" | "error";
    step: string;
    message: string;
    payload?: Record<string, unknown>;
  }) => Promise<void> | void;
}): Promise<WorkflowExecutionResult> {
  async function emit(event: {
    eventType: "step_start" | "step_end" | "warning" | "error";
    step: string;
    message: string;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    if (!input.onStepEvent) {
      return;
    }
    await input.onStepEvent(event);
  }

  const runContext = {
    projectId: input.project.id,
    campaignId: input.campaign.id,
    runId: input.run.id,
    evidenceRoot: input.evidenceRoot
  };

  const policyEngine = new YamlPolicyEngine();
  const policy = await policyEngine.load(input.policyPath);

  await input.evidenceWriter.write(runContext, "run.json", {
    ...input.run,
    startedAt: input.run.startedAt,
    mode: input.mode,
    workingRepoPath: input.workingRepoPath,
    workspace: input.workspace
  });

  await emit({
    eventType: "step_start",
    step: "scan",
    message: "Starting repository scan"
  });
  const rawScanResult = await runScanStep(input.workingRepoPath);
  const scanResult = annotateScanForPolicy(rawScanResult, policy);
  const buildRootPath = resolveBuildRootPath(
    input.workingRepoPath,
    scanResult.metadata.selectedBuildRoot ?? null
  );
  await input.evidenceWriter.write(runContext, "scan.json", scanResult);
  await emit({
    eventType: "step_end",
    step: "scan",
    message: "Repository scan complete",
    payload: {
      buildSystem: scanResult.buildSystem,
      hasTests: scanResult.hasTests,
      selectedBuildRoot: scanResult.metadata.selectedBuildRoot ?? ".",
      selectedManifestPath: scanResult.metadata.selectedManifestPath ?? null,
      buildSystemDisposition: scanResult.metadata.buildSystemDisposition ?? "supported"
    }
  });

  await emit({
    eventType: "step_start",
    step: "plan",
    message: "Planning deterministic changes"
  });
  const files = await loadCandidateFiles(buildRootPath);
  const { planResult, planMetrics } = runPlanStep({
    scan: scanResult,
    files,
    recipeEngine: input.recipeEngine
  });
  await input.evidenceWriter.write(runContext, "plan.json", planResult);
  await emit({
    eventType: "step_end",
    step: "plan",
    message: "Plan stage complete",
    payload: {
      filesChanged: planMetrics.filesChanged,
      linesChanged: planMetrics.linesChanged
    }
  });

  const policyDecisions: PolicyDecision[] = policyEngine.evaluatePlan(planMetrics, policy);

  let changedFiles = planMetrics.filesChanged;
  let changedLines = planMetrics.linesChanged;
  let branchName: string | undefined = input.workspace.branchName;
  let applySummary: Record<string, unknown> | undefined;
  let verifySummary: VerifySummary;
  let verifyArtifactWritten = false;
  let remediationActions: RemediationAction[] = [];
  let commitAfter: string | undefined;
  let guardedAndroidBaselineMode = false;
  let guardedAndroidBaselineNoop = false;

  const planBlocking = hasBlockingDecision(policyDecisions);

  if (input.mode === "apply" && !planBlocking) {
    await emit({
      eventType: "step_start",
      step: "apply",
      message: "Applying deterministic recipes"
    });
    const applyStepResult = await runApplyStep({
      repoPath: buildRootPath,
      campaignId: input.campaign.id,
      runId: input.run.id,
      scan: scanResult,
      files,
      recipeEngine: input.recipeEngine
    });

    changedFiles = applyStepResult.changedFiles;
    changedLines = applyStepResult.changedLines;
    commitAfter = applyStepResult.commitAfter;

    applySummary = {
      branchName,
      commitBefore: input.workspace.commitBefore,
      commitAfter: applyStepResult.commitAfter,
      changedFiles: applyStepResult.changedFiles,
      changedLines: applyStepResult.changedLines,
      advisories: applyStepResult.applyResult.advisories,
      recipesApplied: applyStepResult.applyResult.recipesApplied
    };

    await input.evidenceWriter.write(runContext, "apply.json", {
      ...applySummary,
      changes: applyStepResult.applyResult.changes
    });

    if (applyStepResult.patch.length > 0) {
      await input.evidenceWriter.write(
        runContext,
        "artifacts/diff.patch",
        applyStepResult.patch
      );
    }
    await emit({
      eventType: "step_end",
      step: "apply",
      message: "Apply stage complete",
      payload: {
        changedFiles: applyStepResult.changedFiles,
        changedLines: applyStepResult.changedLines
      }
    });

    guardedAndroidBaselineMode =
      scanResult.buildSystem === "gradle" &&
      scanResult.metadata.gradleProjectType === "android" &&
      policy.gradle?.allowAndroidBaselineApply === true;
    guardedAndroidBaselineNoop = guardedAndroidBaselineMode && applyStepResult.changedFiles === 0;

    if (guardedAndroidBaselineMode) {
      await emit({
        eventType: "step_start",
        step: "verify",
        message: "Skipping full verify for guarded Android Gradle baseline mode"
      });
      verifySummary = verifyForGuardedAndroidMode(scanResult.buildSystem, scanResult.hasTests);
      await input.evidenceWriter.write(runContext, "remediation.json", {
        applied: false,
        reason: "not_applicable",
        actions: []
      });
      await input.evidenceWriter.write(runContext, "agentic-remediation.json", {
        applied: false,
        reason: "not_applicable",
        actions: []
      });
      await input.evidenceWriter.write(runContext, "verify.json", verifySummary);
      verifyArtifactWritten = true;
      await emit({
        eventType: "step_end",
        step: "verify",
        message: "Guarded Android verify stage complete",
        payload: {
          compile: verifySummary.compile.status,
          tests: verifySummary.tests.status,
          staticChecks: verifySummary.staticChecks.status
        }
      });
    } else {
      await emit({
        eventType: "step_start",
        step: "verify",
        message: "Running verifier checks"
      });
      verifySummary = await input.verifier.run(scanResult, buildRootPath, policy);
      const executionInterrupted =
        input.executionSignal?.aborted === true ||
        (await input.isCancellationRequested?.()) === true;

      if (input.remediator && !executionInterrupted) {
        const remediation = input.remediator.appliesTo({
          scan: scanResult,
          verify: verifySummary,
          policy
        })
          ? await input.remediator.run({
              scan: scanResult,
              verify: verifySummary,
              repoPath: buildRootPath,
              policy,
              verifier: input.verifier
            })
          : {
              applied: false,
              actions: [
                {
                  action: "deterministic_remediation",
                  status: "skipped" as const,
                  reason: "Remediator not applicable"
                }
              ],
              verifySummary,
              reason: "not_applicable"
            };

        verifySummary = remediation.verifySummary;
        remediationActions = remediation.actions;
        const remediationArtifactPayload = (remediation.artifacts ?? []).find(
          (artifact) => artifact.type === "remediation.json"
        )?.data;
        const remediationPayload = {
          ...(typeof remediationArtifactPayload === "object" && remediationArtifactPayload !== null
            ? remediationArtifactPayload
            : {}),
          ...remediation,
          summary: {
            changedFiles: remediation.summary?.changedFiles ?? 0,
            changedLines: remediation.summary?.changedLines ?? 0,
            rulesApplied: remediation.summary?.rulesApplied ?? [],
            commitAfter: remediation.summary?.commitAfter ?? null
          }
        };
        await input.evidenceWriter.write(runContext, "remediation.json", remediationPayload);
        await input.evidenceWriter.write(runContext, "agentic-remediation.json", remediationPayload);
        for (const artifact of remediation.artifacts ?? []) {
          if (artifact.type === "remediation.json") {
            continue;
          }
          await input.evidenceWriter.write(runContext, artifact.type, artifact.data);
        }
        if (applySummary && remediation.summary) {
          applySummary = {
            ...applySummary,
            commitAfter: remediation.summary.commitAfter ?? applySummary.commitAfter,
            remediation: {
              changedFiles: remediation.summary.changedFiles,
              changedLines: remediation.summary.changedLines,
              rulesApplied: remediation.summary.rulesApplied
            }
          };
          if (typeof remediation.summary.commitAfter === "string") {
            commitAfter = remediation.summary.commitAfter;
          }
        }
      } else if (input.remediator && executionInterrupted) {
        const remediationPayload = {
          applied: false,
          reason: "execution_aborted",
          actions: [
            {
              action: "deterministic_remediation",
              status: "skipped" as const,
              reason: "Remediation skipped because verification execution was aborted"
            }
          ]
        };
        await input.evidenceWriter.write(runContext, "remediation.json", remediationPayload);
        await input.evidenceWriter.write(runContext, "agentic-remediation.json", remediationPayload);
      }
      await input.evidenceWriter.write(runContext, "verify.json", verifySummary);
      verifyArtifactWritten = true;
      const budgetSignals = collectBudgetSignals(verifySummary);
      for (const signal of budgetSignals) {
        await emit({
          eventType: "warning",
          step: "verify",
          message: "Budget guardrail triggered during verification",
          payload: {
            check: signal.check,
            budgetKey: signal.budgetKey ?? "unknown",
            limit: signal.limit ?? null,
            observed: signal.observed ?? null,
            actionTaken: "blocked"
          }
        });
      }
      await emit({
        eventType: "step_end",
        step: "verify",
        message: "Verifier stage complete",
        payload: {
          compile: verifySummary.compile.status,
          tests: verifySummary.tests.status,
          staticChecks: verifySummary.staticChecks.status
        }
      });
    }
  } else {
    if (input.mode === "apply" && planBlocking) {
      applySummary = {
        skipped: true,
        reason: "apply blocked by plan/scan policy decisions"
      };
      await input.evidenceWriter.write(runContext, "apply.json", applySummary);
      await emit({
        eventType: "warning",
        step: "apply",
        message: "Apply skipped due to blocking plan policy decisions"
      });
    }

    verifySummary = verifyForPlanMode(scanResult.buildSystem, scanResult.hasTests);
  }

  if (!verifyArtifactWritten) {
    await input.evidenceWriter.write(runContext, "verify.json", verifySummary);
  }

  if (
    input.mode === "apply" &&
    input.semanticRetrievalProvider?.enabled &&
    input.executionSignal?.aborted !== true &&
    (await input.isCancellationRequested?.()) !== true &&
    hasFailedVerifyChecks(verifySummary)
  ) {
    const topKRaw = Number(process.env.SEMANTIC_RETRIEVAL_TOP_K ?? "5");
    const topK = Number.isFinite(topKRaw) && topKRaw > 0 ? Math.floor(topKRaw) : 5;
    try {
      const retrieval = await input.semanticRetrievalProvider.retrieve({
        repoPath: buildRootPath,
        scan: scanResult,
        verify: verifySummary,
        topK,
        filePaths: Object.keys(files)
      });
      const sanitizedRetrieval = sanitizeRetrievalValue(retrieval);
      await input.evidenceWriter.write(runContext, "context/retrieval.json", {
        enabled: true,
        retrievedAt: nowIso(),
        ...(sanitizedRetrieval as Record<string, unknown>)
      });
    } catch (error) {
      await input.evidenceWriter.write(runContext, "context/retrieval.json", {
        enabled: true,
        provider: process.env.SEMANTIC_RETRIEVAL_PROVIDER ?? "claude_context",
        retrievedAt: nowIso(),
        error: sanitizeRetrievalString(
          error instanceof Error ? error.message : String(error ?? "unknown retrieval error")
        )
      });
    }
  }

  if (input.mode === "apply") {
    if (guardedAndroidBaselineMode) {
      policyDecisions.push({
        id: "gradle_android_guarded_verify",
        stage: "verify",
        status: "warn",
        reason: GUARDED_ANDROID_BASELINE_REASON,
        blocking: false
      });
    } else {
      policyDecisions.push(...policyEngine.evaluateVerify(verifySummary, policy));
    }
  }

  await input.evidenceWriter.write(runContext, "policy-decisions.json", policyDecisions);

  const blocking = hasBlockingDecision(policyDecisions);
  const blockedReason = deriveBlockedReason(verifySummary, policy);
  const isBlocked = input.mode === "apply" && !blocking && Boolean(blockedReason);
  const budgetBlocked =
    isBlocked &&
    [verifySummary.compile, verifySummary.tests, verifySummary.staticChecks].some(
      (check) => check.failureKind === "budget_exceeded"
    );

  let confidenceScore: ScoreResult | null = null;
  if (!isBlocked) {
    const violations = countPolicyViolations(policyDecisions);
    confidenceScore = computeConfidenceScore({
      verify: verifySummary,
      filesChanged: changedFiles,
      linesChanged: changedLines,
      policyViolations: violations,
      policy
    });

    await input.evidenceWriter.write(runContext, "score.json", confidenceScore);
  } else {
    await input.evidenceWriter.write(
      runContext,
      "score.json",
      buildBlockedScoreArtifact(blockedReason!)
    );
  }

  const status: RunStatus = isBlocked
    ? "blocked"
    : blocking || confidenceScore?.classification === "needs_review"
      ? "needs_review"
      : "completed";

  const unsupportedBuildSystem =
    scanResult.metadata.buildSystemDisposition === "excluded_by_policy" ||
    scanResult.metadata.buildSystemDisposition === "unsupported_subtype" ||
    scanResult.metadata.buildSystemDisposition === "no_supported_manifest";
  const primaryVerifyFailureKind = derivePrimaryVerifyFailureKind(verifySummary);
  const failureKind = budgetBlocked
    ? "budget_guardrail"
    : unsupportedBuildSystem
      ? "unsupported_build_system"
      : guardedAndroidBaselineMode
        ? guardedAndroidBaselineNoop
          ? "guarded_baseline_noop"
          : "guarded_baseline_applied"
        : primaryVerifyFailureKind;
  const normalizedFailureKind =
    failureKind ?? (status === "needs_review" ? "manual_review_required" : undefined);

  const workspaceSummary = {
    workspacePath: input.workspace.workspacePath,
    selectedBuildRootPath: buildRootPath,
    selectedBuildRoot: scanResult.metadata.selectedBuildRoot ?? ".",
    selectedManifestPath: scanResult.metadata.selectedManifestPath ?? null,
    resolvedBaseRef: input.workspace.resolvedBaseRef,
    defaultBranch: input.workspace.defaultBranch,
    cloneUrlUsed: input.workspace.cloneUrlUsed,
    sourceRef: input.workspace.sourceRef,
    commitBefore: input.workspace.commitBefore,
    commitAfter,
    branchName
  };

  const summary = summarizeStatus(status, input.mode, input.project, {
    branchName,
    changedFiles,
    changedLines,
    policyViolations: countPolicyViolations(policyDecisions),
    score: confidenceScore?.score ?? null,
    classification: confidenceScore?.classification ?? "blocked",
    ...(normalizedFailureKind ? { failureKind: normalizedFailureKind } : {}),
    blockedReason,
    ...(guardedAndroidBaselineMode
      ? {
          guardedBaselineReason: guardedAndroidBaselineNoop
            ? GUARDED_ANDROID_BASELINE_NOOP_REASON
            : GUARDED_ANDROID_BASELINE_REASON,
          guardedBaselineNoop: guardedAndroidBaselineNoop
        }
      : {}),
    workspace: workspaceSummary,
    scan: {
      selectedBuildSystem: scanResult.buildSystem,
      selectedBuildRoot: scanResult.metadata.selectedBuildRoot ?? ".",
      selectedManifestPath: scanResult.metadata.selectedManifestPath ?? null,
      buildSystemDisposition: scanResult.metadata.buildSystemDisposition ?? "supported",
      buildSystemReason: scanResult.metadata.buildSystemReason ?? null,
      gradleWrapperPath: scanResult.metadata.gradleWrapperPath ?? null,
      gradleProjectType: scanResult.metadata.gradleProjectType ?? null,
      detectedBuildSystems: scanResult.metadata.detectedBuildSystems ?? [],
      detectedProjects: scanResult.metadata.detectedProjects ?? []
    },
    applySummary
  });

  const knowledgeResult = input.knowledgePublisher
    ? await input.knowledgePublisher.publishRunSummary({
        runId: input.run.id,
        campaignId: input.campaign.id,
        projectId: input.project.id,
        summary: JSON.stringify(summary),
        evidencePath: input.evidenceRoot
      })
    : { published: false, reason: "knowledge publisher not configured" };

  await input.evidenceWriter.write(runContext, "knowledge.json", knowledgeResult);
  await input.evidenceWriter.write(runContext, "run.json", {
    ...input.run,
    mode: input.mode,
    status,
    summary,
    workingRepoPath: input.workingRepoPath,
    buildRootPath,
    workspace: workspaceSummary
  });

  await emit({
    eventType: "step_start",
    step: "evidence_finalize",
    message: "Finalizing evidence artifacts"
  });
  const evidenceResult = await input.evidenceStore.finalizeAndExport(runContext, {
    maxEvidenceZipBytes: policy.maxEvidenceZipBytes
  });
  const mergedExports = [
    ...(evidenceResult.manifest.exports ?? []),
    ...(evidenceResult.exports ?? [])
  ];
  const dedupedExports = mergedExports.filter((artifact, index) => {
    return (
      mergedExports.findIndex(
        (candidate) =>
          candidate.type === artifact.type &&
          candidate.path === artifact.path &&
          candidate.sha256 === artifact.sha256
      ) === index
    );
  });
  const manifest =
    dedupedExports.length > 0
      ? {
          ...evidenceResult.manifest,
          exports: dedupedExports
        }
      : evidenceResult.manifest;
  await emit({
    eventType: "step_end",
    step: "evidence_finalize",
    message: "Evidence finalized",
    payload: {
      artifactCount: manifest.artifacts.length,
      exportCount: manifest.exports?.length ?? 0
    }
  });

  return {
    status,
    confidenceScore,
    evidencePath: input.evidenceRoot,
    branchName,
    evidenceZip: evidenceResult.zip,
    summary,
    policyDecisions,
    manifest,
    verifySummary,
    remediationActions
  };
}
