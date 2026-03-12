import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeContextSemanticRetrievalProvider,
  createSemanticRetrievalProviderFromEnv,
  NoopSemanticRetrievalProvider
} from "./semantic-retrieval.js";

const scan = {
  buildSystem: "maven" as const,
  hasTests: true,
  metadata: {
    gitBranch: "main",
    toolAvailability: { mvn: true, gradle: false, npm: false, node: true },
    detectedFiles: ["pom.xml"],
    selectedManifestPath: "pom.xml",
    selectedBuildRoot: "."
  }
};

const verifyFailure = {
  buildSystem: "maven" as const,
  hasTests: true,
  compile: { status: "passed" as const },
  tests: {
    status: "failed" as const,
    failureKind: "code_test_failure" as const,
    reason: "Tests failed",
    output: "java.lang.AssertionError"
  },
  staticChecks: { status: "passed" as const }
};

const verifyFailureWithToken = {
  ...verifyFailure,
  tests: {
    ...verifyFailure.tests,
    output: "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456"
  }
};

describe("semantic retrieval provider", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns noop provider when disabled by env", () => {
    process.env.SEMANTIC_RETRIEVAL_ENABLED = "false";
    const provider = createSemanticRetrievalProviderFromEnv();
    expect(provider).toBeInstanceOf(NoopSemanticRetrievalProvider);
    expect(provider.enabled).toBe(false);
  });

  it("uses claude-context core function when available", async () => {
    const provider = new ClaudeContextSemanticRetrievalProvider({
      coreLoader: async () => ({
        retrieveTopK: async () => [
          {
            filePath: "src/main/java/App.java",
            score: 0.91,
            reason: "contains referenced symbol"
          }
        ]
      })
    });

    const result = await provider.retrieve({
      repoPath: "/tmp/repo",
      scan,
      verify: verifyFailure,
      topK: 3,
      filePaths: ["src/main/java/App.java", "pom.xml"]
    });

    expect(result.provider).toBe("claude_context");
    expect(result.hits[0]?.filePath).toBe("src/main/java/App.java");
    expect(result.hits[0]?.score).toBe(0.91);
  });

  it("falls back to lexical ranking when core exposes no supported function", async () => {
    const provider = new ClaudeContextSemanticRetrievalProvider({
      coreLoader: async () => ({})
    });

    const result = await provider.retrieve({
      repoPath: "/tmp/repo",
      scan,
      verify: verifyFailure,
      topK: 2,
      filePaths: ["src/test/java/FailingTest.java", "pom.xml", "README.md"]
    });

    expect(result.metadata?.fallback).toBe(true);
    expect(result.hits).toHaveLength(2);
  });

  it("propagates loader errors so callers can record non-fatal evidence", async () => {
    const provider = new ClaudeContextSemanticRetrievalProvider({
      coreLoader: async () => {
        throw new Error("module not installed");
      }
    });

    await expect(
      provider.retrieve({
        repoPath: "/tmp/repo",
        scan,
        verify: verifyFailure,
        topK: 2,
        filePaths: ["pom.xml"]
      })
    ).rejects.toThrow("module not installed");
  });

  it("sanitizes sensitive tokens in retrieval query and hits", async () => {
    const noop = new NoopSemanticRetrievalProvider();
    const noopResult = await noop.retrieve({
      repoPath: "/tmp/repo",
      scan,
      verify: verifyFailureWithToken,
      topK: 2,
      filePaths: ["src/test/java/TokenTest.java"]
    });
    expect(noopResult.query).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(noopResult.query).toContain("ghp_[REDACTED]");

    const provider = new ClaudeContextSemanticRetrievalProvider({
      coreLoader: async () => ({
        retrieveTopK: async () => [
          {
            filePath: "src/test/java/Secrets.java",
            score: 0.9,
            reason: "Bearer ghp_abcdefghijklmnopqrstuvwxyz123456"
          }
        ]
      })
    });

    const result = await provider.retrieve({
      repoPath: "/tmp/repo",
      scan,
      verify: verifyFailureWithToken,
      topK: 1,
      filePaths: ["src/test/java/Secrets.java"]
    });
    expect(result.hits[0]?.reason).toContain("[REDACTED]");
    expect(result.hits[0]?.reason).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
  });
});
