import { beforeEach, describe, expect, it, vi } from "vitest";

const { runGitMock } = vi.hoisted(() => {
  return {
    runGitMock: vi.fn()
  };
});

vi.mock("./git.js", async () => {
  const actual = await vi.importActual<typeof import("./git.js")>("./git.js");
  return {
    ...actual,
    runGit: runGitMock
  };
});

import { RepoOperationError } from "./repo-provider.js";
import { GitHubPRProvider } from "./pr-provider.js";

describe("GitHubPRProvider", () => {
  beforeEach(() => {
    runGitMock.mockReset();
    vi.unstubAllGlobals();
    process.env.GITHUB_TOKEN = "test-token";
  });

  it("pushes branch and creates pull request", async () => {
    runGitMock.mockResolvedValueOnce({ stdout: "", stderr: "" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/demo/pull/1" })
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GitHubPRProvider();
    const result = await provider.createPullRequest({
      project: {
        id: "p1",
        name: "demo",
        type: "github",
        owner: "acme",
        repo: "demo",
        createdAt: new Date().toISOString()
      },
      workspacePath: "/tmp/workspace",
      branchName: "codeporter/campaign/run",
      baseBranch: "main",
      runId: "run-1",
      summary: {},
      changedFiles: 2,
      changedLines: 10,
      recipesApplied: ["recipe-a"],
      confidenceScore: 80
    });

    expect(result.prUrl).toBe("https://github.com/acme/demo/pull/1");
    expect(runGitMock).toHaveBeenCalledWith(
      ["push", "-u", "origin", "codeporter/campaign/run"],
      { cwd: "/tmp/workspace" }
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps push failures to blocked auth or repo_write errors", async () => {
    runGitMock.mockRejectedValueOnce(new Error("Authentication failed"));

    const provider = new GitHubPRProvider();
    await expect(
      provider.createPullRequest({
        project: {
          id: "p1",
          name: "demo",
          type: "github",
          owner: "acme",
          repo: "demo",
          createdAt: new Date().toISOString()
        },
        workspacePath: "/tmp/workspace",
        branchName: "codeporter/campaign/run",
        baseBranch: "main",
        runId: "run-1",
        summary: {},
        changedFiles: 2,
        changedLines: 10,
        recipesApplied: [],
        confidenceScore: 80
      })
    ).rejects.toMatchObject({ failureKind: "auth" });
  });

  it("maps pull request API failures", async () => {
    runGitMock.mockResolvedValueOnce({ stdout: "", stderr: "" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ message: "unprocessable" })
      })
    );

    const provider = new GitHubPRProvider();
    await expect(
      provider.createPullRequest({
        project: {
          id: "p1",
          name: "demo",
          type: "github",
          owner: "acme",
          repo: "demo",
          createdAt: new Date().toISOString()
        },
        workspacePath: "/tmp/workspace",
        branchName: "codeporter/campaign/run",
        baseBranch: "main",
        runId: "run-1",
        summary: {},
        changedFiles: 2,
        changedLines: 10,
        recipesApplied: [],
        confidenceScore: 80
      })
    ).rejects.toBeInstanceOf(RepoOperationError);
  });
});
