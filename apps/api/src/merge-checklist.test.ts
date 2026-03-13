import { mkdtemp } from "node:fs/promises";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PolicyConfig, ScanResult, VerifySummary } from "@code-porter/core/src/models.js";
import { runGit } from "@code-porter/workspace/src/git.js";
import { evaluateMergeChecklist, isLikelyParseableXml } from "./merge-checklist.js";

const cleanupPaths: string[] = [];

const basePolicy: PolicyConfig = {
  maxChangeLines: 120,
  maxFilesChanged: 6,
  requireTestsIfPresent: true,
  maxInflightRunsPerProject: 1,
  maxInflightRunsGlobal: 2,
  maxVerifyMinutesPerRun: 15,
  maxVerifyRetries: 1,
  maxEvidenceZipBytes: 10_000_000,
  defaultRecipePack: "java-maven-test-compat-stage8-pack",
  allowedBuildSystems: ["maven", "gradle"],
  verifyFailureMode: "deny",
  verify: {
    blockingFailureKinds: ["code_compile_failure", "code_test_failure"],
    nonBlockingFailureKinds: ["tool_missing"],
    retryOnCachedResolution: true,
    maven: {
      forceUpdate: true,
      prefetchPlugins: true,
      purgeLocalCache: false
    }
  },
  gradle: {
    allowAndroidBaselineApply: true
  },
  confidenceThresholds: {
    pass: 80,
    needsReview: 60
  }
};

const passingVerify: VerifySummary = {
  buildSystem: "maven",
  hasTests: true,
  compile: { status: "passed" },
  tests: { status: "passed" },
  staticChecks: { status: "passed" }
};

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    })
  );
});

async function prepareRepo(input: {
  repoName: string;
  scan: ScanResult;
  mutateFiles: Record<string, string>;
  evidence?: Record<string, string>;
}): Promise<{
  repoPath: string;
  evidencePath: string;
  commitBefore: string;
  commitAfter: string;
}> {
  const repoPath = await mkdtemp(join(tmpdir(), `${input.repoName}-`));
  cleanupPaths.push(repoPath);
  const fixturePath = resolve(process.cwd(), "fixtures/java-maven-simple");
  await cp(fixturePath, repoPath, { recursive: true });

  await runGit(["init"], { cwd: repoPath });
  await runGit(["config", "user.email", "integration@codeporter.local"], { cwd: repoPath });
  await runGit(["config", "user.name", "Code Porter Tests"], { cwd: repoPath });
  await runGit(["add", "."], { cwd: repoPath });
  await runGit(["commit", "-m", "baseline"], { cwd: repoPath });
  const commitBefore = (await runGit(["rev-parse", "HEAD"], { cwd: repoPath })).stdout;

  for (const [relativePath, content] of Object.entries(input.mutateFiles)) {
    await mkdir(dirname(join(repoPath, relativePath)), { recursive: true });
    await writeFile(join(repoPath, relativePath), content, "utf8");
  }

  await runGit(["add", "."], { cwd: repoPath });
  await runGit(["commit", "-m", "mutated"], { cwd: repoPath });
  const commitAfter = (await runGit(["rev-parse", "HEAD"], { cwd: repoPath })).stdout;

  const evidencePath = join(repoPath, ".evidence");
  await mkdir(evidencePath, { recursive: true });
  await writeFile(join(evidencePath, "scan.json"), JSON.stringify(input.scan, null, 2), "utf8");
  for (const [artifactPath, content] of Object.entries(input.evidence ?? { "verify.json": "{}" })) {
    await mkdir(join(evidencePath, artifactPath, ".."), { recursive: true });
    await writeFile(join(evidencePath, artifactPath), content, "utf8");
  }

  return {
    repoPath,
    evidencePath,
    commitBefore,
    commitAfter
  };
}

describe("merge-checklist", () => {
  it("detects malformed XML and out-of-scope files as hard failures", async () => {
    const badPom = "<project><build><plugins></build></project>";
    const scan: ScanResult = {
      buildSystem: "maven",
      hasTests: true,
      metadata: {
        gitBranch: "main",
        toolAvailability: { mvn: true, gradle: false, npm: false, node: true },
        detectedFiles: ["pom.xml"],
        selectedBuildRoot: ".",
        selectedManifestPath: "pom.xml",
        buildSystemDisposition: "supported",
        buildSystemReason: "Selected build system 'maven' from 'pom.xml'"
      }
    };

    const prepared = await prepareRepo({
      repoName: "merge-checklist-hard-fail",
      scan,
      mutateFiles: {
        "pom.xml": badPom,
        "src/main/java/ScopeLeak.java": "class ScopeLeak {}\n"
      }
    });

    const result = await evaluateMergeChecklist({
      workspacePath: prepared.repoPath,
      evidencePath: prepared.evidencePath,
      commitBefore: prepared.commitBefore,
      commitAfter: prepared.commitAfter,
      changedFiles: 2,
      changedLines: 8,
      policy: basePolicy,
      scan,
      verifySummary: passingVerify,
      summary: {
        applySummary: {
          remediation: {
            rulesApplied: []
          }
        }
      }
    });

    expect(result.summary.passed).toBe(false);
    expect(result.artifact.reasons.some((reason) => reason.includes("lane scope"))).toBe(true);
    expect(result.artifact.reasons.some((reason) => reason.includes("not parseable"))).toBe(true);
  });

  it("records guarded Android no-op as an advisory instead of a failure", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "merge-checklist-android-noop-"));
    cleanupPaths.push(repoPath);
    await mkdir(repoPath, { recursive: true });
    const evidencePath = join(repoPath, ".evidence");
    await mkdir(evidencePath, { recursive: true });
    await writeFile(join(evidencePath, "verify.json"), "{}", "utf8");

    const scan: ScanResult = {
      buildSystem: "gradle",
      hasTests: false,
      metadata: {
        gitBranch: "main",
        toolAvailability: { mvn: false, gradle: true, npm: false, node: true },
        detectedFiles: ["build.gradle", "gradle.properties"],
        selectedBuildRoot: ".",
        selectedManifestPath: "build.gradle",
        buildSystemDisposition: "supported",
        buildSystemReason:
          "Gradle Android baseline apply mode is enabled; deterministic guarded baseline will run while full Gradle task execution remains out of scope",
        gradleProjectType: "android",
        gradleWrapperPath: "gradlew"
      }
    };

    const result = await evaluateMergeChecklist({
      workspacePath: repoPath,
      evidencePath,
      commitBefore: "HEAD",
      changedFiles: 0,
      changedLines: 0,
      policy: basePolicy,
      scan,
      verifySummary: {
        buildSystem: "gradle",
        hasTests: false,
        compile: { status: "not_run" },
        tests: { status: "not_run" },
        staticChecks: { status: "passed" }
      },
      summary: {}
    });

    expect(result.summary.passed).toBe(true);
    expect(result.artifact.advisories).toContain(
      "Guarded Android baseline is already satisfied; no PR is needed"
    );
  });

  it("keeps the lightweight XML parse check idempotent for valid content", async () => {
    const pom = await readFile(resolve(process.cwd(), "fixtures/java-maven-simple/pom.xml"), "utf8");
    expect(isLikelyParseableXml(pom)).toBe(true);
    expect(isLikelyParseableXml("<project><build></project>")).toBe(false);
  });
});
