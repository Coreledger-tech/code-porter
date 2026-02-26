import type { PreparedWorkspace } from "@code-porter/core/src/workflow-runner.js";
import type { Project } from "@code-porter/core/src/models.js";
import { GitCommandError, isAuthLikeFailure, runGit } from "../git.js";
import { BaseRepoProvider, RepoOperationError, type RepoPrepareInput } from "../repo-provider.js";

function publicCloneUrl(project: Project): string {
  if (project.cloneUrl) {
    return project.cloneUrl;
  }
  return `https://github.com/${project.owner}/${project.repo}.git`;
}

function authCloneUrl(publicUrl: string, token: string): string {
  if (publicUrl.startsWith("https://")) {
    return publicUrl.replace("https://", `https://x-access-token:${encodeURIComponent(token)}@`);
  }

  return publicUrl;
}

async function fetchDefaultBranch(project: Project, token: string): Promise<string> {
  if (!project.owner || !project.repo) {
    return "main";
  }

  const response = await fetch(`https://api.github.com/repos/${project.owner}/${project.repo}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "code-porter"
    }
  });

  if (response.status === 401 || response.status === 403) {
    throw new RepoOperationError(
      "GitHub authentication failed while resolving repository metadata",
      "auth"
    );
  }

  if (!response.ok) {
    return "main";
  }

  const payload = (await response.json()) as { default_branch?: string };
  return payload.default_branch?.trim() || "main";
}

export class GitHubRepoProvider extends BaseRepoProvider {
  async prepareWorkspace(input: RepoPrepareInput): Promise<PreparedWorkspace> {
    const project = input.project;
    if (project.type !== "github" || !project.owner || !project.repo) {
      throw new RepoOperationError(
        "Workspace prepare failed: github provider requires owner and repo",
        "workspace_prepare"
      );
    }

    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new RepoOperationError(
        "GitHub authentication token is missing (set GITHUB_TOKEN)",
        "auth"
      );
    }

    const workspacePath = await this.workspaceManager.createWorkspace(input.runId);
    const cloneUrlUsed = publicCloneUrl(project);
    const authenticatedUrl = authCloneUrl(cloneUrlUsed, token);

    try {
      await runGit(["clone", authenticatedUrl, workspacePath]);
    } catch (error) {
      const message =
        error instanceof GitCommandError
          ? [error.message, error.output].filter(Boolean).join("\n")
          : error instanceof Error
            ? error.message
            : "GitHub clone failed";

      if (isAuthLikeFailure(message)) {
        throw new RepoOperationError(
          "GitHub authentication failed during clone",
          "auth"
        );
      }

      throw new RepoOperationError(
        "Workspace prepare failed: unable to clone GitHub repository",
        "workspace_prepare"
      );
    }

    const defaultBranch = project.defaultBranch ?? (await fetchDefaultBranch(project, token));
    const resolvedBaseRef = input.baseRefHint ?? defaultBranch ?? "main";
    const checkout = await this.workspaceManager.checkoutBase(workspacePath, resolvedBaseRef);

    return {
      workspacePath,
      resolvedBaseRef,
      commitBefore: checkout.commit,
      defaultBranch,
      cloneUrlUsed,
      sourceRef: `${project.owner}/${project.repo}`
    };
  }
}
