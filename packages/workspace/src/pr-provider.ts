import type { PRProviderPort } from "@code-porter/core/src/workflow-runner.js";
import type { Project } from "@code-porter/core/src/models.js";
import {
  createGitHubAuthProvider,
  type GitHubAuthProvider
} from "./auth-provider.js";
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

async function fetchGitHubApi(input: {
  apiUrl: string;
  token: string;
  path: string;
  method: string;
  body?: Record<string, unknown>;
  authFailureMessage: string;
  failureMessage: string;
}): Promise<Response> {
  const response = await fetch(`${input.apiUrl.replace(/\/+$/, "")}${input.path}`, {
    method: input.method,
    headers: {
      Authorization: `Bearer ${input.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "code-porter"
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {})
  });

  if (response.status === 401 || response.status === 403) {
    throw new RepoOperationError(input.authFailureMessage, "auth");
  }

  if (!response.ok) {
    throw new RepoOperationError(
      `${input.failureMessage} (status ${response.status})`,
      "repo_write"
    );
  }

  return response;
}

export class GitHubPRProvider implements PRProviderPort {
  constructor(
    private readonly authProvider: GitHubAuthProvider = createGitHubAuthProvider(),
    private readonly apiUrl: string = process.env.GITHUB_API_URL?.trim() ||
      "https://api.github.com"
  ) {}

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
  }): Promise<{ prUrl: string; prNumber?: number | null }> {
    if (input.project.type !== "github") {
      throw new RepoOperationError(
        "GitHub PR provider requires a github project",
        "repo_write"
      );
    }

    let token: string;
    try {
      token = await this.authProvider.getToken();
    } catch (error) {
      throw new RepoOperationError(
        error instanceof Error
          ? error.message
          : "GitHub authentication token is missing",
        "auth"
      );
    }

    await pushBranch(input.workspacePath, input.branchName);

    const response = await fetchGitHubApi({
      apiUrl: this.apiUrl,
      token,
      path: `/repos/${repoApiPath(input.project)}/pulls`,
      method: "POST",
      authFailureMessage: "GitHub authentication failed while creating pull request",
      failureMessage: "GitHub pull request creation failed",
      body: {
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
      }
    });

    const payload = (await response.json()) as { html_url?: string; number?: number };
    if (!payload.html_url) {
      throw new RepoOperationError(
        "GitHub pull request response missing html_url",
        "repo_write"
      );
    }

    return {
      prUrl: payload.html_url,
      prNumber: Number.isInteger(payload.number) ? payload.number : null
    };
  }

  async commentOnPullRequest(input: {
    project: Project;
    prNumber: number;
    body: string;
  }): Promise<void> {
    let token: string;
    try {
      token = await this.authProvider.getToken();
    } catch (error) {
      throw new RepoOperationError(
        error instanceof Error
          ? error.message
          : "GitHub authentication token is missing",
        "auth"
      );
    }

    await fetchGitHubApi({
      apiUrl: this.apiUrl,
      token,
      path: `/repos/${repoApiPath(input.project)}/issues/${input.prNumber}/comments`,
      method: "POST",
      authFailureMessage: "GitHub authentication failed while commenting on pull request",
      failureMessage: "GitHub pull request comment failed",
      body: {
        body: input.body
      }
    });
  }

  async closePullRequest(input: {
    project: Project;
    prNumber: number;
  }): Promise<void> {
    let token: string;
    try {
      token = await this.authProvider.getToken();
    } catch (error) {
      throw new RepoOperationError(
        error instanceof Error
          ? error.message
          : "GitHub authentication token is missing",
        "auth"
      );
    }

    await fetchGitHubApi({
      apiUrl: this.apiUrl,
      token,
      path: `/repos/${repoApiPath(input.project)}/pulls/${input.prNumber}`,
      method: "PATCH",
      authFailureMessage: "GitHub authentication failed while closing pull request",
      failureMessage: "GitHub pull request close failed",
      body: {
        state: "closed"
      }
    });
  }
}
