import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubAuthProvider } from "./auth-provider.js";

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
  });

  it("pushes branch and creates pull request", async () => {
    runGitMock.mockResolvedValueOnce({ stdout: "", stderr: "" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/demo/pull/1", number: 1 })
    });
    vi.stubGlobal("fetch", fetchMock);

    const authProvider: GitHubAuthProvider = {
      getToken: vi.fn().mockResolvedValue("test-token")
    };
    const provider = new GitHubPRProvider(authProvider);
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
    expect(result.prNumber).toBe(1);
    expect(runGitMock).toHaveBeenCalledWith(
      ["push", "-u", "origin", "codeporter/campaign/run"],
      { cwd: "/tmp/workspace" }
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps push failures to blocked auth or repo_write errors", async () => {
    runGitMock.mockRejectedValueOnce(new Error("Authentication failed"));

    const authProvider: GitHubAuthProvider = {
      getToken: vi.fn().mockResolvedValue("test-token")
    };
    const provider = new GitHubPRProvider(authProvider);
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

    const authProvider: GitHubAuthProvider = {
      getToken: vi.fn().mockResolvedValue("test-token")
    };
    const provider = new GitHubPRProvider(authProvider);
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

  it("maps auth provider failures to auth error", async () => {
    const authProvider: GitHubAuthProvider = {
      getToken: vi.fn().mockRejectedValue(new Error("app token exchange failed"))
    };
    const provider = new GitHubPRProvider(authProvider);

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
        confidenceScore: null
      })
    ).rejects.toMatchObject({ failureKind: "auth" });
  });

  it("posts deterministic comments to pull requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ id: 1 })
      })
    );

    const authProvider: GitHubAuthProvider = {
      getToken: vi.fn().mockResolvedValue("test-token")
    };
    const provider = new GitHubPRProvider(authProvider);

    await provider.commentOnPullRequest({
      project: {
        id: "p1",
        name: "demo",
        type: "github",
        owner: "acme",
        repo: "demo",
        createdAt: new Date().toISOString()
      },
      prNumber: 24,
      body: "Superseded by #25 (keeper for this pilot window)."
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/demo/issues/24/comments",
      expect.objectContaining({
        method: "POST"
      })
    );
  });

  it("closes superseded pull requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ state: "closed" })
      })
    );

    const authProvider: GitHubAuthProvider = {
      getToken: vi.fn().mockResolvedValue("test-token")
    };
    const provider = new GitHubPRProvider(authProvider);

    await provider.closePullRequest({
      project: {
        id: "p1",
        name: "demo",
        type: "github",
        owner: "acme",
        repo: "demo",
        createdAt: new Date().toISOString()
      },
      prNumber: 24
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/demo/pulls/24",
      expect.objectContaining({
        method: "PATCH"
      })
    );
  });
});
