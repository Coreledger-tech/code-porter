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
    expect(policy.maxVerifyMinutesPerRun).toBe(20);
    expect(policy.maxVerifyRetries).toBe(2);
    expect(policy.maxEvidenceZipBytes).toBe(52428800);
    expect(policy.defaultRecipePack).toBe("java-maven-plugin-modernize");
    expect(policy.verifyFailureMode).toBe("warn");
    expect(policy.verify.blockingFailureKinds).toEqual([
      "code_compile_failure",
      "code_test_failure",
      "code_failure",
      "java17_plugin_incompat",
      "java17_module_access_test_failure"
    ]);
    expect(policy.verify.nonBlockingFailureKinds).toContain("artifact_resolution");
    expect(policy.verify.retryOnCachedResolution).toBe(true);
    expect(policy.verify.maven.forceUpdate).toBe(true);
    expect(policy.gradle?.allowAndroidBaselineApply).toBe(false);
    expect(policy.remediation?.mavenCompile?.enabled).toBe(false);
    expect(policy.remediation?.mavenTestRuntime?.enabled).toBe(false);
    expect(policy.remediation?.mavenTestRuntime?.allowedFixes).toContain(
      "ensure_add_opens_java_nio"
    );
    expect(policy.remediation?.mavenTestRuntime?.allowedFixes).toContain(
      "ensure_add_opens_java_lang"
    );
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

    expect(policy.verify.blockingFailureKinds).toEqual([
      "code_compile_failure",
      "code_test_failure",
      "code_failure",
      "java17_plugin_incompat",
      "java17_module_access_test_failure"
    ]);
    expect(policy.verify.nonBlockingFailureKinds).toContain("unknown");
    expect(policy.maxVerifyMinutesPerRun).toBe(20);
    expect(policy.maxVerifyRetries).toBe(2);
    expect(policy.maxEvidenceZipBytes).toBe(52428800);
    expect(policy.defaultRecipePack).toBe("java-maven-plugin-modernize");
    expect(policy.maxInflightRunsPerProject).toBe(2);
    expect(policy.maxInflightRunsGlobal).toBe(10);
  });

  it("allows gradle android subtype when policy enables guarded baseline apply mode", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "code-porter-policy-"));
    const policyPath = join(tempDir, "gradle-android-allow.yaml");
    await writeFile(
      policyPath,
      [
        "allowedBuildSystems:",
        "  - maven",
        "  - gradle",
        "gradle:",
        "  allowAndroidBaselineApply: true",
        "confidenceThresholds:",
        "  pass: 70",
        "  needsReview: 55"
      ].join("\n"),
      "utf8"
    );

    const engine = new YamlPolicyEngine();
    const policy = await engine.load(policyPath);

    expect(policy.gradle?.allowAndroidBaselineApply).toBe(true);
    const decisions = engine.evaluatePlan(
      {
        buildSystem: "gradle",
        filesChanged: 1,
        linesChanged: 8,
        buildSystemDisposition: "unsupported_subtype",
        buildSystemReason: "Gradle Android projects are out of scope for the Stage 3 JVM-only lane",
        gradleProjectType: "android"
      },
      policy
    );

    expect(
      decisions.some(
        (decision) =>
          decision.id === "allowed_build_system" &&
          decision.status === "allow" &&
          decision.reason.includes("baseline apply mode is enabled")
      )
    ).toBe(true);
  });

  it("parses stage6 test-runtime remediation policy controls", async () => {
    const engine = new YamlPolicyEngine();
    const policy = await engine.load(resolve(process.cwd(), "policies/pilot-stage6.yaml"));

    expect(policy.verify.blockingFailureKinds).toContain("java17_module_access_test_failure");
    expect(policy.remediation?.mavenTestRuntime?.enabled).toBe(true);
    expect(policy.remediation?.mavenTestRuntime?.allowedFixes).toEqual([
      "ensure_add_opens_sun_nio_ch"
    ]);
  });

  it("parses stage8 Chronicle test-runtime remediation controls", async () => {
    const engine = new YamlPolicyEngine();
    const policy = await engine.load(resolve(process.cwd(), "policies/pilot-stage8.yaml"));

    expect(policy.defaultRecipePack).toBe("java-maven-test-compat-stage8-pack");
    expect(policy.gradle?.allowAndroidBaselineApply).toBe(true);
    expect(policy.remediation?.mavenTestRuntime?.enabled).toBe(true);
    expect(policy.remediation?.mavenTestRuntime?.allowedFixes).toEqual([
      "ensure_add_opens_sun_nio_ch",
      "ensure_add_opens_java_nio",
      "ensure_add_opens_java_lang"
    ]);
  });
});
