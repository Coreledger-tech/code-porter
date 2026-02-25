import type { VerifySummary } from "../models.js";
import type { VerifierPort } from "../workflow-runner.js";

export function createSkippedVerifySummary(buildSystem: VerifySummary["buildSystem"], reason: string): VerifySummary {
  return {
    buildSystem,
    hasTests: false,
    compile: { status: "not_run", reason },
    tests: { status: "not_run", reason },
    staticChecks: { status: "not_run", reason }
  };
}

export async function runVerifyStep(input: {
  verifier: VerifierPort;
  scan: { buildSystem: VerifySummary["buildSystem"] } & {
    hasTests: boolean;
    metadata: VerifySummary extends infer _ ? never : never;
  };
  repoPath: string;
  policy: Parameters<VerifierPort["run"]>[2];
  shouldRun: boolean;
}): Promise<VerifySummary> {
  if (!input.shouldRun) {
    return {
      buildSystem: input.scan.buildSystem,
      hasTests: input.scan.hasTests,
      compile: { status: "not_run", reason: "verification skipped for plan mode" },
      tests: { status: "not_run", reason: "verification skipped for plan mode" },
      staticChecks: { status: "not_run", reason: "verification skipped for plan mode" }
    };
  }

  return input.verifier.run(input.scan as any, input.repoPath, input.policy);
}
