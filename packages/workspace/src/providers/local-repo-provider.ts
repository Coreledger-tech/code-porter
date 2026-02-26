import { access } from "node:fs/promises";
import type { PreparedWorkspace } from "@code-porter/core/src/workflow-runner.js";
import type { Project } from "@code-porter/core/src/models.js";
import { runGit } from "../git.js";
import { BaseRepoProvider, RepoOperationError, type RepoPrepareInput } from "../repo-provider.js";

async function assertAccessibleDirectory(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new RepoOperationError(
      `Workspace prepare failed: local repository path is not accessible (${path})`,
      "workspace_prepare"
    );
  }
}

async function detectDefaultBranch(repoPath: string): Promise<string> {
  try {
    const symbolic = await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: repoPath
    });
    const value = symbolic.stdout.trim();
    if (value.startsWith("origin/")) {
      return value.replace(/^origin\//, "");
    }
  } catch {
    // fall through
  }

  try {
    const current = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath });
    if (current.stdout.trim().length > 0 && current.stdout.trim() !== "HEAD") {
      return current.stdout.trim();
    }
  } catch {
    // fall through
  }

  return "main";
}

async function getSourceCommit(repoPath: string): Promise<string> {
  try {
    const result = await runGit(["rev-parse", "HEAD"], { cwd: repoPath });
    return result.stdout.trim();
  } catch {
    return "unknown";
  }
}

export class LocalRepoProvider extends BaseRepoProvider {
  async prepareWorkspace(input: RepoPrepareInput): Promise<PreparedWorkspace> {
    const project: Project = input.project;
    if (project.type !== "local" || !project.localPath) {
      throw new RepoOperationError(
        "Workspace prepare failed: local provider requires a local project path",
        "workspace_prepare"
      );
    }

    await assertAccessibleDirectory(project.localPath);

    if (input.mode === "apply") {
      await this.workspaceManager.ensureCleanTree(project.localPath);
    }

    const workspacePath = await this.workspaceManager.createWorkspace(input.runId);
    await runGit(["clone", project.localPath, workspacePath]);

    const defaultBranch = project.defaultBranch ?? (await detectDefaultBranch(workspacePath));
    const resolvedBaseRef = input.baseRefHint ?? defaultBranch ?? "main";
    const checkout = await this.workspaceManager.checkoutBase(workspacePath, resolvedBaseRef);

    return {
      workspacePath,
      resolvedBaseRef,
      commitBefore: checkout.commit,
      defaultBranch,
      cloneUrlUsed: project.localPath,
      sourceRef: await getSourceCommit(project.localPath)
    };
  }
}
