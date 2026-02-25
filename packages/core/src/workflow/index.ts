import type {
  PolicyDecision,
  Project,
  Run,
  RunMode,
  RunStatus,
  VerifySummary
} from "../models.js";
import { computeConfidenceScore } from "../scoring.js";
import {
  countPolicyViolations,
  hasBlockingDecision,
  YamlPolicyEngine
} from "../policy.js";
import type {
  EvidenceWriterPort,
  KnowledgePublisherPort,
  RecipeEnginePort,
  VerifierPort,
  WorkflowExecutionResult
} from "../workflow-runner.js";
import { runApplyStep } from "./apply-step.js";
import { runEvidenceStep } from "./evidence-step.js";
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

function verifyForPlanMode(buildSystem: VerifySummary["buildSystem"], hasTests: boolean): VerifySummary {
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
    }
  };
}

export async function executeWorkflow(input: {
  project: Project;
  campaign: { id: string; policyId: string };
  run: Run;
  mode: RunMode;
  policyPath: string;
  evidenceRoot: string;
  recipeEngine: RecipeEnginePort;
  verifier: VerifierPort;
  evidenceWriter: EvidenceWriterPort;
  knowledgePublisher?: KnowledgePublisherPort;
}): Promise<WorkflowExecutionResult> {
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
    mode: input.mode
  });

  const scanResult = await runScanStep(input.project.localPath);
  await input.evidenceWriter.write(runContext, "scan.json", scanResult);

  const files = await loadCandidateFiles(input.project.localPath);
  const { planResult, planMetrics } = runPlanStep({
    scan: scanResult,
    files,
    recipeEngine: input.recipeEngine
  });
  await input.evidenceWriter.write(runContext, "plan.json", planResult);

  const policyDecisions: PolicyDecision[] = policyEngine.evaluatePlan(planMetrics, policy);

  let changedFiles = planMetrics.filesChanged;
  let changedLines = planMetrics.linesChanged;
  let branchName: string | undefined;
  let applySummary: Record<string, unknown> | undefined;
  let verifySummary: VerifySummary;

  const planBlocking = hasBlockingDecision(policyDecisions);

  if (input.mode === "apply" && !planBlocking) {
    const applyStepResult = await runApplyStep({
      repoPath: input.project.localPath,
      campaignId: input.campaign.id,
      runId: input.run.id,
      scan: scanResult,
      files,
      recipeEngine: input.recipeEngine
    });

    changedFiles = applyStepResult.changedFiles;
    changedLines = applyStepResult.changedLines;
    branchName = applyStepResult.branchName;

    applySummary = {
      branchName: applyStepResult.branchName,
      commitSha: applyStepResult.commitSha,
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
      await input.evidenceWriter.write(runContext, "artifacts/diff.patch", applyStepResult.patch);
    }

    verifySummary = await input.verifier.run(
      scanResult,
      input.project.localPath,
      policy
    );
  } else {
    if (input.mode === "apply" && planBlocking) {
      applySummary = {
        skipped: true,
        reason: "apply blocked by plan/scan policy decisions"
      };
      await input.evidenceWriter.write(runContext, "apply.json", applySummary);
    }

    verifySummary = verifyForPlanMode(scanResult.buildSystem, scanResult.hasTests);
  }

  await input.evidenceWriter.write(runContext, "verify.json", verifySummary);

  if (input.mode === "apply") {
    policyDecisions.push(...policyEngine.evaluateVerify(verifySummary, policy));
  }

  await input.evidenceWriter.write(runContext, "policy-decisions.json", policyDecisions);

  const violations = countPolicyViolations(policyDecisions);
  const scoreResult = computeConfidenceScore({
    verify: verifySummary,
    filesChanged: changedFiles,
    linesChanged: changedLines,
    policyViolations: violations,
    policy
  });
  await input.evidenceWriter.write(runContext, "score.json", scoreResult);

  const blocking = hasBlockingDecision(policyDecisions);

  const status: RunStatus =
    blocking || scoreResult.classification === "needs_review"
      ? "needs_review"
      : "completed";

  const summary = summarizeStatus(status, input.mode, input.project, {
    branchName,
    changedFiles,
    changedLines,
    policyViolations: violations,
    score: scoreResult.score,
    classification: scoreResult.classification,
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

  const manifest = await runEvidenceStep(input.evidenceWriter, runContext);

  return {
    status,
    confidenceScore: scoreResult,
    evidencePath: input.evidenceRoot,
    branchName,
    summary,
    policyDecisions,
    manifest
  };
}
