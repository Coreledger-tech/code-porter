import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlanMetrics, ScanResult } from "../models.js";
import type { FileMap, RecipeEnginePort, RecipePlanResult } from "../workflow-runner.js";

const CANDIDATE_FILES = [
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "package.json",
  "pyproject.toml",
  "go.mod"
];

export async function loadCandidateFiles(repoPath: string): Promise<FileMap> {
  const fileMap: FileMap = {};

  await Promise.all(
    CANDIDATE_FILES.map(async (relativePath) => {
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
      buildSystemReason: input.scan.metadata.buildSystemReason
    }
  };
}
