import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const { runCommandMock } = vi.hoisted(() => {
  return {
    runCommandMock: vi.fn()
  };
});

vi.mock("./commands.js", async () => {
  const actual = await vi.importActual<typeof import("./commands.js")>("./commands.js");
  return {
    ...actual,
    runCommand: runCommandMock
  };
});

import type { PolicyConfig } from "@code-porter/core/src/models.js";
import { DefaultVerifier } from "./index.js";

const basePolicy: PolicyConfig = {
  maxChangeLines: 300,
  maxFilesChanged: 10,
  requireTestsIfPresent: true,
  maxInflightRunsPerProject: 2,
  maxInflightRunsGlobal: 10,
  maxVerifyMinutesPerRun: 20,
  maxVerifyRetries: 2,
  maxEvidenceZipBytes: 52428800,
  defaultRecipePack: "java-maven-plugin-modernize",
  allowedBuildSystems: ["maven"],
  verifyFailureMode: "warn",
  verify: {
    blockingFailureKinds: ["code_failure"],
    nonBlockingFailureKinds: [
      "tool_missing",
      "artifact_resolution",
      "repo_unreachable",
      "budget_exceeded"
    ],
    retryOnCachedResolution: true,
    maven: {
      forceUpdate: true,
      prefetchPlugins: true,
      purgeLocalCache: true
    }
  },
  confidenceThresholds: {
    pass: 70,
    needsReview: 55
  }
};

describe("DefaultVerifier budgets", () => {
  it("classifies timed out verify command as budget_exceeded", async () => {
    runCommandMock.mockReset();
    runCommandMock.mockResolvedValueOnce({
      status: "failed",
      command: "mvn -q -DskipTests compile",
      reason: "command timed out",
      timedOut: true
    });

    const repo = await mkdtemp(join(tmpdir(), "code-porter-verifier-budget-timeout-"));
    await writeFile(join(repo, "pom.xml"), "<project></project>", "utf8");

    const verifier = new DefaultVerifier();
    const result = await verifier.run(
      {
        buildSystem: "maven",
        hasTests: false,
        metadata: {
          gitBranch: "main",
          toolAvailability: {
            mvn: true,
            gradle: false,
            npm: false,
            node: true
          },
          detectedFiles: ["pom.xml"]
        }
      },
      repo,
      {
        ...basePolicy,
        maxVerifyMinutesPerRun: 1,
        verify: {
          ...basePolicy.verify,
          maven: {
            ...basePolicy.verify.maven,
            prefetchPlugins: false
          }
        }
      }
    );

    expect(result.compile.failureKind).toBe("budget_exceeded");
    expect(result.compile.budgetKey).toBe("maxVerifyMinutesPerRun");
    expect(result.compile.blockedReason).toContain("maxVerifyMinutesPerRun");
  });

  it("stops retry loop when maxVerifyRetries budget is reached", async () => {
    runCommandMock.mockReset();
    runCommandMock
      .mockResolvedValueOnce({
        status: "passed",
        command: "mvn -q -U dependency:resolve-plugins"
      })
      .mockResolvedValueOnce({
        status: "failed",
        command: "mvn -q -DskipTests compile",
        output: "resolution is not reattempted until the update interval"
      })
      .mockResolvedValueOnce({
        status: "failed",
        command: "mvn -U -q -DskipTests compile",
        output: "resolution is not reattempted until the update interval"
      });

    const repo = await mkdtemp(join(tmpdir(), "code-porter-verifier-budget-retry-"));
    await writeFile(join(repo, "pom.xml"), "<project></project>", "utf8");

    const verifier = new DefaultVerifier();
    const result = await verifier.run(
      {
        buildSystem: "maven",
        hasTests: false,
        metadata: {
          gitBranch: "main",
          toolAvailability: {
            mvn: true,
            gradle: false,
            npm: false,
            node: true
          },
          detectedFiles: ["pom.xml"]
        }
      },
      repo,
      {
        ...basePolicy,
        maxVerifyRetries: 1
      }
    );

    expect(result.compile.failureKind).toBe("budget_exceeded");
    expect(result.compile.budgetKey).toBe("maxVerifyRetries");
    expect(result.compile.budgetLimit).toBe(1);
    expect(result.compile.attempts?.length).toBe(3);
  });
});
