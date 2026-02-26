import type {
  PolicyConfig,
  PolicyDecision,
  Project,
  Run,
  RunMode,
  RunStatus,
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

  const checks: string[] = [];
  if (summary.compile.status !== "passed") {
    checks.push(`compile(${summary.compile.failureKind ?? "unknown"})`);
  }
  if (summary.tests.status !== "passed") {
    checks.push(`tests(${summary.tests.failureKind ?? "unknown"})`);
  }

  return `Verification blocked by infrastructure: ${checks.join(", ")}`;
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
  remediator?: DeterministicRemediator;
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
  const scanResult = await runScanStep(input.workingRepoPath);
  await input.evidenceWriter.write(runContext, "scan.json", scanResult);
  await emit({
    eventType: "step_end",
    step: "scan",
    message: "Repository scan complete",
    payload: {
      buildSystem: scanResult.buildSystem,
      hasTests: scanResult.hasTests
    }
  });

  await emit({
    eventType: "step_start",
    step: "plan",
    message: "Planning deterministic changes"
  });
  const files = await loadCandidateFiles(input.workingRepoPath);
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
  let remediationActions: RemediationAction[] = [];
  let commitAfter: string | undefined;

  const planBlocking = hasBlockingDecision(policyDecisions);

  if (input.mode === "apply" && !planBlocking) {
    await emit({
      eventType: "step_start",
      step: "apply",
      message: "Applying deterministic recipes"
    });
    const applyStepResult = await runApplyStep({
      repoPath: input.workingRepoPath,
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

    await emit({
      eventType: "step_start",
      step: "verify",
      message: "Running verifier checks"
    });
    verifySummary = await input.verifier.run(scanResult, input.workingRepoPath, policy);

    if (input.remediator) {
      const remediation = input.remediator.appliesTo({
        scan: scanResult,
        verify: verifySummary,
        policy
      })
        ? await input.remediator.run({
            scan: scanResult,
            verify: verifySummary,
            repoPath: input.workingRepoPath,
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
      await input.evidenceWriter.write(runContext, "agentic-remediation.json", remediation);
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

  await input.evidenceWriter.write(runContext, "verify.json", verifySummary);

  if (input.mode === "apply") {
    policyDecisions.push(...policyEngine.evaluateVerify(verifySummary, policy));
  }

  await input.evidenceWriter.write(runContext, "policy-decisions.json", policyDecisions);

  const blocking = hasBlockingDecision(policyDecisions);
  const blockedReason = deriveBlockedReason(verifySummary, policy);
  const isBlocked = input.mode === "apply" && !blocking && Boolean(blockedReason);

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

  const workspaceSummary = {
    workspacePath: input.workspace.workspacePath,
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
    blockedReason,
    workspace: workspaceSummary,
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
    workspace: workspaceSummary
  });

  await emit({
    eventType: "step_start",
    step: "evidence_finalize",
    message: "Finalizing evidence artifacts"
  });
  const evidenceResult = await input.evidenceStore.finalizeAndExport(runContext);
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
