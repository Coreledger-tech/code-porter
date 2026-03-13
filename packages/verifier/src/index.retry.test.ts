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

const policy: PolicyConfig = {
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

describe("DefaultVerifier Maven retries", () => {
  it("prefetches and retries with -U on cached artifact resolution", async () => {
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
        status: "passed",
        command: "mvn -U -q -DskipTests compile"
      })
      .mockResolvedValueOnce({
        status: "passed",
        command: "mvn -q test"
      });

    const repo = await mkdtemp(join(tmpdir(), "code-porter-verifier-retry-"));
    await writeFile(join(repo, "pom.xml"), "<project></project>", "utf8");

    const verifier = new DefaultVerifier();
    const result = await verifier.run(
      {
        buildSystem: "maven",
        hasTests: true,
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
      policy
    );

    expect(result.compile.status).toBe("passed");
    expect(result.compile.attempts?.length).toBe(3);
    expect(result.compile.attempts?.[0]?.retryReason).toBe("prefetch_plugins");
    expect(result.compile.attempts?.[2]?.retryReason).toBe(
      "retry_force_update_cached_resolution"
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      {
        command: "mvn",
        args: ["-U", "-q", "-DskipTests", "compile"]
      },
      repo,
      expect.objectContaining({
        timeoutMs: expect.any(Number)
      })
    );
  });

  it("purges local cache and retries again when cached resolution persists", async () => {
    runCommandMock.mockReset();
    runCommandMock
      .mockResolvedValueOnce({
        status: "passed",
        command: "mvn -q -U dependency:resolve-plugins"
      })
      .mockResolvedValueOnce({
        status: "failed",
        command: "mvn -q -DskipTests compile",
        output: "was not found in central during a previous attempt"
      })
      .mockResolvedValueOnce({
        status: "failed",
        command: "mvn -U -q -DskipTests compile",
        output: "resolution is not reattempted until the update interval"
      })
      .mockResolvedValueOnce({
        status: "passed",
        command: "mvn -q dependency:purge-local-repository"
      })
      .mockResolvedValueOnce({
        status: "passed",
        command: "mvn -U -q -DskipTests compile"
      });

    const repo = await mkdtemp(join(tmpdir(), "code-porter-verifier-purge-"));
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
      policy
    );

    expect(result.compile.status).toBe("passed");
    expect(
      result.compile.attempts?.some(
        (attempt) => attempt.retryReason === "purge_local_cache_before_retry"
      )
    ).toBe(true);
    expect(
      result.compile.attempts?.some(
        (attempt) => attempt.retryReason === "retry_after_purge_local_cache"
      )
    ).toBe(true);
  });
});
