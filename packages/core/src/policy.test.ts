import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { YamlPolicyEngine } from "./policy.js";

describe("YamlPolicyEngine", () => {
  it("loads default policy yaml with structured verify config", async () => {
    const engine = new YamlPolicyEngine();
    const policy = await engine.load(resolve(process.cwd(), "policies/default.yaml"));

    expect(policy.maxChangeLines).toBe(300);
    expect(policy.maxFilesChanged).toBe(10);
    expect(policy.allowedBuildSystems).toContain("maven");
    expect(policy.maxInflightRunsPerProject).toBe(2);
    expect(policy.maxInflightRunsGlobal).toBe(10);
    expect(policy.verifyFailureMode).toBe("warn");
    expect(policy.verify.blockingFailureKinds).toEqual(["code_failure"]);
    expect(policy.verify.nonBlockingFailureKinds).toContain("artifact_resolution");
    expect(policy.verify.retryOnCachedResolution).toBe(true);
    expect(policy.verify.maven.forceUpdate).toBe(true);
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

    expect(
      decisions.some(
        (decision) =>
          decision.id === "max_files_changed" && decision.status === "deny"
      )
    ).toBe(true);
    expect(
      decisions.some(
        (decision) =>
          decision.id === "max_change_lines" && decision.status === "deny"
      )
    ).toBe(true);
  });

  it("maps infra failure kinds to warnings and code failures to denies", async () => {
    const engine = new YamlPolicyEngine();
    const policy = await engine.load(resolve(process.cwd(), "policies/default.yaml"));

    const infraDecisions = engine.evaluateVerify(
      {
        buildSystem: "maven",
        hasTests: true,
        compile: {
          status: "failed",
          failureKind: "artifact_resolution"
        },
        tests: {
          status: "failed",
          failureKind: "repo_unreachable"
        },
        staticChecks: { status: "passed" }
      },
      policy
    );

    expect(
      infraDecisions.some(
        (decision) =>
          decision.id === "compile_blocked(artifact_resolution)" &&
          decision.status === "warn" &&
          decision.blocking === false
      )
    ).toBe(true);

    const codeDecisions = engine.evaluateVerify(
      {
        buildSystem: "maven",
        hasTests: true,
        compile: {
          status: "failed",
          failureKind: "code_failure"
        },
        tests: {
          status: "passed"
        },
        staticChecks: { status: "passed" }
      },
      policy
    );

    expect(
      codeDecisions.some(
        (decision) =>
          decision.id === "compile_must_pass(code_failure)" &&
          decision.status === "deny" &&
          decision.blocking
      )
    ).toBe(true);
  });

  it("falls back to legacy verifyFailureMode when verify block is absent", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "code-porter-policy-"));
    const policyPath = join(tempDir, "legacy-policy.yaml");
    await writeFile(
      policyPath,
      [
        "maxChangeLines: 100",
        "maxFilesChanged: 2",
        "requireTestsIfPresent: true",
        "allowedBuildSystems:",
        "  - maven",
        "verifyFailureMode: warn",
        "confidenceThresholds:",
        "  pass: 70",
        "  needsReview: 55"
      ].join("\n"),
      "utf8"
    );

    const engine = new YamlPolicyEngine();
    const policy = await engine.load(policyPath);

    expect(policy.verify.blockingFailureKinds).toEqual(["code_failure"]);
    expect(policy.verify.nonBlockingFailureKinds).toContain("unknown");
    expect(policy.maxInflightRunsPerProject).toBe(2);
    expect(policy.maxInflightRunsGlobal).toBe(10);
  });
});
