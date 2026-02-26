import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ScanResult } from "../models.js";
import type { FileMap, RecipeApplyResult, RecipeEnginePort } from "../workflow-runner.js";

const execFileAsync = promisify(execFile);

async function runGit(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024
  });
  return stdout.trim();
}

export interface ApplyStepResult {
  applyResult: RecipeApplyResult;
  patch: string;
  changedFiles: number;
  changedLines: number;
  commitAfter?: string;
}

export async function runApplyStep(input: {
  repoPath: string;
  campaignId: string;
  runId: string;
  scan: ScanResult;
  files: FileMap;
  recipeEngine: RecipeEnginePort;
}): Promise<ApplyStepResult> {
  const gitStatus = await runGit(input.repoPath, ["status", "--porcelain"]);
  if (gitStatus.length > 0) {
    throw new Error("Apply blocked: workspace has uncommitted changes before apply");
  }

  const applyResult = input.recipeEngine.apply(input.scan, input.files);
  const changedFilePaths = applyResult.changes
    .filter((change) => change.changed)
    .map((change) => change.filePath);

  await Promise.all(
    changedFilePaths.map(async (relativePath) => {
      const content = applyResult.files[relativePath];
      await writeFile(join(input.repoPath, relativePath), content, "utf8");
    })
  );

  const patch =
    changedFilePaths.length > 0
      ? await runGit(input.repoPath, ["diff", "--", ...changedFilePaths])
      : "";

  let commitSha: string | undefined;
  if (changedFilePaths.length > 0 && patch.length > 0) {
    await runGit(input.repoPath, ["add", "--", ...changedFilePaths]);
    await runGit(input.repoPath, [
      "commit",
      "-m",
      `codeporter: apply campaign ${input.campaignId} run ${input.runId}`
    ]);
    commitSha = await runGit(input.repoPath, ["rev-parse", "HEAD"]);
  }

  const changedFiles = changedFilePaths.length;
  const changedLines = applyResult.changes
    .filter((change) => change.changed)
    .reduce((sum, change) => sum + change.addedLines + change.removedLines, 0);

  return {
    applyResult,
    patch,
    changedFiles,
    changedLines,
    commitAfter: commitSha
  };
}
