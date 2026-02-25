import type { PolicyConfig, ScoreResult, VerifySummary } from "./models.js";

export function computeConfidenceScore(input: {
  verify: VerifySummary;
  filesChanged: number;
  linesChanged: number;
  policyViolations: number;
  policy: PolicyConfig;
}): ScoreResult {
  const compilePoints = input.verify.compile.status === "passed" ? 40 : 0;

  let testPoints = 0;
  if (input.verify.tests.status === "passed") {
    testPoints = 25;
  } else if (
    input.verify.tests.status === "not_run" &&
    !input.verify.hasTests &&
    !input.policy.requireTestsIfPresent
  ) {
    testPoints = 10;
  }

  const staticPoints = input.verify.staticChecks.status === "passed" ? 15 : 0;
  const changeSizePoints = Math.max(
    0,
    10 - Math.floor(input.linesChanged / 100) - input.filesChanged
  );
  const violationPenalty = input.policyViolations * 15;

  const rawScore =
    compilePoints +
    testPoints +
    staticPoints +
    changeSizePoints -
    violationPenalty;

  const score = Math.max(0, Math.min(100, rawScore));
  const classification =
    score >= input.policy.confidenceThresholds.pass
      ? "pass"
      : "needs_review";

  return {
    score,
    classification,
    breakdown: {
      compilePoints,
      testPoints,
      staticPoints,
      changeSizePoints,
      violationPenalty
    }
  };
}
