import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGit } from "./git.js";
import { WorkspaceManager } from "./workspace-manager.js";

async function initRepo(path: string): Promise<void> {
  await runGit(["init"], { cwd: path });
  await runGit(["config", "user.email", "workspace@test.local"], { cwd: path });
  await runGit(["config", "user.name", "Workspace Test"], { cwd: path });
  await writeFile(join(path, "README.md"), "# demo\n", "utf8");
  await runGit(["add", "."], { cwd: path });
  await runGit(["commit", "-m", "init"], { cwd: path });
}

describe("WorkspaceManager", () => {
  it("creates and cleans workspace by policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-porter-workspaces-"));
    const manager = new WorkspaceManager(root);

    const workspacePath = await manager.createWorkspace("run-1");
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, "scratch.txt"), "ok\n", "utf8");

    await manager.cleanupWorkspace({
      workspacePath,
      status: "completed",
      policy: "delete_on_success_keep_on_failure"
    });

    await expect(access(workspacePath)).rejects.toThrow();
  });

  it("keeps workspace on failure with default policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-porter-workspaces-"));
    const manager = new WorkspaceManager(root);

    const workspacePath = await manager.createWorkspace("run-2");
    await writeFile(join(workspacePath, "debug.txt"), "keep\n", "utf8");

    await manager.cleanupWorkspace({
      workspacePath,
      status: "blocked",
      policy: "delete_on_success_keep_on_failure"
    });

    await access(workspacePath);
  });

  it("checks clean tree and creates branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-porter-workspaces-"));
    const source = join(root, "source");
    await mkdir(source, { recursive: true });
    await initRepo(source);

    const manager = new WorkspaceManager(root);
    await manager.ensureCleanTree(source);

    const branch = await manager.createBranch(source, "campaign 1", "run 1");
    expect(branch).toBe("codeporter/campaign-1/run-1");

    await writeFile(join(source, "README.md"), "# dirty\n", "utf8");
    await expect(manager.ensureCleanTree(source)).rejects.toThrow(
      "Apply blocked: source repository has uncommitted changes"
    );
  });
});
