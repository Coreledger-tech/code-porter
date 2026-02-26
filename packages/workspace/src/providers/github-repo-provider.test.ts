import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceManagerPort } from "@code-porter/core/src/workflow-runner.js";

const { runGitMock } = vi.hoisted(() => {
  return {
    runGitMock: vi.fn()
  };
});

vi.mock("../git.js", async () => {
  const actual = await vi.importActual<typeof import("../git.js")>("../git.js");
  return {
    ...actual,
    runGit: runGitMock
  };
});

import { RepoOperationError } from "../repo-provider.js";
import { GitHubRepoProvider } from "./github-repo-provider.js";

function createWorkspaceManager(): WorkspaceManagerPort {
  return {
    ensureCleanTree: vi.fn(),
    createWorkspace: vi.fn().mockResolvedValue("/tmp/workspace-run"),
    checkoutBase: vi.fn().mockResolvedValue({ ref: "main", commit: "abc123" }),
    createBranch: vi.fn(),
    cleanupWorkspace: vi.fn()
  };
}

describe("GitHubRepoProvider", () => {
  beforeEach(() => {
    runGitMock.mockReset();
    vi.unstubAllGlobals();
    delete process.env.GITHUB_TOKEN;
  });

  it("fails with auth error when token is missing", async () => {
    const provider = new GitHubRepoProvider(createWorkspaceManager());
    await expect(
      provider.prepareWorkspace({
        project: {
          id: "p1",
          name: "demo",
          type: "github",
          owner: "acme",
          repo: "demo",
          createdAt: new Date().toISOString()
        },
        runId: "run-1",
        campaignId: "camp-1",
        mode: "apply"
      })
    ).rejects.toMatchObject({
      failureKind: "auth"
    });
  });

  it("clones and resolves default branch for github project", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    runGitMock.mockResolvedValueOnce({ stdout: "", stderr: "" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ default_branch: "main" })
      })
    );

    const manager = createWorkspaceManager();
    const provider = new GitHubRepoProvider(manager);
    const workspace = await provider.prepareWorkspace({
      project: {
        id: "p1",
        name: "demo",
        type: "github",
        owner: "acme",
        repo: "demo",
        createdAt: new Date().toISOString()
      },
      runId: "run-1",
      campaignId: "camp-1",
      mode: "apply"
    });

    expect(runGitMock).toHaveBeenCalled();
    expect(workspace.workspacePath).toBe("/tmp/workspace-run");
    expect(workspace.defaultBranch).toBe("main");
    expect(workspace.commitBefore).toBe("abc123");
  });

  it("maps metadata auth failures to auth failure kind", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    runGitMock.mockResolvedValueOnce({ stdout: "", stderr: "" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({})
      })
    );

    const provider = new GitHubRepoProvider(createWorkspaceManager());
    const call = provider.prepareWorkspace({
      project: {
        id: "p1",
        name: "demo",
        type: "github",
        owner: "acme",
        repo: "demo",
        createdAt: new Date().toISOString()
      },
      runId: "run-1",
      campaignId: "camp-1",
      mode: "apply"
    });

    await expect(call).rejects.toMatchObject({
      name: "RepoOperationError",
      failureKind: "auth"
    });
  });
});
