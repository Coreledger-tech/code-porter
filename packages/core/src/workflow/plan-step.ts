import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { PlanMetrics, ScanResult } from "../models.js";
import type { FileMap, RecipeEnginePort, RecipePlanResult } from "../workflow-runner.js";

const CANDIDATE_FILES = [
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle/wrapper/gradle-wrapper.properties",
  "gradle.properties",
  "package.json",
  "pyproject.toml",
  "go.mod"
];

async function loadTestJavaFiles(repoPath: string): Promise<string[]> {
  const root = join(repoPath, "src", "test", "java");
  const filePaths: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".java")) {
        continue;
      }
      const rel = relative(repoPath, fullPath).split("\\").join("/");
      filePaths.push(rel);
    }
  }

  try {
    await walk(root);
  } catch {
    return [];
  }

  return filePaths.sort();
}

export async function loadCandidateFiles(repoPath: string): Promise<FileMap> {
  const fileMap: FileMap = {};
  const testJavaFiles = await loadTestJavaFiles(repoPath);
  const candidateFiles = [...CANDIDATE_FILES, ...testJavaFiles];

  await Promise.all(
    candidateFiles.map(async (relativePath) => {
      try {
        const fullPath = join(repoPath, relativePath);
        const content = await readFile(fullPath, "utf8");
        fileMap[relativePath] = content;
      } catch {
        // Optional file, ignore if not present.
      }
    })
  );

  return fileMap;
}

export function runPlanStep(input: {
  scan: ScanResult;
  files: FileMap;
  recipeEngine: RecipeEnginePort;
}): { planResult: RecipePlanResult; planMetrics: PlanMetrics } {
  const planResult = input.recipeEngine.plan(input.scan, input.files);

  const filesChanged = new Set(
    planResult.plannedEdits
      .filter((edit) => edit.changeType === "update")
      .map((edit) => edit.filePath)
  ).size;

  const linesChanged = planResult.plannedEdits
    .filter((edit) => edit.changeType === "update")
    .reduce((sum, edit) => sum + Math.max(0, edit.lineDelta), 0);

  return {
    planResult,
    planMetrics: {
      buildSystem: input.scan.buildSystem,
      filesChanged,
      linesChanged,
      selectedManifestPath: input.scan.metadata.selectedManifestPath ?? null,
      selectedBuildRoot: input.scan.metadata.selectedBuildRoot ?? null,
      buildSystemDisposition: input.scan.metadata.buildSystemDisposition,
      buildSystemReason: input.scan.metadata.buildSystemReason,
      gradleProjectType: input.scan.metadata.gradleProjectType ?? null
    }
  };
}
