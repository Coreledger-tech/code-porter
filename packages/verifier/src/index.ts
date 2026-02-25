import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PolicyConfig, ScanResult, VerifySummary } from "@code-porter/core/src/models.js";
import type { VerifierPort } from "@code-porter/core/src/workflow-runner.js";
import { getBuildCommand, getTestCommand, runCommand } from "./commands.js";

const SKIP_DIRS = new Set([".git", "node_modules", "target", "build", "dist", "evidence"]);

async function walkFiles(rootPath: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });

    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = join(currentPath, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) {
            await walk(fullPath);
          }
          return;
        }

        files.push(fullPath);
      })
    );
  }

  const rootStat = await stat(rootPath);
  if (!rootStat.isDirectory()) {
    return files;
  }

  await walk(rootPath);
  return files;
}

async function runBasicStaticChecks(repoPath: string): Promise<VerifySummary["staticChecks"]> {
  const files = await walkFiles(repoPath);
  const candidates = files.filter((filePath) => {
    return /\.(java|xml|gradle|kts|js|ts|json|properties|yml|yaml)$/i.test(filePath);
  });

  for (const filePath of candidates) {
    const content = await readFile(filePath, "utf8");
    if (content.includes("<<<<<<<") || content.includes(">>>>>>>") || content.includes("=======")) {
      return {
        status: "failed",
        reason: `Merge conflict markers detected in ${filePath}`
      };
    }
  }

  return {
    status: "passed",
    reason: "No merge conflict markers found"
  };
}

function commandAvailable(scan: ScanResult, command: "mvn" | "gradle" | "npm"): boolean {
  return scan.metadata.toolAvailability[command];
}

export class DefaultVerifier implements VerifierPort {
  async run(scan: ScanResult, repoPath: string, _policy: PolicyConfig): Promise<VerifySummary> {
    const buildCommand = getBuildCommand(scan.buildSystem);
    const testCommand = getTestCommand(scan.buildSystem);

    const compile =
      buildCommand && commandAvailable(scan, buildCommand.command as "mvn" | "gradle" | "npm")
        ? await runCommand(buildCommand, repoPath)
        : {
            status: "not_run" as const,
            reason: buildCommand
              ? `Command '${buildCommand.command}' not available`
              : `No build command configured for build system '${scan.buildSystem}'`
          };

    const tests = !scan.hasTests
      ? {
          status: "not_run" as const,
          reason: "No tests detected"
        }
      : testCommand && commandAvailable(scan, testCommand.command as "mvn" | "gradle" | "npm")
        ? await runCommand(testCommand, repoPath)
        : {
            status: "not_run" as const,
            reason: testCommand
              ? `Command '${testCommand.command}' not available`
              : `No test command configured for build system '${scan.buildSystem}'`
          };

    const staticChecks = await runBasicStaticChecks(repoPath);

    return {
      buildSystem: scan.buildSystem,
      hasTests: scan.hasTests,
      compile,
      tests,
      staticChecks
    };
  }
}
