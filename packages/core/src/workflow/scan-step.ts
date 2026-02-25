import { access } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BuildSystem, ScanResult } from "../models.js";

const execFileAsync = promisify(execFile);

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function getGitBranch(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoPath
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function detectBuildSystem(hasPom: boolean, hasGradle: boolean, hasPackageJson: boolean): BuildSystem {
  if (hasPom) {
    return "maven";
  }
  if (hasGradle) {
    return "gradle";
  }
  if (hasPackageJson) {
    return "node";
  }
  return "unknown";
}

export async function runScanStep(repoPath: string): Promise<ScanResult> {
  const hasPom = await fileExists(join(repoPath, "pom.xml"));
  const hasGradle =
    (await fileExists(join(repoPath, "build.gradle"))) ||
    (await fileExists(join(repoPath, "build.gradle.kts")));
  const hasPackageJson = await fileExists(join(repoPath, "package.json"));

  const hasJavaTests = await fileExists(join(repoPath, "src", "test"));
  const hasNodeTests =
    (await fileExists(join(repoPath, "test"))) ||
    (await fileExists(join(repoPath, "tests"))) ||
    (await fileExists(join(repoPath, "__tests__")));

  const buildSystem = detectBuildSystem(hasPom, hasGradle, hasPackageJson);

  const [mvn, gradle, npm, node, gitBranch] = await Promise.all([
    commandExists("mvn"),
    commandExists("gradle"),
    commandExists("npm"),
    commandExists("node"),
    getGitBranch(repoPath)
  ]);

  const detectedFiles: string[] = [];
  if (hasPom) {
    detectedFiles.push("pom.xml");
  }
  if (await fileExists(join(repoPath, "build.gradle"))) {
    detectedFiles.push("build.gradle");
  }
  if (await fileExists(join(repoPath, "build.gradle.kts"))) {
    detectedFiles.push("build.gradle.kts");
  }
  if (hasPackageJson) {
    detectedFiles.push("package.json");
  }

  return {
    buildSystem,
    hasTests: hasJavaTests || hasNodeTests,
    metadata: {
      gitBranch,
      toolAvailability: {
        mvn,
        gradle,
        npm,
        node
      },
      detectedFiles
    }
  };
}
