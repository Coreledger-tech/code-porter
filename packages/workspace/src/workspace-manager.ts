import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  WorkspaceManagerPort
} from "@code-porter/core/src/workflow-runner.js";
import type { WorkspaceCleanupPolicy } from "@code-porter/core/src/workflow-runner.js";
import type { RunStatus } from "@code-porter/core/src/models.js";
import { RepoOperationError } from "./repo-provider.js";
import { runGit, sanitizeBranchSegment } from "./git.js";

function shouldDeleteWorkspace(status: RunStatus, policy: WorkspaceCleanupPolicy): boolean {
  if (policy === "always_delete") {
    return true;
  }
  if (policy === "always_keep") {
    return false;
  }
  return status === "completed";
}

export class WorkspaceManager implements WorkspaceManagerPort {
  constructor(private readonly workspaceRoot: string) {}

  async ensureCleanTree(repoPath: string): Promise<void> {
    const status = await runGit(["status", "--porcelain"], { cwd: repoPath });
    if (status.stdout.trim().length > 0) {
      throw new RepoOperationError(
        "Apply blocked: source repository has uncommitted changes",
        "workspace_prepare"
      );
    }
  }

  async createWorkspace(runId: string): Promise<string> {
    const workspacePath = resolve(this.workspaceRoot, runId);
    await mkdir(this.workspaceRoot, { recursive: true });
    await rm(workspacePath, { recursive: true, force: true });
    await mkdir(workspacePath, { recursive: true });
    return workspacePath;
  }

  async checkoutBase(repoPath: string, ref: string): Promise<{ ref: string; commit: string }> {
    try {
      await runGit(["checkout", ref], { cwd: repoPath });
    } catch {
      try {
        await runGit(["checkout", "-b", ref, `origin/${ref}`], { cwd: repoPath });
      } catch {
        throw new RepoOperationError(
          `Workspace prepare failed: unable to checkout base ref '${ref}'`,
          "workspace_prepare"
        );
      }
    }

    const head = await runGit(["rev-parse", "HEAD"], { cwd: repoPath });
    return {
      ref,
      commit: head.stdout.trim()
    };
  }

  async createBranch(repoPath: string, campaignId: string, runId: string): Promise<string> {
    const branchName = `codeporter/${sanitizeBranchSegment(campaignId)}/${sanitizeBranchSegment(
      runId
    )}`;
    await runGit(["checkout", "-b", branchName], { cwd: repoPath });
    return branchName;
  }

  async cleanupWorkspace(input: {
    workspacePath: string;
    status: RunStatus;
    policy: WorkspaceCleanupPolicy;
  }): Promise<void> {
    if (!shouldDeleteWorkspace(input.status, input.policy)) {
      return;
    }

    try {
      await rm(input.workspacePath, { recursive: true, force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "workspace cleanup failed";
      throw new RepoOperationError(
        `Workspace cleanup failed: ${message}`,
        "workspace_cleanup"
      );
    }
  }
}
