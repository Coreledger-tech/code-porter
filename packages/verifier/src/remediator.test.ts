import { describe, expect, it, vi } from "vitest";
import type { PolicyConfig, VerifySummary } from "@code-porter/core/src/models.js";
import { MavenDeterministicRemediator } from "./remediator.js";

const basePolicy: PolicyConfig = {
  maxChangeLines: 300,
  maxFilesChanged: 10,
  requireTestsIfPresent: true,
  maxInflightRunsPerProject: 2,
  maxInflightRunsGlobal: 10,
  allowedBuildSystems: ["maven"],
  verifyFailureMode: "warn",
  verify: {
    blockingFailureKinds: ["code_failure"],
    nonBlockingFailureKinds: ["tool_missing", "artifact_resolution", "repo_unreachable"],
    retryOnCachedResolution: false,
    maven: {
      forceUpdate: false,
      prefetchPlugins: false,
      purgeLocalCache: false
    }
  },
  confidenceThresholds: {
    pass: 70,
    needsReview: 55
  }
};

describe("MavenDeterministicRemediator", () => {
  it("applies only for maven infra-blocked verify results", () => {
    const remediator = new MavenDeterministicRemediator();
    const verify: VerifySummary = {
      buildSystem: "maven",
      hasTests: true,
      compile: { status: "failed", failureKind: "artifact_resolution" },
      tests: { status: "failed", failureKind: "repo_unreachable" },
      staticChecks: { status: "passed" }
    };

    expect(remediator.appliesTo({ scan: { buildSystem: "maven", hasTests: true, metadata: { gitBranch: null, toolAvailability: { mvn: true, gradle: false, npm: false, node: true }, detectedFiles: ["pom.xml"] } }, verify, policy: basePolicy })).toBe(true);

    const codeFailure = {
      ...verify,
      compile: { status: "failed" as const, failureKind: "code_failure" as const }
    };

    expect(remediator.appliesTo({ scan: { buildSystem: "maven", hasTests: true, metadata: { gitBranch: null, toolAvailability: { mvn: true, gradle: false, npm: false, node: true }, detectedFiles: ["pom.xml"] } }, verify: codeFailure, policy: basePolicy })).toBe(false);
  });

  it("reruns verifier and returns remediation artifact details", async () => {
    const remediator = new MavenDeterministicRemediator();

    const initial: VerifySummary = {
      buildSystem: "maven",
      hasTests: true,
      compile: { status: "failed", failureKind: "artifact_resolution" },
      tests: { status: "failed", failureKind: "artifact_resolution" },
      staticChecks: { status: "passed" }
    };

    const finalSummary: VerifySummary = {
      buildSystem: "maven",
      hasTests: true,
      compile: { status: "passed" },
      tests: { status: "passed" },
      staticChecks: { status: "passed" }
    };

    const verifier = {
      run: vi.fn().mockResolvedValue(finalSummary)
    };

    const result = await remediator.run({
      scan: {
        buildSystem: "maven",
        hasTests: true,
        metadata: {
          gitBranch: null,
          toolAvailability: { mvn: true, gradle: false, npm: false, node: true },
          detectedFiles: ["pom.xml"]
        }
      },
      verify: initial,
      repoPath: "/tmp/non-existent",
      policy: basePolicy,
      verifier
    });

    expect(verifier.run).toHaveBeenCalledTimes(1);
    expect(result.verifySummary.compile.status).toBe("passed");
    expect(Array.isArray(result.actions)).toBe(true);
  });
});
