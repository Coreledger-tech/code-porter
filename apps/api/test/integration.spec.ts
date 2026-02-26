import { execFile } from "node:child_process";
import { access, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);

function deriveTestDatabaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  const databaseName = parsed.pathname.replace(/^\/+/, "") || "code_porter";
  parsed.pathname = `/${databaseName}_test`;
  return parsed.toString();
}

function buildAdminDatabaseUrl(targetUrl: string): string {
  const parsed = new URL(targetUrl);
  parsed.pathname = "/postgres";
  return parsed.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

async function ensureDatabaseExists(databaseUrl: string): Promise<void> {
  const parsed = new URL(databaseUrl);
  const databaseName = parsed.pathname.replace(/^\/+/, "");
  const admin = new Client({
    connectionString: buildAdminDatabaseUrl(databaseUrl)
  });

  await admin.connect();
  try {
    const existing = await admin.query<{ exists: boolean }>(
      "select exists(select 1 from pg_database where datname = $1) as exists",
      [databaseName]
    );
    if (!existing.rows[0]?.exists) {
      await admin.query(`create database ${quoteIdentifier(databaseName)}`);
    }
  } finally {
    await admin.end();
  }
}

async function runGit(repoPath: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd: repoPath,
    timeout: 120000
  });
}

async function runGitStdout(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    timeout: 120000
  });
  return stdout.trim();
}

async function prepareMavenRepo(input: {
  repoName: string;
  mutatePom?: (pom: string) => string;
  makeDirty?: boolean;
}): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), `${input.repoName}-`));
  const fixturePath = resolve(process.cwd(), "fixtures/java-maven-simple");
  await cp(fixturePath, repoPath, { recursive: true });

  if (input.mutatePom) {
    const pomPath = join(repoPath, "pom.xml");
    const pom = await readFile(pomPath, "utf8");
    const updated = input.mutatePom(pom);
    await writeFile(pomPath, updated, "utf8");
  }

  await runGit(repoPath, ["init"]);
  await runGit(repoPath, ["config", "user.email", "integration@codeporter.local"]);
  await runGit(repoPath, ["config", "user.name", "Code Porter Integration"]);
  await runGit(repoPath, ["add", "."]);
  await runGit(repoPath, ["commit", "-m", "baseline fixture"]);

  if (input.makeDirty) {
    await writeFile(join(repoPath, "DIRTY.txt"), "dirty\n", "utf8");
  }

  return repoPath;
}

