import type { PolicyConfig, ScanResult, VerifySummary } from "../models.js";
import type { VerifierPort } from "../workflow-runner.js";

export function createSkippedVerifySummary(scan: ScanResult, reason: string): VerifySummary {
  return {
    buildSystem: scan.buildSystem,
    hasTests: scan.hasTests,
    compile: { status: "not_run", reason },
    tests: { status: "not_run", reason },
    staticChecks: { status: "not_run", reason }
  };
}

export async function runVerifyStep(input: {
  verifier: VerifierPort;
  scan: ScanResult;
  repoPath: string;
  policy: PolicyConfig;
  shouldRun: boolean;
}): Promise<VerifySummary> {
  if (!input.shouldRun) {
    return createSkippedVerifySummary(
      input.scan,
      "verification skipped for plan mode"
    );
  }

  return input.verifier.run(input.scan, input.repoPath, input.policy);
}
