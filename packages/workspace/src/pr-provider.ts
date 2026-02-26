import type { PRProviderPort } from "@code-porter/core/src/workflow-runner.js";
import type { Project } from "@code-porter/core/src/models.js";
import { GitCommandError, isAuthLikeFailure, runGit } from "./git.js";
import { RepoOperationError } from "./repo-provider.js";

function buildEvidenceInstruction(runId: string): string {
  return `Evidence: download via Code Porter API GET /runs/${runId}/evidence.zip`;
}

function buildPrBody(input: {
  runId: string;
  changedFiles: number;
  changedLines: number;
  recipesApplied: string[];
  confidenceScore: number | null;
  blockedReason?: string;
}): string {
  const lines = [
    "## Code Porter Summary",
    `- Run ID: ${input.runId}`,
    `- Recipes applied: ${input.recipesApplied.length > 0 ? input.recipesApplied.join(", ") : "none"}`,
    `- Changed files: ${input.changedFiles}`,
    `- Changed lines: ${input.changedLines}`,
    input.confidenceScore === null
      ? `- Confidence score: withheld`
      : `- Confidence score: ${input.confidenceScore}`
  ];

  if (input.blockedReason) {
    lines.push(`- Blocked reason: ${input.blockedReason}`);
  }

  lines.push("");
  lines.push(buildEvidenceInstruction(input.runId));

  return lines.join("\n");
}

function repoApiPath(project: Project): string {
  if (!project.owner || !project.repo) {
    throw new RepoOperationError(
      "GitHub PR failed: project owner/repo is not configured",
      "repo_write"
    );
  }
  return `${project.owner}/${project.repo}`;
}

async function pushBranch(workspacePath: string, branchName: string): Promise<void> {
  try {
    await runGit(["push", "-u", "origin", branchName], { cwd: workspacePath });
  } catch (error) {
    const message =
      error instanceof GitCommandError
        ? [error.message, error.output].filter(Boolean).join("\n")
        : error instanceof Error
          ? error.message
          : "Git push failed";

    if (isAuthLikeFailure(message)) {
      throw new RepoOperationError(
        "GitHub authentication failed while pushing branch",
        "auth"
      );
    }

    throw new RepoOperationError(
      "GitHub push failed for branch publish",
      "repo_write"
    );
  }
}

export class GitHubPRProvider implements PRProviderPort {
  async createPullRequest(input: {
    project: Project;
    workspacePath: string;
    branchName: string;
    baseBranch: string;
    runId: string;
    summary: Record<string, unknown>;
    changedFiles: number;
    changedLines: number;
    recipesApplied: string[];
    confidenceScore: number | null;
    blockedReason?: string;
  }): Promise<{ prUrl: string }> {
    if (input.project.type !== "github") {
      throw new RepoOperationError(
        "GitHub PR provider requires a github project",
        "repo_write"
      );
    }

    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new RepoOperationError(
        "GitHub authentication token is missing (set GITHUB_TOKEN)",
        "auth"
      );
    }

    await pushBranch(input.workspacePath, input.branchName);

    const response = await fetch(`https://api.github.com/repos/${repoApiPath(input.project)}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "code-porter"
      },
      body: JSON.stringify({
        title: `Code Porter run ${input.runId}`,
        head: input.branchName,
        base: input.baseBranch,
        body: buildPrBody({
          runId: input.runId,
          changedFiles: input.changedFiles,
          changedLines: input.changedLines,
          recipesApplied: input.recipesApplied,
          confidenceScore: input.confidenceScore,
          blockedReason: input.blockedReason
        })
      })
    });

    if (response.status === 401 || response.status === 403) {
      throw new RepoOperationError(
        "GitHub authentication failed while creating pull request",
        "auth"
      );
    }

    if (!response.ok) {
      throw new RepoOperationError(
        `GitHub pull request creation failed (status ${response.status})`,
        "repo_write"
      );
    }

    const payload = (await response.json()) as { html_url?: string };
    if (!payload.html_url) {
      throw new RepoOperationError(
        "GitHub pull request response missing html_url",
        "repo_write"
      );
    }

    return { prUrl: payload.html_url };
  }
}
