import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { YamlPolicyEngine } from "./policy.js";

describe("YamlPolicyEngine", () => {
  it("loads default policy yaml", async () => {
    const engine = new YamlPolicyEngine();
    const policy = await engine.load(resolve(process.cwd(), "policies/default.yaml"));

    expect(policy.maxChangeLines).toBe(300);
    expect(policy.maxFilesChanged).toBe(10);
    expect(policy.allowedBuildSystems).toContain("maven");
    expect(policy.verifyFailureMode).toBe("warn");
    expect(policy.confidenceThresholds.pass).toBe(70);
  });

  it("enforces plan limits", async () => {
    const engine = new YamlPolicyEngine();
    const policy = await engine.load(resolve(process.cwd(), "policies/default.yaml"));

    const decisions = engine.evaluatePlan(
      {
        buildSystem: "maven",
        filesChanged: 12,
        linesChanged: 450
      },
      policy
    );

    expect(decisions.some((decision) => decision.id === "max_files_changed" && decision.status === "deny")).toBe(true);
    expect(decisions.some((decision) => decision.id === "max_change_lines" && decision.status === "deny")).toBe(true);
  });

  it("marks verify failures as warnings when verifyFailureMode is warn", async () => {
    const engine = new YamlPolicyEngine();
    const policy = await engine.load(resolve(process.cwd(), "policies/default.yaml"));

    const decisions = engine.evaluateVerify(
      {
        buildSystem: "maven",
        hasTests: true,
        compile: { status: "failed" },
        tests: { status: "not_run", reason: "mvn missing" },
        staticChecks: { status: "passed" }
      },
      policy
    );

    expect(
      decisions.some(
        (decision) =>
          decision.id === "compile_must_pass" &&
          decision.status === "warn" &&
          decision.blocking === false
      )
    ).toBe(true);
    expect(
      decisions.some(
        (decision) =>
          decision.id === "tests_required_if_present" &&
          decision.status === "warn" &&
          decision.blocking === false
      )
    ).toBe(true);
  });
});