async function prepareNodeRepo(input: { repoName: string }): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), `${input.repoName}-`));
  await mkdir(join(repoPath, "src"), { recursive: true });
  await writeFile(
    join(repoPath, "package.json"),
    JSON.stringify(
      {
        name: "integration-node-repo",
        version: "1.0.0",
        scripts: {
          build: "node -e \"process.exit(1)\""
        }
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(join(repoPath, "src", "index.js"), "console.log('hello');\n", "utf8");

  await runGit(repoPath, ["init"]);
  await runGit(repoPath, ["config", "user.email", "integration@codeporter.local"]);
  await runGit(repoPath, ["config", "user.name", "Code Porter Integration"]);
  await runGit(repoPath, ["add", "."]);
  await runGit(repoPath, ["commit", "-m", "baseline node fixture"]);

  return repoPath;
}

async function apiFetch<T>(baseUrl: string, path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Request ${options?.method ?? "GET"} ${path} failed: ${JSON.stringify(payload)}`);
  }
  return payload as T;
}

async function apiFetchRaw(baseUrl: string, path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, options);
}

describe("API integration", () => {
  const hostPort = process.env.POSTGRES_HOST_PORT ?? "5433";
  const baseDbUrl =
    process.env.DATABASE_URL ??
    `postgresql://code_porter:code_porter@localhost:${hostPort}/code_porter`;
  const testDbUrl = deriveTestDatabaseUrl(baseDbUrl);
  const evidenceRootPromise = mkdtemp(join(tmpdir(), "code-porter-evidence-int-"));

  let evidenceRoot = "";
  let baseUrl = "";
  let server: Server;
  let queryDb: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  let closeDbPool: () => Promise<void>;
  let cleanupPaths: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbUrl;
    evidenceRoot = await evidenceRootPromise;
    process.env.EVIDENCE_ROOT = evidenceRoot;

    await ensureDatabaseExists(testDbUrl);

    const migrationModule = await import("../src/db/migrate.js");
    await migrationModule.runMigrations();

    const dbClient = await import("../src/db/client.js");
    queryDb = dbClient.query;
    closeDbPool = dbClient.closeDbPool;

    const { createApp } = await import("../src/app.js");
    server = createApp().listen(0);

    await new Promise<void>((resolveListen) => {
      server.once("listening", () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolveListen();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) {
          rejectClose(error);
          return;
        }
        resolveClose();
      });
    });
    await closeDbPool();

    await Promise.all(
      cleanupPaths.map(async (path) => {
        await rm(path, { recursive: true, force: true });
      })
    );
    await rm(evidenceRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await queryDb("truncate table evidence_artifacts, runs, campaigns, projects restart identity cascade");
  });

  it("runs project -> campaign -> plan -> apply and writes evidence artifacts", async () => {
    const repoPath = await prepareMavenRepo({ repoName: "code-porter-int-main" });
    cleanupPaths.push(repoPath);
    const sourceHeadBefore = await runGitStdout(repoPath, ["rev-parse", "HEAD"]);
    const sourceBranchBefore = await runGitStdout(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const sourceStatusBefore = await runGitStdout(repoPath, ["status", "--porcelain"]);
    expect(sourceStatusBefore).toBe("");

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-main",
        localPath: repoPath
      })
    });

    const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        policyId: "default",
        recipePack: "java-maven-core",
        targetSelector: sourceBranchBefore
      })
    });

    await apiFetch<{ runId: string; status: string }>(baseUrl, `/campaigns/${campaign.id}/plan`, {
      method: "POST"
    });

    const applyStart = await apiFetch<{ runId: string; status: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );

    const run = await apiFetch<{
      status: string;
      branchName: string | null;
      evidencePath: string;
      summary: { workspace?: { branchName?: string } };
      evidenceArtifacts: Array<{ type: string; path: string }>;
    }>(baseUrl, `/runs/${applyStart.runId}`);

    expect(["completed", "needs_review", "blocked"]).toContain(run.status);
    expect(run.evidenceArtifacts.length).toBeGreaterThan(0);

    const requiredArtifacts = [
      "run.json",
      "scan.json",
      "plan.json",
      "apply.json",
      "verify.json",
      "policy-decisions.json",
      "score.json"
    ];

    const artifactTypes = run.evidenceArtifacts.map((artifact) => artifact.type);
    for (const artifactType of requiredArtifacts) {
      expect(artifactTypes).toContain(artifactType);
    }
    expect(artifactTypes).toContain("evidence.zip");

    for (const artifact of run.evidenceArtifacts) {
      await access(artifact.path);
    }
    const manifestPath = join(run.evidencePath, "manifest.json");
    await access(manifestPath);

    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      exports?: Array<{ type: string; sha256: string }>;
    };
    expect(Array.isArray(manifest.exports)).toBe(true);
    expect(
      manifest.exports?.some((artifact) => artifact.type === "evidence.zip" && artifact.sha256.length > 0)
    ).toBe(true);

    const evidenceZipResponse = await apiFetchRaw(baseUrl, `/runs/${applyStart.runId}/evidence.zip`);
    expect(evidenceZipResponse.status).toBe(200);
    expect(evidenceZipResponse.headers.get("content-type")).toContain("application/zip");
    const zipBytes = new Uint8Array(await evidenceZipResponse.arrayBuffer());
    expect(zipBytes.byteLength).toBeGreaterThan(0);

    const sourceHeadAfter = await runGitStdout(repoPath, ["rev-parse", "HEAD"]);
    const sourceStatusAfter = await runGitStdout(repoPath, ["status", "--porcelain"]);
    expect(sourceHeadAfter).toBe(sourceHeadBefore);
    expect(sourceStatusAfter).toBe("");
  });

  it("marks artifact resolution as blocked with null confidence score", async () => {
    const repoPath = await prepareMavenRepo({
      repoName: "code-porter-int-blocked",
      mutatePom: (pom) => {
        return pom.replace(
          "<version>3.8.1</version>",
          "<version>99.99.99</version>"
        );
      }
    });
    cleanupPaths.push(repoPath);

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-blocked",
        localPath: repoPath
      })
    });

    const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        policyId: "default",
        recipePack: "java-maven-core"
      })
    });

    const applyStart = await apiFetch<{ runId: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );

    const run = await apiFetch<{
      status: string;
      confidenceScore: number | null;
      summary: { blockedReason?: string };
    }>(baseUrl, `/runs/${applyStart.runId}`);

    expect(run.status).toBe("blocked");
    expect(run.confidenceScore).toBeNull();
    expect(run.summary.blockedReason).toContain("Verification blocked");
  });

  it("marks code failures as needs_review", async () => {
    const repoPath = await prepareNodeRepo({ repoName: "code-porter-int-node-failure" });
    cleanupPaths.push(repoPath);

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-node-failure",
        localPath: repoPath
      })
    });

    const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        policyId: "default",
        recipePack: "java-maven-core"
      })
    });

    const applyStart = await apiFetch<{ runId: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );

    const run = await apiFetch<{
      status: string;
      summary: Record<string, unknown>;
    }>(baseUrl, `/runs/${applyStart.runId}`);

    expect(run.status).toBe("needs_review");
  });

  it("returns blocked for dirty working tree precondition", async () => {
    const repoPath = await prepareMavenRepo({
      repoName: "code-porter-int-dirty",
      makeDirty: true
    });
    cleanupPaths.push(repoPath);

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-dirty",
        localPath: repoPath
      })
    });

    const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        policyId: "default",
        recipePack: "java-maven-core"
      })
    });

    const applyStart = await apiFetch<{ runId: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );

    const run = await apiFetch<{
      status: string;
      summary: { blockedReason?: string; error?: string };
    }>(baseUrl, `/runs/${applyStart.runId}`);

    expect(run.status).toBe("blocked");
    expect(run.summary.blockedReason ?? run.summary.error).toContain(
      "Apply blocked: source repository has uncommitted changes"
    );
  });

  it("rejects invalid project path and returns 404 for unknown run", async () => {
    const projectResponse = await apiFetchRaw(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "invalid-path",
        localPath: "/tmp/path-that-does-not-exist-12345"
      })
    });
    expect(projectResponse.status).toBe(400);

    const unknownRun = await apiFetchRaw(baseUrl, "/runs/not-a-real-run-id");
    expect(unknownRun.status).toBe(404);
  });

  it("reports health readiness and optional network probe", async () => {
    const health = await apiFetch<{
      db: { ok: boolean };
      tools: { git: boolean; mvn: boolean; java: boolean };
      javaVersion: string | null;
    }>(baseUrl, "/health");

    expect(health.db.ok).toBe(true);
    expect(typeof health.tools.git).toBe("boolean");
    expect(typeof health.tools.mvn).toBe("boolean");
    expect(typeof health.tools.java).toBe("boolean");

    const withNetwork = await apiFetch<{
      network?: { mavenCentral: { ok: boolean; status?: number; reason?: string } };
    }>(baseUrl, "/health?probe=network");

    expect(withNetwork.network?.mavenCentral).toBeDefined();
    expect(typeof withNetwork.network?.mavenCentral.ok).toBe("boolean");
  });

  it("stores prUrl for github projects with mocked GitHub PR API", async () => {
    const remoteRepo = await prepareMavenRepo({ repoName: "code-porter-int-github-remote" });
    cleanupPaths.push(remoteRepo);
    const remoteDefaultBranch = await runGitStdout(remoteRepo, ["rev-parse", "--abbrev-ref", "HEAD"]);

    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "integration-token";
    const realFetch = global.fetch;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("http://127.0.0.1")) {
        return realFetch(input, init);
      }

      if (url.includes("api.github.com/repos/Coreledger-tech/code-porter/pulls")) {
        return new Response(
          JSON.stringify({
            html_url: "https://github.com/Coreledger-tech/code-porter/pull/123"
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" }
          }
        );
      }

      return new Response(JSON.stringify({ default_branch: "main" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const project = await apiFetch<{ id: string }>(baseUrl, "/projects/github", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "github-integration",
          owner: "Coreledger-tech",
          repo: "code-porter",
          cloneUrl: remoteRepo,
          defaultBranch: remoteDefaultBranch
        })
      });

      const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          policyId: "default",
          recipePack: "java-maven-core",
          targetSelector: remoteDefaultBranch
        })
      });

      const applyStart = await apiFetch<{ runId: string }>(
        baseUrl,
        `/campaigns/${campaign.id}/apply`,
        { method: "POST" }
      );

      const run = await apiFetch<{
        id: string;
        prUrl?: string;
        summary: { prUrl?: string };
      }>(baseUrl, `/runs/${applyStart.runId}`);

      expect(run.prUrl).toBe("https://github.com/Coreledger-tech/code-porter/pull/123");
      expect(run.summary.prUrl).toBe("https://github.com/Coreledger-tech/code-porter/pull/123");
    } finally {
      if (originalToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = originalToken;
      }
      vi.unstubAllGlobals();
    }
  });
});
