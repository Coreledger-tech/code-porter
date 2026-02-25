import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type {
  PlanMetrics,
  PolicyConfig,
  PolicyDecision,
  VerifySummary
} from "./models.js";
import type { PolicyEngine } from "./workflow-runner.js";

const DEFAULT_POLICY: PolicyConfig = {
  maxChangeLines: 300,
  maxFilesChanged: 10,
  requireTestsIfPresent: true,
  allowedBuildSystems: ["maven", "gradle", "node"],
  verifyFailureMode: "deny",
  confidenceThresholds: {
    pass: 70,
    needsReview: 55
  }
};

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  return fallback;
}

function asVerifyFailureMode(
  value: unknown,
  fallback: PolicyConfig["verifyFailureMode"]
): PolicyConfig["verifyFailureMode"] {
  if (value === "deny" || value === "warn") {
    return value;
  }
  return fallback;
}

function normalizePolicy(raw: unknown): PolicyConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  const thresholds = (config.confidenceThresholds ?? {}) as Record<string, unknown>;

  return {
    maxChangeLines: asNumber(config.maxChangeLines, DEFAULT_POLICY.maxChangeLines),
    maxFilesChanged: asNumber(config.maxFilesChanged, DEFAULT_POLICY.maxFilesChanged),
    requireTestsIfPresent: asBoolean(
      config.requireTestsIfPresent,
      DEFAULT_POLICY.requireTestsIfPresent
    ),
    allowedBuildSystems: asStringArray(
      config.allowedBuildSystems,
      DEFAULT_POLICY.allowedBuildSystems
    ).filter((item): item is PolicyConfig["allowedBuildSystems"][number] => {
      return ["maven", "gradle", "node", "unknown"].includes(item);
    }),
    verifyFailureMode: asVerifyFailureMode(
      config.verifyFailureMode,
      DEFAULT_POLICY.verifyFailureMode
    ),
    confidenceThresholds: {
      pass: asNumber(thresholds.pass, DEFAULT_POLICY.confidenceThresholds.pass),
      needsReview: asNumber(
        thresholds.needsReview,
        DEFAULT_POLICY.confidenceThresholds.needsReview
      )
    }
  };
}

export class YamlPolicyEngine implements PolicyEngine {
  async load(path: string): Promise<PolicyConfig> {
    const file = await readFile(path, "utf8");
    const parsed = parse(file);
    return normalizePolicy(parsed);
  }

  evaluatePlan(input: PlanMetrics, policy: PolicyConfig): PolicyDecision[] {
    const decisions: PolicyDecision[] = [];

    if (!policy.allowedBuildSystems.includes(input.buildSystem)) {
      decisions.push({
        id: "allowed_build_system",
        stage: "scan",
        status: "deny",
        reason: `Build system '${input.buildSystem}' is not allowed by policy`,
        blocking: true
      });
    } else {
      decisions.push({
        id: "allowed_build_system",
        stage: "scan",
        status: "allow",
        reason: `Build system '${input.buildSystem}' is allowed`,
        blocking: false
      });
    }

    if (input.filesChanged > policy.maxFilesChanged) {
      decisions.push({
        id: "max_files_changed",
        stage: "plan",
        status: "deny",
        reason: `Planned file changes (${input.filesChanged}) exceed maxFilesChanged (${policy.maxFilesChanged})`,
        blocking: true
      });
    } else {
      decisions.push({
        id: "max_files_changed",
        stage: "plan",
        status: "allow",
        reason: `Planned file changes (${input.filesChanged}) are within limit`,
        blocking: false
      });
    }

    if (input.linesChanged > policy.maxChangeLines) {
      decisions.push({
        id: "max_change_lines",
        stage: "plan",
        status: "deny",
        reason: `Planned line changes (${input.linesChanged}) exceed maxChangeLines (${policy.maxChangeLines})`,
        blocking: true
      });
    } else {
      decisions.push({
        id: "max_change_lines",
        stage: "plan",
        status: "allow",
        reason: `Planned line changes (${input.linesChanged}) are within limit`,
        blocking: false
      });
    }

    return decisions;
  }

  evaluateVerify(input: VerifySummary, policy: PolicyConfig): PolicyDecision[] {
    const decisions: PolicyDecision[] = [];
    const shouldWarn = policy.verifyFailureMode === "warn";
    const failStatus = shouldWarn ? "warn" : "deny";
    const failBlocking = !shouldWarn;

    if (input.compile.status !== "passed") {
      decisions.push({
        id: "compile_must_pass",
        stage: "verify",
        status: failStatus,
        reason: "Compile/build check did not pass",
        blocking: failBlocking
      });
    } else {
      decisions.push({
        id: "compile_must_pass",
        stage: "verify",
        status: "allow",
        reason: "Compile/build check passed",
        blocking: false
      });
    }

    if (policy.requireTestsIfPresent && input.hasTests && input.tests.status !== "passed") {
      decisions.push({
        id: "tests_required_if_present",
        stage: "verify",
        status: failStatus,
        reason: "Tests are present and required but did not pass",
        blocking: failBlocking
      });
    } else {
      decisions.push({
        id: "tests_required_if_present",
        stage: "verify",
        status: "allow",
        reason: input.hasTests
          ? "Tests requirement satisfied"
          : "No tests detected; requirement not applicable",
        blocking: false
      });
    }

    if (input.staticChecks.status === "failed") {
      decisions.push({
        id: "static_checks",
        stage: "verify",
        status: "deny",
        reason: "Static checks failed",
        blocking: true
      });
    } else if (input.staticChecks.status === "not_run") {
      decisions.push({
        id: "static_checks",
        stage: "verify",
        status: "warn",
        reason: "Static checks were not run",
        blocking: false
      });
    } else {
      decisions.push({
        id: "static_checks",
        stage: "verify",
        status: "allow",
        reason: "Static checks passed",
        blocking: false
      });
    }

    return decisions;
  }
}

export function countPolicyViolations(decisions: PolicyDecision[]): number {
  return decisions.filter((decision) => decision.status === "deny").length;
}

export function hasBlockingDecision(decisions: PolicyDecision[]): boolean {
  return decisions.some((decision) => decision.blocking);
}
