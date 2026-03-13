import { generateKeyPairSync, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrLifecyclePollerWorker } from "../src/pr-poller-worker.js";
import { AsyncRunWorker } from "../src/run-worker.js";

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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function findArtifactPath(
  artifacts: Array<{ type: string; path: string }> | undefined,
  type: string,
  fallbackPath?: string
): string {
  const resolved = artifacts?.find((artifact) => artifact.type === type)?.path ?? fallbackPath;
  if (!resolved) {
    throw new Error(`Missing evidence artifact path for ${type}`);
  }
  return resolved;
}

function integrationS3Config(): {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
} {
  return {
    endpoint: process.env.S3_PUBLIC_ENDPOINT ?? "http://127.0.0.1:9000",
    region: process.env.S3_REGION ?? "us-east-1",
    bucket: process.env.S3_BUCKET ?? "code-porter-evidence",
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin",
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true").toLowerCase() !== "false"
  };
}

async function ensureS3BucketExists(config: {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}): Promise<void> {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });

  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
  }
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

async function prepareGradleRepo(input: {
  repoName: string;
  withWrapper?: boolean;
  android?: boolean;
  buildFileContent?: string;
  wrapperVersion?: string;
  gradlePropertiesContent?: string;
}): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), `${input.repoName}-`));
  await mkdir(join(repoPath, "src", "main", "java"), { recursive: true });
  await writeFile(
    join(repoPath, "build.gradle"),
    input.buildFileContent ??
      (input.android
        ? "plugins { id 'com.android.application' }\nandroid { namespace 'com.example.app' }\n"
        : "plugins { id 'java' }\nsourceCompatibility = JavaVersion.VERSION_1_8\nrepositories { mavenCentral() }\n"),
    "utf8"
  );
  await writeFile(join(repoPath, "src", "main", "java", "App.java"), "class App {}\n", "utf8");
  if (input.withWrapper) {
    await writeFile(join(repoPath, "gradlew"), "#!/bin/sh\nexit 0\n", "utf8");
    await mkdir(join(repoPath, "gradle", "wrapper"), { recursive: true });
    await writeFile(
      join(repoPath, "gradle", "wrapper", "gradle-wrapper.properties"),
      [
        "distributionBase=GRADLE_USER_HOME",
        "distributionPath=wrapper/dists",
        `distributionUrl=https\\://services.gradle.org/distributions/gradle-${input.wrapperVersion ?? "7.6.4"}-bin.zip`,
        "zipStoreBase=GRADLE_USER_HOME",
        "zipStorePath=wrapper/dists"
      ].join("\n"),
      "utf8"
    );
  }
  if (typeof input.gradlePropertiesContent === "string") {
    await writeFile(
      join(repoPath, "gradle.properties"),
      input.gradlePropertiesContent,
      "utf8"
    );
  }

  await runGit(repoPath, ["init"]);
  await runGit(repoPath, ["config", "user.email", "integration@codeporter.local"]);
  await runGit(repoPath, ["config", "user.name", "Code Porter Integration"]);
  await runGit(repoPath, ["add", "."]);
  await runGit(repoPath, ["commit", "-m", "baseline gradle fixture"]);

  return repoPath;
}

async function prepareLombokProcNoneRepo(input: { repoName: string }): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), `${input.repoName}-`));
  await mkdir(join(repoPath, "src", "main", "java", "com", "example"), {
    recursive: true
  });
  await writeFile(
    join(repoPath, "pom.xml"),
    [
      "<project xmlns=\"http://maven.apache.org/POM/4.0.0\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xsi:schemaLocation=\"http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd\">",
      "  <modelVersion>4.0.0</modelVersion>",
      "  <groupId>com.example</groupId>",
      "  <artifactId>lombok-proc-none</artifactId>",
      "  <version>1.0.0</version>",
      "  <properties>",
      "    <maven.compiler.source>17</maven.compiler.source>",
      "    <maven.compiler.target>17</maven.compiler.target>",
      "    <lombok.version>1.18.30</lombok.version>",
      "  </properties>",
      "  <dependencies>",
      "    <dependency>",
      "      <groupId>org.projectlombok</groupId>",
      "      <artifactId>lombok</artifactId>",
      "      <version>${lombok.version}</version>",
      "      <scope>provided</scope>",
      "    </dependency>",
      "  </dependencies>",
      "  <build>",
      "    <plugins>",
      "      <plugin>",
      "        <groupId>org.apache.maven.plugins</groupId>",
      "        <artifactId>maven-compiler-plugin</artifactId>",
      "        <version>3.11.0</version>",
      "        <configuration>",
      "          <proc>none</proc>",
      "        </configuration>",
      "      </plugin>",
      "    </plugins>",
      "  </build>",
      "</project>"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(repoPath, "src", "main", "java", "com", "example", "Person.java"),
    [
      "package com.example;",
      "",
      "import lombok.Builder;",
      "",
      "@Builder",
      "public class Person {",
      "  private final String name;",
      "",
      "  public static Person sample() {",
      "    return Person.builder().name(\"demo\").build();",
      "  }",
      "}"
    ].join("\n"),
    "utf8"
  );

  await runGit(repoPath, ["init"]);
  await runGit(repoPath, ["config", "user.email", "integration@codeporter.local"]);
  await runGit(repoPath, ["config", "user.name", "Code Porter Integration"]);
  await runGit(repoPath, ["add", "."]);
  await runGit(repoPath, ["commit", "-m", "baseline lombok fixture"]);

  return repoPath;
}

async function prepareMavenTestRuntimeRepo(input: { repoName: string }): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), `${input.repoName}-`));
  await mkdir(join(repoPath, "src", "test", "java", "com", "example"), {
    recursive: true
  });
  await writeFile(
    join(repoPath, "pom.xml"),
    [
      "<project xmlns=\"http://maven.apache.org/POM/4.0.0\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xsi:schemaLocation=\"http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd\">",
      "  <modelVersion>4.0.0</modelVersion>",
      "  <groupId>com.example</groupId>",
      "  <artifactId>runtime-test-repro</artifactId>",
      "  <version>1.0.0</version>",
      "  <build>",
      "    <plugins>",
      "      <plugin>",
      "        <groupId>org.apache.maven.plugins</groupId>",
      "        <artifactId>maven-surefire-plugin</artifactId>",
      "        <version>3.2.5</version>",
      "      </plugin>",
      "      <plugin>",
      "        <groupId>org.apache.maven.plugins</groupId>",
      "        <artifactId>maven-failsafe-plugin</artifactId>",
      "        <version>3.2.5</version>",
      "      </plugin>",
      "    </plugins>",
      "  </build>",
      "</project>"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(repoPath, "src", "test", "java", "com", "example", "RuntimeTest.java"),
    [
      "package com.example;",
      "",
      "public class RuntimeTest {}"
    ].join("\n"),
    "utf8"
  );

  await runGit(repoPath, ["init"]);
  await runGit(repoPath, ["config", "user.email", "integration@codeporter.local"]);
  await runGit(repoPath, ["config", "user.name", "Code Porter Integration"]);
  await runGit(repoPath, ["add", "."]);
  await runGit(repoPath, ["commit", "-m", "baseline runtime fixture"]);

  return repoPath;
}

async function prepareNestedMavenRepo(input: { repoName: string }): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), `${input.repoName}-`));
  const modulePath = join(repoPath, "my-app");
  const fixturePath = resolve(process.cwd(), "fixtures/java-maven-simple");
  await mkdir(modulePath, { recursive: true });
  await cp(fixturePath, modulePath, { recursive: true });
  await writeFile(join(repoPath, "README.md"), "# nested maven repo\n", "utf8");

  await runGit(repoPath, ["init"]);
  await runGit(repoPath, ["config", "user.email", "integration@codeporter.local"]);
  await runGit(repoPath, ["config", "user.name", "Code Porter Integration"]);
  await runGit(repoPath, ["add", "."]);
  await runGit(repoPath, ["commit", "-m", "baseline nested maven fixture"]);

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

type TerminalRunStatus =
  | "completed"
  | "needs_review"
  | "blocked"
  | "failed"
  | "cancelled";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

async function truncateIntegrationTablesWithRetry(
  queryDb: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>
): Promise<void> {
  const maxAttempts = 5;
  const statement =
    "truncate table evidence_artifacts, runs, campaigns, projects restart identity cascade";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await queryDb(statement);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isDeadlock = /deadlock detected/i.test(message);
      if (!isDeadlock || attempt === maxAttempts) {
        throw error;
      }
      await sleep(100 * attempt);
    }
  }
}

async function waitForRunTerminal<T extends {
  status: string;
  queueStatus?: string;
}>(input: {
  baseUrl: string;
  runId: string;
  timeoutMs?: number;
}): Promise<T> {
  const terminal = new Set<TerminalRunStatus>([
    "completed",
    "needs_review",
    "blocked",
    "failed",
    "cancelled"
  ]);
  const queueTerminal = new Set(["completed", "failed", "cancelled"]);

  const deadline = Date.now() + (input.timeoutMs ?? 120000);
  while (Date.now() < deadline) {
    const run = await apiFetch<T>(input.baseUrl, `/runs/${input.runId}`);
    if (
      terminal.has(run.status as TerminalRunStatus) &&
      queueTerminal.has(run.queueStatus ?? "completed")
    ) {
      return run;
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for run ${input.runId} to finish`);
}

async function waitForRunStatus<T extends {
  status: string;
  queueStatus?: string;
}>(input: {
  baseUrl: string;
  runId: string;
  expectedStatuses: string[];
  timeoutMs?: number;
}): Promise<T> {
  const expected = new Set(input.expectedStatuses);
  const deadline = Date.now() + (input.timeoutMs ?? 60000);

  while (Date.now() < deadline) {
    const run = await apiFetch<T>(input.baseUrl, `/runs/${input.runId}`);
    if (expected.has(run.status)) {
      return run;
    }

    await sleep(200);
  }

  throw new Error(
    `Timed out waiting for run ${input.runId} to reach one of: ${input.expectedStatuses.join(", ")}`
  );
}

async function waitForRunEvent(
  input: {
    baseUrl: string;
    runId: string;
    timeoutMs?: number;
  },
  predicate: (event: {
    eventType: string;
    step: string | null;
    message: string;
  }) => boolean
): Promise<{
  eventType: string;
  step: string | null;
  message: string;
}> {
  const deadline = Date.now() + (input.timeoutMs ?? 30000);
  let afterId = 0;

  while (Date.now() < deadline) {
    const response = await apiFetch<{
      events: Array<{
        eventType: string;
        step: string | null;
        message: string;
      }>;
      nextAfterId: number;
    }>(input.baseUrl, `/runs/${input.runId}/events?afterId=${afterId}&limit=200`);

    for (const event of response.events) {
      if (predicate(event)) {
        return event;
      }
    }

    afterId = response.nextAfterId;
    await sleep(200);
  }

  throw new Error(`Timed out waiting for matching run event for ${input.runId}`);
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
  let worker: AsyncRunWorker;
  let workerPromise: Promise<void>;
  let queryDb: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  let closeDbPool: () => Promise<void>;
  let cleanupPaths: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbUrl;
    evidenceRoot = await evidenceRootPromise;
    process.env.EVIDENCE_ROOT = evidenceRoot;
    process.env.EVIDENCE_EXPORT_ROOT = join(evidenceRoot, "exports");

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

    worker = new AsyncRunWorker({
      workerId: "integration-worker",
      pollMs: 100,
      concurrency: 1
    });
    workerPromise = worker.start();
  });

  afterAll(async () => {
    if (worker) {
      worker.stop();
      if (workerPromise) {
        await Promise.race([
          workerPromise,
          sleep(5000)
        ]);
      }
    }

    if (server) {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });
    }
    if (closeDbPool) {
      await closeDbPool();
    }

    await Promise.all(
      cleanupPaths.map(async (path) => {
        await rm(path, { recursive: true, force: true });
      })
    );
    if (evidenceRoot) {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    await truncateIntegrationTablesWithRetry(queryDb);
    process.env.EVIDENCE_STORE_MODE = "local";
    process.env.EVIDENCE_KEEP_LOCAL_DISK = "true";
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

    const planStart = await apiFetch<{ runId: string; status: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/plan`,
      { method: "POST" }
    );
    expect(planStart.status).toBe("queued");
    await waitForRunTerminal({
      baseUrl,
      runId: planStart.runId
    });

    const applyStart = await apiFetch<{ runId: string; status: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );
    expect(applyStart.status).toBe("queued");

    const run = await waitForRunTerminal<{
      status: string;
      queueStatus: string;
      branchName: string | null;
      evidencePath: string;
      evidenceZipUrl: string | null;
      evidenceManifestUrl: string | null;
      summary: { workspace?: { branchName?: string } };
      evidenceArtifacts: Array<{ type: string; path: string }>;
    }>({
      baseUrl,
      runId: applyStart.runId
    });

    const eventsResponse = await apiFetch<{
      events: Array<{ eventType: string; step: string | null }>;
      nextAfterId: number;
    }>(baseUrl, `/runs/${applyStart.runId}/events`);

    expect(["completed", "needs_review", "blocked"]).toContain(run.status);
    expect(run.queueStatus).toMatch(/completed|failed/);
    expect(run.evidenceArtifacts.length).toBeGreaterThan(0);
    expect(eventsResponse.events.length).toBeGreaterThan(0);
    expect(eventsResponse.events.some((event) => event.step === "scan")).toBe(true);
    expect(eventsResponse.events.some((event) => event.step === "verify")).toBe(true);

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
    expect(run.evidenceZipUrl).toContain(`/runs/${applyStart.runId}/evidence.zip`);
    expect(run.evidenceManifestUrl).toContain(`/runs/${applyStart.runId}/evidence.manifest`);

    for (const artifact of run.evidenceArtifacts) {
      await access(artifact.path);
    }
    const manifestPath = findArtifactPath(
      run.evidenceArtifacts,
      "manifest.json",
      join(run.evidencePath, "manifest.json")
    );
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

    const manifestResponse = await apiFetchRaw(
      baseUrl,
      `/runs/${applyStart.runId}/evidence.manifest`
    );
    expect(manifestResponse.status).toBe(200);
    expect(manifestResponse.headers.get("content-type")).toContain("application/json");

    const sourceHeadAfter = await runGitStdout(repoPath, ["rev-parse", "HEAD"]);
    const sourceStatusAfter = await runGitStdout(repoPath, ["status", "--porcelain"]);
    expect(sourceHeadAfter).toBe(sourceHeadBefore);
    expect(sourceStatusAfter).toBe("");
  });

  it("uploads evidence to s3-compatible storage and returns remote URLs", async () => {
    const s3 = integrationS3Config();
    await ensureS3BucketExists(s3);

    process.env.EVIDENCE_STORE_MODE = "s3";
    process.env.S3_ENDPOINT = s3.endpoint;
    process.env.S3_PUBLIC_ENDPOINT = s3.endpoint;
    process.env.S3_REGION = s3.region;
    process.env.S3_BUCKET = s3.bucket;
    process.env.S3_ACCESS_KEY_ID = s3.accessKeyId;
    process.env.S3_SECRET_ACCESS_KEY = s3.secretAccessKey;
    process.env.S3_FORCE_PATH_STYLE = s3.forcePathStyle ? "true" : "false";
    process.env.EVIDENCE_URL_MODE = "signed";
    process.env.EVIDENCE_SIGNED_URL_TTL_SECONDS = "3600";

    const repoPath = await prepareMavenRepo({ repoName: "code-porter-int-s3" });
    cleanupPaths.push(repoPath);

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-s3",
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

    const applyStart = await apiFetch<{ runId: string; status: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );
    expect(applyStart.status).toBe("queued");

    const run = await waitForRunTerminal<{
      id: string;
      status: string;
      queueStatus: string;
      evidenceZipUrl: string | null;
      evidenceManifestUrl: string | null;
      evidenceStorage: "local_fs" | "s3";
      evidenceUrlMode: "signed" | "public" | "local_proxy";
    }>({
      baseUrl,
      runId: applyStart.runId
    });

    expect(run.evidenceStorage).toBe("s3");
    expect(run.evidenceUrlMode).toBe("signed");
    expect(run.evidenceZipUrl).toBeTruthy();
    expect(run.evidenceManifestUrl).toBeTruthy();
    expect(run.evidenceZipUrl).toContain("X-Amz-Algorithm");
    expect(run.evidenceManifestUrl).toContain("X-Amz-Algorithm");

    const artifactRows = await queryDb<{
      type: string;
      storage_type: string;
    }>(
      `select type, storage_type from evidence_artifacts where run_id = $1`,
      [applyStart.runId]
    );
    expect(
      artifactRows.rows.some(
        (row) => row.type === "evidence.zip" && row.storage_type === "s3"
      )
    ).toBe(true);
    expect(
      artifactRows.rows.some(
        (row) => row.type === "manifest.json" && row.storage_type === "s3"
      )
    ).toBe(true);

    const zipRoute = await fetch(`${baseUrl}/runs/${applyStart.runId}/evidence.zip`, {
      redirect: "manual"
    });
    expect([200, 302]).toContain(zipRoute.status);

    const manifestRoute = await fetch(`${baseUrl}/runs/${applyStart.runId}/evidence.manifest`, {
      redirect: "manual"
    });
    expect([200, 302]).toContain(manifestRoute.status);
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

    const applyStart = await apiFetch<{ runId: string; status: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );
    expect(applyStart.status).toBe("queued");

    const run = await waitForRunTerminal<{
      status: string;
      confidenceScore: number | null;
      summary: { blockedReason?: string };
    }>({
      baseUrl,
      runId: applyStart.runId
    });

    expect(run.status).toBe("blocked");
    expect(run.confidenceScore).toBeNull();
    expect(run.summary.blockedReason).toContain("Artifact resolution failed");
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

    const applyStart = await apiFetch<{ runId: string; status: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );
    expect(applyStart.status).toBe("queued");

    const run = await waitForRunTerminal<{
      status: string;
      summary: Record<string, unknown>;
    }>({
      baseUrl,
      runId: applyStart.runId
    });

    expect(run.status).toBe("needs_review");
  });

  it("runs planning against a nested Maven build root and records it in summary", async () => {
    const repoPath = await prepareNestedMavenRepo({
      repoName: "code-porter-int-nested-maven"
    });
    cleanupPaths.push(repoPath);

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-nested-maven",
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

    const planStart = await apiFetch<{ runId: string; status: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/plan`,
      { method: "POST" }
    );

    const run = await waitForRunTerminal<{
      status: string;
      summary: {
        failureKind?: string;
        scan?: {
          selectedBuildSystem?: string;
          selectedBuildRoot?: string;
          selectedManifestPath?: string;
        };
      };
    }>({
      baseUrl,
      runId: planStart.runId
    });

    expect(run.summary.scan?.selectedBuildSystem).toBe("maven");
    expect(run.summary.scan?.selectedBuildRoot).toBe("my-app");
    expect(run.summary.scan?.selectedManifestPath).toBe("my-app/pom.xml");
    if (run.status === "needs_review") {
      expect(run.summary.failureKind).toBe("manual_review_required");
    }
  });

  it("applies the lombok delombok compatibility pack and records the phase shift in evidence", async () => {
    const lombokPom = await readFile(
      resolve(process.cwd(), "fixtures/recipes/maven-lombok-delombok-phase-pom.xml"),
      "utf8"
    );
    const repoPath = await prepareMavenRepo({
      repoName: "code-porter-int-lombok-delombok",
      mutatePom: () => lombokPom
    });
    cleanupPaths.push(repoPath);

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-lombok-delombok",
        localPath: repoPath
      })
    });

    const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        policyId: "default",
        recipePack: "java-maven-lombok-delombok-compat-pack"
      })
    });

    const applyStart = await apiFetch<{ runId: string; status: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );

    const run = await waitForRunTerminal<{
      status: string;
      evidencePath: string;
      evidenceArtifacts: Array<{ type: string; path: string }>;
    }>({
      baseUrl,
      runId: applyStart.runId
    });

    expect(["completed", "needs_review", "blocked"]).toContain(run.status);

    const applyPath = findArtifactPath(
      run.evidenceArtifacts,
      "apply.json",
      join(run.evidencePath, "apply.json")
    );
    const applyArtifact = JSON.parse(await readFile(applyPath, "utf8")) as {
      recipesApplied?: string[];
    };
    expect(applyArtifact.recipesApplied).toContain(
      "java.maven.lombok-delombok-prepare-package"
    );

    const diffArtifact = run.evidenceArtifacts.find((artifact) => artifact.type === "artifacts/diff.patch");
    expect(diffArtifact).toBeDefined();
    const diff = await readFile(diffArtifact!.path, "utf8");
    expect(diff).toContain("generate-sources");
    expect(diff).toContain("prepare-package");
  });

  it("applies maven test-compat recipes and records matched test-signature rewrites", async () => {
    const repoPath = await prepareMavenRepo({
      repoName: "code-porter-int-maven-test-compat",
      mutatePom: (pom) =>
        pom.replace(
          "<build>",
          [
            "  <dependencies>",
            "    <dependency>",
            "      <groupId>org.junit.jupiter</groupId>",
            "      <artifactId>junit-jupiter</artifactId>",
            "      <version>5.10.2</version>",
            "      <scope>test</scope>",
            "    </dependency>",
            "  </dependencies>",
            "",
            "  <build>"
          ].join("\n")
        )
    });
    cleanupPaths.push(repoPath);
    await mkdir(join(repoPath, "src", "test", "java", "com", "example"), { recursive: true });
    await writeFile(
      join(repoPath, "src", "test", "java", "com", "example", "NashornIgnoreTest.java"),
      [
        "package com.example;",
        "import jdk.nashorn.internal.ir.annotations.Ignore;",
        "public class NashornIgnoreTest {",
        "  @Ignore",
        "  void skipped() {}",
        "}"
      ].join("\n"),
      "utf8"
    );
    await runGit(repoPath, ["add", "."]);
    await runGit(repoPath, ["commit", "-m", "add nashorn ignore test signature"]);

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-maven-test-compat",
        localPath: repoPath
      })
    });

    const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        policyId: "default",
        recipePack: "java-maven-test-compat-pack"
      })
    });

    const applyStart = await apiFetch<{ runId: string; status: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );

    const run = await waitForRunTerminal<{
      status: string;
      evidencePath: string;
      evidenceArtifacts: Array<{ type: string; path: string }>;
    }>({
      baseUrl,
      runId: applyStart.runId
    });

    expect(["completed", "needs_review", "blocked"]).toContain(run.status);
    const applyArtifact = JSON.parse(
      await readFile(
        findArtifactPath(run.evidenceArtifacts, "apply.json", join(run.evidencePath, "apply.json")),
        "utf8"
      )
    ) as {
      recipesApplied?: string[];
      advisories?: string[];
    };
    expect(applyArtifact.recipesApplied).toContain("java.maven.nashorn-ignore-import-rewrite");
    expect(applyArtifact.recipesApplied).toContain("java.maven.junit-ignore-compat");
    expect(
      applyArtifact.advisories?.some((advisory) =>
        advisory.includes("Matched test-failure signature")
      )
    ).toBe(true);

    const diffArtifact = run.evidenceArtifacts.find((artifact) => artifact.type === "artifacts/diff.patch");
    expect(diffArtifact).toBeDefined();
    const diff = await readFile(diffArtifact!.path, "utf8");
    expect(diff).toContain("import org.junit.jupiter.api.Disabled;");
    expect(diff).toContain("@Disabled");
  });

  it("applies maven test-compat v2 recipes with namespace rewrite and nashorn-core dependency ensure", async () => {
    const repoPath = await prepareMavenRepo({
      repoName: "code-porter-int-maven-test-compat-v2",
      mutatePom: (pom) =>
        pom.replace(
          "<build>",
          [
            "  <dependencies>",
            "    <dependency>",
            "      <groupId>org.junit.jupiter</groupId>",
            "      <artifactId>junit-jupiter</artifactId>",
            "      <version>5.10.2</version>",
            "      <scope>test</scope>",
            "    </dependency>",
            "  </dependencies>",
            "",
            "  <build>"
          ].join("\n")
        )
    });
    cleanupPaths.push(repoPath);
    await mkdir(join(repoPath, "src", "test", "java", "com", "example"), { recursive: true });
    await writeFile(
      join(repoPath, "src", "test", "java", "com", "example", "NashornV2CompatTest.java"),
      [
        "package com.example;",
        "import jdk.nashorn.internal.ir.annotations.Ignore;",
        "import jdk.nashorn.api.scripting.ScriptObjectMirror;",
        "public class NashornV2CompatTest {",
        "  @Ignore",
        "  void skipped() {",
        "    ScriptObjectMirror mirror = null;",
        "  }",
        "}"
      ].join("\n"),
      "utf8"
    );
    await runGit(repoPath, ["add", "."]);
    await runGit(repoPath, ["commit", "-m", "add stage5 nashorn test signatures"]);

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-maven-test-compat-v2",
        localPath: repoPath
      })
    });

    const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        policyId: "pilot-stage5",
        recipePack: "java-maven-test-compat-v2-pack"
      })
    });

    const applyStart = await apiFetch<{ runId: string; status: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );

    const run = await waitForRunTerminal<{
      status: string;
      evidencePath: string;
      evidenceArtifacts: Array<{ type: string; path: string }>;
    }>({
      baseUrl,
      runId: applyStart.runId
    });

    expect(["completed", "needs_review", "blocked"]).toContain(run.status);
    const applyArtifact = JSON.parse(
      await readFile(
        findArtifactPath(run.evidenceArtifacts, "apply.json", join(run.evidencePath, "apply.json")),
        "utf8"
      )
    ) as {
      recipesApplied?: string[];
      advisories?: string[];
    };
    expect(applyArtifact.recipesApplied).toContain("java.maven.nashorn-namespace-rewrite");
    expect(applyArtifact.recipesApplied).toContain("java.maven.junit-ignore-compat-v2");
    expect(applyArtifact.recipesApplied).toContain("java.maven.nashorn-core-test-dependency");
    expect(
      applyArtifact.advisories?.some((advisory) => advisory.includes("Matched test-failure signature"))
    ).toBe(true);

    const diffArtifact = run.evidenceArtifacts.find((artifact) => artifact.type === "artifacts/diff.patch");
    expect(diffArtifact).toBeDefined();
    const diff = await readFile(diffArtifact!.path, "utf8");
    expect(diff).toContain("org.openjdk.nashorn.api.scripting.ScriptObjectMirror");
    expect(diff).toContain("<artifactId>nashorn-core</artifactId>");
    expect(diff).toContain("import org.junit.jupiter.api.Disabled;");
    expect(diff).toContain("@Disabled");
  });

  it("classifies policy-excluded gradle repos as unsupported_build_system", async () => {
    const repoPath = await prepareGradleRepo({ repoName: "code-porter-int-gradle-policy" });
    cleanupPaths.push(repoPath);

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-gradle-policy",
        localPath: repoPath
      })
    });

    const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        policyId: "pilot-conservative",
        recipePack: "java-maven-core"
      })
    });

    const applyStart = await apiFetch<{ runId: string; status: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );

    const run = await waitForRunTerminal<{
      status: string;
      summary: {
        failureKind?: string;
        scan?: {
          selectedBuildSystem?: string;
          buildSystemDisposition?: string;
          buildSystemReason?: string;
        };
      };
    }>({
      baseUrl,
      runId: applyStart.runId
    });

    expect(run.status).toBe("needs_review");
    expect(run.summary.failureKind).toBe("unsupported_build_system");
    expect(run.summary.scan?.selectedBuildSystem).toBe("gradle");
    expect(run.summary.scan?.buildSystemDisposition).toBe("excluded_by_policy");
    expect(run.summary.scan?.buildSystemReason).toContain("excluded by policy");

    const report = await apiFetch<{
      topFailureKinds: Array<{ failureKind: string; count: number }>;
    }>(baseUrl, "/reports/pilot?window=30d");
    expect(
      report.topFailureKinds.some((item) => item.failureKind === "unsupported_build_system")
    ).toBe(true);
  });

  it("runs wrapper-based JVM gradle lane with explicit scan metadata", async () => {
    const repoPath = await prepareGradleRepo({
      repoName: "code-porter-int-gradle-jvm",
      withWrapper: true
    });
    cleanupPaths.push(repoPath);

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-gradle-jvm",
        localPath: repoPath
      })
    });

    const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        policyId: "pilot-stage3",
        recipePack: "java-gradle-java17-baseline-pack"
      })
    });

    const applyStart = await apiFetch<{ runId: string; status: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );

    const run = await waitForRunTerminal<{
      status: string;
      summary: {
        scan?: {
          selectedBuildSystem?: string;
          buildSystemDisposition?: string;
          gradleProjectType?: string;
          gradleWrapperPath?: string;
        };
      };
      evidencePath: string;
      evidenceArtifacts: Array<{ type: string; path: string }>;
    }>({
      baseUrl,
      runId: applyStart.runId
    });

    expect(["completed", "needs_review"]).toContain(run.status);
    expect(run.summary.scan?.selectedBuildSystem).toBe("gradle");
    expect(run.summary.scan?.buildSystemDisposition).toBe("supported");
    expect(run.summary.scan?.gradleProjectType).toBe("jvm");
    expect(run.summary.scan?.gradleWrapperPath).toBe("gradlew");

    const applyArtifact = JSON.parse(
      await readFile(
        findArtifactPath(run.evidenceArtifacts, "apply.json", join(run.evidencePath, "apply.json")),
        "utf8"
      )
    ) as { recipesApplied?: string[] };
    expect(applyArtifact.recipesApplied).toContain("java.gradle.java17-baseline");

    const verifyArtifact = JSON.parse(
      await readFile(
        findArtifactPath(
          run.evidenceArtifacts,
          "verify.json",
          join(run.evidencePath, "verify.json")
        ),
        "utf8"
      )
    ) as {
      compile: { status: string };
      tests: { status: string };
    };
    expect(verifyArtifact.compile.status).toBe("passed");
    expect(["passed", "not_run"]).toContain(verifyArtifact.tests.status);
  });

  it("returns a precise blocked reason for JVM gradle repos without wrapper", async () => {
    const repoPath = await prepareGradleRepo({
      repoName: "code-porter-int-gradle-no-wrapper",
      withWrapper: false
    });
    cleanupPaths.push(repoPath);

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-gradle-no-wrapper",
        localPath: repoPath
      })
    });

    const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        policyId: "pilot-stage3",
        recipePack: "java-gradle-java17-baseline-pack"
      })
    });

    const applyStart = await apiFetch<{ runId: string; status: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );

    const run = await waitForRunTerminal<{
      status: string;
      summary: { blockedReason?: string; failureKind?: string };
    }>({
      baseUrl,
      runId: applyStart.runId
    });

    expect(run.status).toBe("blocked");
    expect(run.summary.failureKind).toBe("tool_missing");
    expect(run.summary.blockedReason).toContain("Gradle wrapper missing");
  });

  it("classifies Android gradle repos as unsupported_subtype without attempting verify", async () => {
    const repoPath = await prepareGradleRepo({
      repoName: "code-porter-int-gradle-android",
      withWrapper: true,
      android: true
    });
    cleanupPaths.push(repoPath);

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-gradle-android",
        localPath: repoPath
      })
    });

    const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        policyId: "pilot-stage3",
        recipePack: "java-gradle-java17-baseline-pack"
      })
    });

    const applyStart = await apiFetch<{ runId: string; status: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );

    const run = await waitForRunTerminal<{
      status: string;
      summary: {
        failureKind?: string;
        scan?: {
          buildSystemDisposition?: string;
          buildSystemReason?: string;
          gradleProjectType?: string;
        };
      };
    }>({
      baseUrl,
      runId: applyStart.runId
    });

    expect(run.status).toBe("needs_review");
    expect(run.summary.failureKind).toBe("unsupported_build_system");
    expect(run.summary.scan?.buildSystemDisposition).toBe("unsupported_subtype");
    expect(run.summary.scan?.gradleProjectType).toBe("android");
    expect(run.summary.scan?.buildSystemReason).toContain("out of scope");
  });

  it("allows guarded Android gradle baseline apply mode and returns precise needs_review verify reason", async () => {
    const repoPath = await prepareGradleRepo({
      repoName: "code-porter-int-gradle-android-stage4",
      withWrapper: true,
      android: true,
      wrapperVersion: "6.9.4"
    });
    cleanupPaths.push(repoPath);

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-gradle-android-stage4",
        localPath: repoPath
      })
    });

    const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        policyId: "pilot-stage4",
        recipePack: "java-gradle-java17-baseline-pack"
      })
    });

    const applyStart = await apiFetch<{ runId: string; status: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );

    const run = await waitForRunTerminal<{
      status: string;
      summary: {
        failureKind?: string;
        scan?: {
          buildSystemDisposition?: string;
          gradleProjectType?: string;
          buildSystemReason?: string;
        };
      };
      evidencePath: string;
      evidenceArtifacts: Array<{ type: string; path: string }>;
    }>({
      baseUrl,
      runId: applyStart.runId
    });

    expect(run.status).toBe("needs_review");
    expect(run.summary.failureKind).toBe("guarded_baseline_applied");
    expect(run.summary.scan?.buildSystemDisposition).toBe("supported");
    expect(run.summary.scan?.gradleProjectType).toBe("android");
    expect(run.summary.scan?.buildSystemReason).toContain("baseline apply mode is enabled");

    const applyArtifact = JSON.parse(
      await readFile(
        findArtifactPath(run.evidenceArtifacts, "apply.json", join(run.evidencePath, "apply.json")),
        "utf8"
      )
    ) as { recipesApplied?: string[] };
    expect(applyArtifact.recipesApplied).toContain("java.gradle.wrapper-java17-min");

    const verifyArtifact = JSON.parse(
      await readFile(
        findArtifactPath(
          run.evidenceArtifacts,
          "verify.json",
          join(run.evidencePath, "verify.json")
        ),
        "utf8"
      )
    ) as {
      compile: { status: string; reason?: string };
      tests: { status: string; reason?: string };
    };
    expect(verifyArtifact.compile.status).toBe("not_run");
    expect(verifyArtifact.tests.status).toBe("not_run");
    expect(verifyArtifact.compile.reason).toContain("skips Gradle task execution");
  });

  it("opens PR metadata for guarded Android gradle baseline and records explicit guarded reason", async () => {
    const remoteRepo = await prepareGradleRepo({
      repoName: "code-porter-int-stage5-guarded-android-github",
      withWrapper: true,
      android: true,
      wrapperVersion: "6.9.4"
    });
    cleanupPaths.push(remoteRepo);
    const remoteDefaultBranch = await runGitStdout(remoteRepo, ["rev-parse", "--abbrev-ref", "HEAD"]);

    const originalAuthMode = process.env.GITHUB_AUTH_MODE;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_AUTH_MODE = "pat";
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
            html_url: "https://github.com/Coreledger-tech/code-porter/pull/987",
            number: 987
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
          name: "stage5-guarded-android-github",
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
          policyId: "pilot-stage5",
          recipePack: "java-gradle-guarded-baseline-pack",
          targetSelector: remoteDefaultBranch
        })
      });

      const applyStart = await apiFetch<{ runId: string; status: string }>(
        baseUrl,
        `/campaigns/${campaign.id}/apply`,
        { method: "POST" }
      );

      const run = await waitForRunTerminal<{
        status: string;
        prUrl?: string | null;
        summary: {
          failureKind?: string;
          guardedBaselineReason?: string;
          scan?: {
            selectedBuildSystem?: string;
            gradleProjectType?: string;
            buildSystemDisposition?: string;
          };
        };
        evidencePath: string;
        evidenceArtifacts: Array<{ type: string; path: string }>;
      }>({
        baseUrl,
        runId: applyStart.runId
      });

      expect(run.status).toBe("needs_review");
      expect(run.prUrl).toBe("https://github.com/Coreledger-tech/code-porter/pull/987");
      expect(run.summary.failureKind).toBe("guarded_baseline_applied");
      expect(run.summary.scan?.selectedBuildSystem).toBe("gradle");
      expect(run.summary.scan?.gradleProjectType).toBe("android");
      expect(run.summary.scan?.buildSystemDisposition).toBe("supported");
      expect(run.summary.guardedBaselineReason).toContain("skips Gradle task execution");

      const applyArtifact = JSON.parse(
        await readFile(
          findArtifactPath(run.evidenceArtifacts, "apply.json", join(run.evidencePath, "apply.json")),
          "utf8"
        )
      ) as { recipesApplied?: string[] };
      expect(applyArtifact.recipesApplied).toContain("java.gradle.wrapper-java17-min");
      expect(applyArtifact.recipesApplied).toContain("java.gradle.guarded-properties-baseline");

      const verifyArtifact = JSON.parse(
        await readFile(
          findArtifactPath(
            run.evidenceArtifacts,
            "verify.json",
            join(run.evidencePath, "verify.json")
          ),
          "utf8"
        )
      ) as {
        compile: { status: string; reason?: string };
        tests: { status: string; reason?: string };
      };
      expect(verifyArtifact.compile.status).toBe("not_run");
      expect(verifyArtifact.tests.status).toBe("not_run");
      expect(verifyArtifact.compile.reason).toContain("skips Gradle task execution");
    } finally {
      if (originalAuthMode === undefined) {
        delete process.env.GITHUB_AUTH_MODE;
      } else {
        process.env.GITHUB_AUTH_MODE = originalAuthMode;
      }
      if (originalToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = originalToken;
      }
      vi.unstubAllGlobals();
    }
  });

  it("classifies guarded Android no-op runs explicitly and skips PR creation", async () => {
    const repoPath = await prepareGradleRepo({
      repoName: "code-porter-int-stage10-guarded-android-noop",
      withWrapper: true,
      android: true,
      wrapperVersion: "7.6.4",
      gradlePropertiesContent: [
        "org.gradle.java.installations.auto-detect=true",
        "org.gradle.java.installations.auto-download=true"
      ].join("\n")
    });
    cleanupPaths.push(repoPath);

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-gradle-android-stage10-noop",
        localPath: repoPath
      })
    });

    const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        policyId: "pilot-stage8",
        recipePack: "java-gradle-guarded-baseline-pack"
      })
    });

    const applyStart = await apiFetch<{ runId: string; status: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );

    const run = await waitForRunTerminal<{
      status: string;
      prUrl?: string | null;
      summary: {
        failureKind?: string;
        guardedBaselineNoop?: boolean;
        guardedBaselineReason?: string;
        scan?: {
          gradleProjectType?: string;
          buildSystemDisposition?: string;
        };
      };
      evidencePath: string;
      evidenceArtifacts: Array<{ type: string; path: string }>;
    }>({
      baseUrl,
      runId: applyStart.runId
    });

    expect(run.status).toBe("needs_review");
    expect(run.prUrl ?? null).toBeNull();
    expect(run.summary.failureKind).toBe("guarded_baseline_noop");
    expect(run.summary.guardedBaselineNoop).toBe(true);
    expect(run.summary.guardedBaselineReason).toContain("already satisfied");
    expect(run.summary.scan?.gradleProjectType).toBe("android");
    expect(run.summary.scan?.buildSystemDisposition).toBe("supported");

    const checklistArtifact = JSON.parse(
      await readFile(
        findArtifactPath(
          run.evidenceArtifacts,
          "merge-checklist.json",
          join(run.evidencePath, "merge-checklist.json")
        ),
        "utf8"
      )
    ) as { passed: boolean; advisories?: string[] };
    expect(checklistArtifact.passed).toBe(true);
    expect(checklistArtifact.advisories?.some((item) => item.includes("already satisfied"))).toBe(
      true
    );
  });

  it("applies Maven compile remediation and records remediation evidence", async () => {
    const repoPath = await prepareLombokProcNoneRepo({
      repoName: "code-porter-int-maven-compile-remediation"
    });
    cleanupPaths.push(repoPath);

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-maven-compile-remediation",
        localPath: repoPath
      })
    });

    const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        policyId: "pilot-stage3",
        recipePack: "java-maven-lombok-delombok-compat-pack"
      })
    });

    const applyStart = await apiFetch<{ runId: string; status: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );

    const run = await waitForRunTerminal<{
      status: string;
      evidencePath: string;
      evidenceArtifacts: Array<{ type: string; path: string }>;
      summary: {
        applySummary?: {
          remediation?: {
            rulesApplied?: string[];
          };
        };
      };
    }>({
      baseUrl,
      runId: applyStart.runId,
      timeoutMs: 5 * 60 * 1000
    });

    expect(["completed", "needs_review"]).toContain(run.status);
    expect(run.summary.applySummary?.remediation?.rulesApplied).toContain("remove_proc_none");

    const remediation = JSON.parse(
      await readFile(
        findArtifactPath(
          run.evidenceArtifacts,
          "remediation.json",
          join(run.evidencePath, "remediation.json")
        ),
        "utf8"
      )
    ) as {
      applied: boolean;
      iterations: Array<{ ruleId: string }>;
    };
    expect(remediation.applied).toBe(true);
    expect(remediation.iterations.map((item) => item.ruleId)).toContain(
      "remove_proc_none"
    );

    const verifyArtifact = JSON.parse(
      await readFile(
        findArtifactPath(
          run.evidenceArtifacts,
          "verify.json",
          join(run.evidencePath, "verify.json")
        ),
        "utf8"
      )
    ) as { compile: { failureKind?: string; status: string } };
    expect(verifyArtifact.compile.status).toBe("passed");
  });

  it("applies test-runtime module-access remediation only for the Java 17 FileChannelImpl signature", async () => {
    const repoPath = await prepareMavenTestRuntimeRepo({
      repoName: "code-porter-int-maven-test-runtime-remediation"
    });
    cleanupPaths.push(repoPath);

    const fakeBin = await mkdtemp(join(tmpdir(), "code-porter-fake-mvn-runtime-"));
    cleanupPaths.push(fakeBin);
    const mvnScript = join(fakeBin, "mvn");
    await writeFile(
      mvnScript,
      [
        "#!/bin/sh",
        "set -eu",
        "ARGS=\"$*\"",
        "if echo \"$ARGS\" | grep -q \"dependency:resolve-plugins\"; then",
        "  exit 0",
        "fi",
        "if echo \"$ARGS\" | grep -q -- \"-DskipTests compile\"; then",
        "  echo \"compile ok\"",
        "  exit 0",
        "fi",
        "if echo \"$ARGS\" | grep -q \" test\"; then",
        "  if grep -q -- \"--add-opens=java.base/sun.nio.ch=ALL-UNNAMED\" pom.xml; then",
        "    echo \"tests ok\"",
        "    exit 0",
        "  fi",
        "  echo \"java.lang.IllegalAccessError: class org.apache.lucene.store.MMapDirectory cannot access class sun.nio.ch.FileChannelImpl because module java.base does not export sun.nio.ch\"",
        "  exit 1",
        "fi",
        "exit 0"
      ].join("\n"),
      "utf8"
    );
    await execFileAsync("chmod", ["+x", mvnScript]);

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;

    try {
      const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "integration-maven-test-runtime-remediation",
          localPath: repoPath
        })
      });

      const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          policyId: "pilot-stage6",
          recipePack: "java-maven-test-compat-v2-pack"
        })
      });

      const applyStart = await apiFetch<{ runId: string; status: string }>(
        baseUrl,
        `/campaigns/${campaign.id}/apply`,
        { method: "POST" }
      );

      const run = await waitForRunTerminal<{
        status: string;
        evidencePath: string;
        evidenceArtifacts: Array<{ type: string; path: string }>;
        summary: {
          applySummary?: {
            remediation?: {
              rulesApplied?: string[];
            };
          };
          failureKind?: string;
        };
      }>({
        baseUrl,
        runId: applyStart.runId,
        timeoutMs: 2 * 60 * 1000
      });

      expect(["completed", "needs_review"]).toContain(run.status);
      expect(run.summary.applySummary?.remediation?.rulesApplied).toContain(
        "ensure_add_opens_sun_nio_ch"
      );
      expect(run.summary.failureKind).not.toBe("java17_module_access_test_failure");

      const verifyArtifact = JSON.parse(
        await readFile(
          findArtifactPath(
            run.evidenceArtifacts,
            "verify.json",
            join(run.evidencePath, "verify.json")
          ),
          "utf8"
        )
      ) as { tests: { status: string; failureKind?: string } };
      expect(verifyArtifact.tests.status).toBe("passed");

      const remediationArtifact = JSON.parse(
        await readFile(
          findArtifactPath(
            run.evidenceArtifacts,
            "remediation-test-runtime.json",
            join(run.evidencePath, "remediation-test-runtime.json")
          ),
          "utf8"
        )
      ) as { applied: boolean; iterations?: Array<{ ruleId?: string }> };
      expect(remediationArtifact.applied).toBe(true);
      expect(remediationArtifact.iterations?.[0]?.ruleId).toBe("ensure_add_opens_sun_nio_ch");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("does not apply test-runtime module-access remediation for non-signature test failures", async () => {
    const repoPath = await prepareMavenTestRuntimeRepo({
      repoName: "code-porter-int-maven-test-runtime-no-signature"
    });
    cleanupPaths.push(repoPath);

    const fakeBin = await mkdtemp(join(tmpdir(), "code-porter-fake-mvn-runtime-generic-"));
    cleanupPaths.push(fakeBin);
    const mvnScript = join(fakeBin, "mvn");
    await writeFile(
      mvnScript,
      [
        "#!/bin/sh",
        "set -eu",
        "ARGS=\"$*\"",
        "if echo \"$ARGS\" | grep -q \"dependency:resolve-plugins\"; then",
        "  exit 0",
        "fi",
        "if echo \"$ARGS\" | grep -q -- \"-DskipTests compile\"; then",
        "  exit 0",
        "fi",
        "if echo \"$ARGS\" | grep -q \" test\"; then",
        "  echo \"java.lang.AssertionError: expected true\"",
        "  exit 1",
        "fi",
        "exit 0"
      ].join("\n"),
      "utf8"
    );
    await execFileAsync("chmod", ["+x", mvnScript]);

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;

    try {
      const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "integration-maven-test-runtime-no-signature",
          localPath: repoPath
        })
      });

      const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          policyId: "pilot-stage6",
          recipePack: "java-maven-test-compat-v2-pack"
        })
      });

      const applyStart = await apiFetch<{ runId: string; status: string }>(
        baseUrl,
        `/campaigns/${campaign.id}/apply`,
        { method: "POST" }
      );

      const run = await waitForRunTerminal<{
        status: string;
        evidencePath: string;
        evidenceArtifacts: Array<{ type: string; path: string }>;
        summary: {
          applySummary?: {
            remediation?: {
              rulesApplied?: string[];
            };
          };
          failureKind?: string;
        };
      }>({
        baseUrl,
        runId: applyStart.runId,
        timeoutMs: 2 * 60 * 1000
      });

      expect(run.status).toBe("needs_review");
      expect(run.summary.failureKind).toBe("code_test_failure");
      expect(run.summary.applySummary?.remediation?.rulesApplied ?? []).not.toContain(
        "ensure_add_opens_sun_nio_ch"
      );
      expect(run.evidenceArtifacts.some((artifact) => artifact.type === "remediation-test-runtime.json")).toBe(
        false
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("applies java.nio add-opens remediation for Chronicle reflective-access signatures", async () => {
    const repoPath = await prepareMavenTestRuntimeRepo({
      repoName: "code-porter-int-maven-test-runtime-chronicle-signature"
    });
    cleanupPaths.push(repoPath);

    const fakeBin = await mkdtemp(join(tmpdir(), "code-porter-fake-mvn-runtime-chronicle-"));
    cleanupPaths.push(fakeBin);
    const mvnScript = join(fakeBin, "mvn");
    await writeFile(
      mvnScript,
      [
        "#!/bin/sh",
        "set -eu",
        "ARGS=\"$*\"",
        "if echo \"$ARGS\" | grep -q \"dependency:resolve-plugins\"; then",
        "  exit 0",
        "fi",
        "if echo \"$ARGS\" | grep -q -- \"-DskipTests compile\"; then",
        "  exit 0",
        "fi",
        "if echo \"$ARGS\" | grep -q \" test\"; then",
        "  if grep -q -- \"--add-opens=java.base/java.nio=ALL-UNNAMED\" pom.xml; then",
        "    echo \"tests ok\"",
        "    exit 0",
        "  fi",
        "  echo \"java.lang.NoSuchFieldException: address\"",
        "  echo \"at net.openhft.chronicle.bytes.internal.NativeBytesStore\"",
        "  exit 1",
        "fi",
        "exit 0"
      ].join("\n"),
      "utf8"
    );
    await execFileAsync("chmod", ["+x", mvnScript]);

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;

    try {
      const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "integration-maven-test-runtime-chronicle",
          localPath: repoPath
        })
      });

      const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          policyId: "pilot-stage8",
          recipePack: "java-maven-test-compat-stage8-pack"
        })
      });

      const applyStart = await apiFetch<{ runId: string; status: string }>(
        baseUrl,
        `/campaigns/${campaign.id}/apply`,
        { method: "POST" }
      );

      const run = await waitForRunTerminal<{
        status: string;
        evidencePath: string;
        evidenceArtifacts: Array<{ type: string; path: string }>;
        summary: {
          applySummary?: {
            remediation?: {
              rulesApplied?: string[];
            };
          };
          failureKind?: string;
        };
      }>({
        baseUrl,
        runId: applyStart.runId,
        timeoutMs: 2 * 60 * 1000
      });

      expect(["completed", "needs_review"]).toContain(run.status);
      expect(run.summary.applySummary?.remediation?.rulesApplied).toContain(
        "ensure_add_opens_java_nio"
      );
      expect(run.summary.failureKind).not.toBe("java17_module_access_test_failure");

      const verifyArtifact = JSON.parse(
        await readFile(
          findArtifactPath(
            run.evidenceArtifacts,
            "verify.json",
            join(run.evidencePath, "verify.json")
          ),
          "utf8"
        )
      ) as { tests: { status: string } };
      expect(verifyArtifact.tests.status).toBe("passed");

      const remediationArtifact = JSON.parse(
        await readFile(
          findArtifactPath(
            run.evidenceArtifacts,
            "remediation-test-runtime.json",
            join(run.evidencePath, "remediation-test-runtime.json")
          ),
          "utf8"
        )
      ) as { iterations?: Array<{ ruleId?: string }> };
      expect(remediationArtifact.iterations?.[0]?.ruleId).toBe("ensure_add_opens_java_nio");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("applies java.lang add-opens remediation for Chronicle detailMessage reflective-access signatures", async () => {
    const repoPath = await prepareMavenTestRuntimeRepo({
      repoName: "code-porter-int-maven-test-runtime-chronicle-java-lang-signature"
    });
    cleanupPaths.push(repoPath);

    const fakeBin = await mkdtemp(
      join(tmpdir(), "code-porter-fake-mvn-runtime-chronicle-java-lang-")
    );
    cleanupPaths.push(fakeBin);
    const mvnScript = join(fakeBin, "mvn");
    await writeFile(
      mvnScript,
      [
        "#!/bin/sh",
        "set -eu",
        "ARGS=\"$*\"",
        "if echo \"$ARGS\" | grep -q \"dependency:resolve-plugins\"; then",
        "  exit 0",
        "fi",
        "if echo \"$ARGS\" | grep -q -- \"-DskipTests compile\"; then",
        "  exit 0",
        "fi",
        "if echo \"$ARGS\" | grep -q \" test\"; then",
        "  if grep -q -- \"--add-opens=java.base/java.lang=ALL-UNNAMED\" pom.xml; then",
        "    echo \"tests ok\"",
        "    exit 0",
        "  fi",
        "  echo \"java.lang.ExceptionInInitializerError\"",
        "  echo \"Caused by: java.lang.reflect.InaccessibleObjectException: Unable to make field private java.lang.String java.lang.Throwable.detailMessage accessible\"",
        "  echo \"module java.base does not \\\"opens java.lang\\\" to unnamed module\"",
        "  echo \"at net.openhft.chronicle.wire.WireInternal.<clinit>(WireInternal.java:52)\"",
        "  exit 1",
        "fi",
        "exit 0"
      ].join("\n"),
      "utf8"
    );
    await execFileAsync("chmod", ["+x", mvnScript]);

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;

    try {
      const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "integration-maven-test-runtime-chronicle-java-lang",
          localPath: repoPath
        })
      });

      const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          policyId: "pilot-stage8",
          recipePack: "java-maven-test-compat-stage8-pack"
        })
      });

      const applyStart = await apiFetch<{ runId: string; status: string }>(
        baseUrl,
        `/campaigns/${campaign.id}/apply`,
        { method: "POST" }
      );

      const run = await waitForRunTerminal<{
        status: string;
        evidencePath: string;
        evidenceArtifacts: Array<{ type: string; path: string }>;
        summary: {
          applySummary?: {
            remediation?: {
              rulesApplied?: string[];
            };
          };
          failureKind?: string;
        };
      }>({
        baseUrl,
        runId: applyStart.runId,
        timeoutMs: 2 * 60 * 1000
      });

      expect(["completed", "needs_review"]).toContain(run.status);
      expect(run.summary.applySummary?.remediation?.rulesApplied).toContain(
        "ensure_add_opens_java_lang"
      );
      expect(run.summary.failureKind).not.toBe("java17_module_access_test_failure");

      const verifyArtifact = JSON.parse(
        await readFile(
          findArtifactPath(
            run.evidenceArtifacts,
            "verify.json",
            join(run.evidencePath, "verify.json")
          ),
          "utf8"
        )
      ) as { tests: { status: string } };
      expect(verifyArtifact.tests.status).toBe("passed");

      const remediationArtifact = JSON.parse(
        await readFile(
          findArtifactPath(
            run.evidenceArtifacts,
            "remediation-test-runtime.json",
            join(run.evidencePath, "remediation-test-runtime.json")
          ),
          "utf8"
        )
      ) as { iterations?: Array<{ ruleId?: string }> };
      expect(remediationArtifact.iterations?.[0]?.ruleId).toBe("ensure_add_opens_java_lang");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("chains Chronicle runtime remediation when java.nio rerun times out and still exposes java.lang", async () => {
    const repoPath = await prepareMavenTestRuntimeRepo({
      repoName: "code-porter-int-maven-test-runtime-chronicle-chained"
    });
    cleanupPaths.push(repoPath);

    const fakeBin = await mkdtemp(
      join(tmpdir(), "code-porter-fake-mvn-runtime-chronicle-chained-")
    );
    cleanupPaths.push(fakeBin);
    const mvnScript = join(fakeBin, "mvn");
    await writeFile(
      mvnScript,
      [
        "#!/bin/sh",
        "set -eu",
        "ARGS=\"$*\"",
        "if echo \"$ARGS\" | grep -q \"dependency:resolve-plugins\"; then",
        "  exit 0",
        "fi",
        "if echo \"$ARGS\" | grep -q -- \"-DskipTests compile\"; then",
        "  exit 0",
        "fi",
        "if echo \"$ARGS\" | grep -q \" test\"; then",
        "  if grep -q -- \"--add-opens=java.base/java.lang=ALL-UNNAMED\" pom.xml; then",
        "    echo \"tests ok\"",
        "    exit 0",
        "  fi",
        "  if grep -q -- \"--add-opens=java.base/java.nio=ALL-UNNAMED\" pom.xml; then",
        "    echo \"java.lang.ExceptionInInitializerError\"",
        "    echo \"Caused by: java.lang.reflect.InaccessibleObjectException: Unable to make field private java.lang.String java.lang.Throwable.detailMessage accessible\"",
        "    echo \"module java.base does not \\\"opens java.lang\\\" to unnamed module\"",
        "    echo \"at net.openhft.chronicle.wire.WireInternal.<clinit>(WireInternal.java:52)\"",
        "    sleep 5",
        "    exit 1",
        "  fi",
        "  echo \"java.lang.NoSuchFieldException: address\"",
        "  echo \"at net.openhft.chronicle.bytes.internal.NativeBytesStore\"",
        "  exit 1",
        "fi",
        "exit 0"
      ].join("\n"),
      "utf8"
    );
    await execFileAsync("chmod", ["+x", mvnScript]);

    const originalPath = process.env.PATH;
    const originalVerifyTestTimeoutMs = process.env.VERIFY_TEST_TIMEOUT_MS;
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    process.env.VERIFY_TEST_TIMEOUT_MS = "2000";

    try {
      const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "integration-maven-test-runtime-chronicle-chained",
          localPath: repoPath
        })
      });

      const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          policyId: "pilot-stage8",
          recipePack: "java-maven-test-compat-stage8-pack"
        })
      });

      const applyStart = await apiFetch<{ runId: string; status: string }>(
        baseUrl,
        `/campaigns/${campaign.id}/apply`,
        { method: "POST" }
      );

      const run = await waitForRunTerminal<{
        status: string;
        evidencePath: string;
        evidenceArtifacts: Array<{ type: string; path: string }>;
        summary: {
          applySummary?: {
            remediation?: {
              rulesApplied?: string[];
            };
          };
          failureKind?: string;
        };
      }>({
        baseUrl,
        runId: applyStart.runId,
        timeoutMs: 2 * 60 * 1000
      });

      expect(["completed", "needs_review"]).toContain(run.status);
      expect(run.summary.applySummary?.remediation?.rulesApplied).toEqual([
        "ensure_add_opens_java_nio",
        "ensure_add_opens_java_lang"
      ]);
      expect(run.summary.failureKind).not.toBe("java17_module_access_test_failure");
      expect(run.summary.failureKind).not.toBe("verify_timeout");

      const verifyArtifact = JSON.parse(
        await readFile(
          findArtifactPath(
            run.evidenceArtifacts,
            "verify.json",
            join(run.evidencePath, "verify.json")
          ),
          "utf8"
        )
      ) as { tests: { status: string } };
      expect(verifyArtifact.tests.status).toBe("passed");

      const remediationArtifact = JSON.parse(
        await readFile(
          findArtifactPath(
            run.evidenceArtifacts,
            "remediation-test-runtime.json",
            join(run.evidencePath, "remediation-test-runtime.json")
          ),
          "utf8"
        )
      ) as {
        iterations?: Array<{ ruleId?: string; triggerFailureKind?: string }>;
      };
      expect(remediationArtifact.iterations).toEqual([
        expect.objectContaining({
          ruleId: "ensure_add_opens_java_nio",
          triggerFailureKind: "java17_module_access_test_failure"
        }),
        expect.objectContaining({
          ruleId: "ensure_add_opens_java_lang",
          triggerFailureKind: "verify_timeout"
        })
      ]);

      expect(
        run.evidenceArtifacts.some(
          (artifact) => artifact.type === "artifacts/remediation-test-runtime-1.patch"
        )
      ).toBe(true);
      expect(
        run.evidenceArtifacts.some(
          (artifact) => artifact.type === "artifacts/remediation-test-runtime-2.patch"
        )
      ).toBe(true);
    } finally {
      process.env.PATH = originalPath;
      if (originalVerifyTestTimeoutMs === undefined) {
        delete process.env.VERIFY_TEST_TIMEOUT_MS;
      } else {
        process.env.VERIFY_TEST_TIMEOUT_MS = originalVerifyTestTimeoutMs;
      }
    }
  });

  it("writes retrieval context evidence on verify failures when semantic retrieval is enabled", async () => {
    const repoPath = await prepareMavenTestRuntimeRepo({
      repoName: "code-porter-int-semantic-retrieval"
    });
    cleanupPaths.push(repoPath);

    const fakeBin = await mkdtemp(join(tmpdir(), "code-porter-fake-mvn-retrieval-"));
    cleanupPaths.push(fakeBin);
    const mvnScript = join(fakeBin, "mvn");
    await writeFile(
      mvnScript,
      [
        "#!/bin/sh",
        "set -eu",
        "ARGS=\"$*\"",
        "if echo \"$ARGS\" | grep -q \"dependency:resolve-plugins\"; then",
        "  exit 0",
        "fi",
        "if echo \"$ARGS\" | grep -q -- \"-DskipTests compile\"; then",
        "  exit 0",
        "fi",
        "if echo \"$ARGS\" | grep -q \" test\"; then",
        "  echo \"java.lang.AssertionError: retrieval failure trigger token=ghp_abcdefghijklmnopqrstuvwxyz123456\"",
        "  exit 1",
        "fi",
        "exit 0"
      ].join("\n"),
      "utf8"
    );
    await execFileAsync("chmod", ["+x", mvnScript]);

    const originalPath = process.env.PATH;
    const originalEnabled = process.env.SEMANTIC_RETRIEVAL_ENABLED;
    const originalProvider = process.env.SEMANTIC_RETRIEVAL_PROVIDER;
    const originalTopK = process.env.SEMANTIC_RETRIEVAL_TOP_K;
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    process.env.SEMANTIC_RETRIEVAL_ENABLED = "true";
    process.env.SEMANTIC_RETRIEVAL_PROVIDER = "claude_context";
    process.env.SEMANTIC_RETRIEVAL_TOP_K = "3";

    try {
      const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "integration-semantic-retrieval",
          localPath: repoPath
        })
      });

      const campaign = await apiFetch<{ id: string }>(baseUrl, "/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          policyId: "pilot-stage6",
          recipePack: "java-maven-test-compat-v2-pack"
        })
      });

      const applyStart = await apiFetch<{ runId: string; status: string }>(
        baseUrl,
        `/campaigns/${campaign.id}/apply`,
        { method: "POST" }
      );

      const run = await waitForRunTerminal<{
        status: string;
        evidencePath: string;
        evidenceArtifacts: Array<{ type: string; path: string }>;
      }>({
        baseUrl,
        runId: applyStart.runId,
        timeoutMs: 2 * 60 * 1000
      });

      expect(run.status).toBe("needs_review");
      const retrievalArtifactPath = findArtifactPath(
        run.evidenceArtifacts,
        "context/retrieval.json",
        join(run.evidencePath, "context", "retrieval.json")
      );
      const retrievalArtifact = JSON.parse(await readFile(retrievalArtifactPath, "utf8")) as {
        enabled?: boolean;
        error?: string;
        hits?: unknown[];
      };
      expect(retrievalArtifact.enabled).toBe(true);
      expect(
        typeof retrievalArtifact.error === "string" ||
          Array.isArray(retrievalArtifact.hits)
      ).toBe(true);
      expect(JSON.stringify(retrievalArtifact)).not.toContain(
        "ghp_abcdefghijklmnopqrstuvwxyz123456"
      );
    } finally {
      process.env.PATH = originalPath;
      if (originalEnabled === undefined) {
        delete process.env.SEMANTIC_RETRIEVAL_ENABLED;
      } else {
        process.env.SEMANTIC_RETRIEVAL_ENABLED = originalEnabled;
      }
      if (originalProvider === undefined) {
        delete process.env.SEMANTIC_RETRIEVAL_PROVIDER;
      } else {
        process.env.SEMANTIC_RETRIEVAL_PROVIDER = originalProvider;
      }
      if (originalTopK === undefined) {
        delete process.env.SEMANTIC_RETRIEVAL_TOP_K;
      } else {
        process.env.SEMANTIC_RETRIEVAL_TOP_K = originalTopK;
      }
    }
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

    const applyStart = await apiFetch<{ runId: string; status: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );
    expect(applyStart.status).toBe("queued");

    const run = await waitForRunTerminal<{
      status: string;
      summary: { blockedReason?: string; error?: string };
    }>({
      baseUrl,
      runId: applyStart.runId
    });

    expect(run.status).toBe("blocked");
    expect(run.summary.blockedReason ?? run.summary.error).toContain(
      "Apply blocked: source repository has uncommitted changes"
    );
  });

  it("returns 429 when inflight run limits are exceeded", async () => {
    const repoPath = await prepareMavenRepo({ repoName: "code-porter-int-throttle" });
    cleanupPaths.push(repoPath);

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-throttle",
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

    await queryDb(
      `insert into runs (id, campaign_id, mode, status, evidence_path, started_at)
       values ($1, $2, 'apply', 'running', $3, now()),
              ($4, $2, 'apply', 'running', $5, now())`,
      [
        randomUUID(),
        campaign.id,
        `/tmp/fake-evidence-${randomUUID()}`,
        randomUUID(),
        `/tmp/fake-evidence-${randomUUID()}`
      ]
    );

    const applyResponse = await apiFetchRaw(baseUrl, `/campaigns/${campaign.id}/apply`, {
      method: "POST"
    });

    expect(applyResponse.status).toBe(429);
    const payload = (await applyResponse.json()) as {
      error: string;
      limitType: string;
      currentInflight: number;
      limit: number;
      retryHint: string;
    };
    expect(payload.error).toBe("run start throttled by policy");
    expect(payload.limitType).toBe("project");
    expect(payload.currentInflight).toBeGreaterThanOrEqual(payload.limit);
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

  it("exposes prometheus metrics", async () => {
    const response = await apiFetchRaw(baseUrl, "/metrics");
    expect(response.status).toBe(200);
    const contentType = response.headers.get("content-type") ?? "";
    expect(contentType).toContain("text/plain");

    const body = await response.text();
    expect(body).toContain("codeporter_runs_enqueued_total");
    expect(body).toContain("codeporter_run_outcomes_total");
    expect(body).toContain("codeporter_runs_cancelled_total");
    expect(body).toContain("codeporter_queue_retries_total");
    expect(body).toContain("codeporter_queue_lease_reclaims_total");
  });

  it("pauses and resumes campaign and exposes summaries", async () => {
    const repoPath = await prepareMavenRepo({ repoName: "code-porter-int-pause-summary" });
    cleanupPaths.push(repoPath);

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-pause-summary",
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

    const paused = await apiFetch<{
      campaignId: string;
      lifecycleStatus: "paused";
      pausedAt: string;
    }>(baseUrl, `/campaigns/${campaign.id}/pause`, {
      method: "POST"
    });
    expect(paused.lifecycleStatus).toBe("paused");

    const blocked = await apiFetchRaw(baseUrl, `/campaigns/${campaign.id}/apply`, {
      method: "POST"
    });
    expect(blocked.status).toBe(409);

    const resumed = await apiFetch<{
      campaignId: string;
      lifecycleStatus: "active";
      resumedAt: string;
    }>(baseUrl, `/campaigns/${campaign.id}/resume`, {
      method: "POST"
    });
    expect(resumed.lifecycleStatus).toBe("active");

    const apply = await apiFetch<{ runId: string; status: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );
    expect(apply.status).toBe("queued");
    await waitForRunTerminal({
      baseUrl,
      runId: apply.runId
    });

    const projectSummary = await apiFetch<{
      projectId: string;
      totalsByStatus: Record<string, number>;
      recentRuns: Array<{ runId: string }>;
    }>(baseUrl, `/projects/${project.id}/summary`);
    expect(projectSummary.projectId).toBe(project.id);
    expect(projectSummary.recentRuns.length).toBeGreaterThan(0);

    const campaignSummary = await apiFetch<{
      campaignId: string;
      lifecycleStatus: string;
      totalsByStatus: Record<string, number>;
      recentRuns: Array<{ runId: string }>;
    }>(baseUrl, `/campaigns/${campaign.id}/summary`);
    expect(campaignSummary.campaignId).toBe(campaign.id);
    expect(campaignSummary.lifecycleStatus).toBe("active");
    expect(campaignSummary.recentRuns.length).toBeGreaterThan(0);
  });

  it("cancels a running run and reaches cancelled terminal state", async () => {
    const repoPath = await prepareMavenRepo({ repoName: "code-porter-int-cancel" });
    cleanupPaths.push(repoPath);
    const fakeBin = await mkdtemp(join(tmpdir(), "code-porter-int-cancel-fake-mvn-"));
    cleanupPaths.push(fakeBin);
    const mvnScript = join(fakeBin, "mvn");
    await writeFile(
      mvnScript,
      [
        "#!/bin/sh",
        "set -eu",
        "ARGS=\"$*\"",
        "if echo \"$ARGS\" | grep -q \"dependency:resolve-plugins\"; then",
        "  exit 0",
        "fi",
        "if echo \"$ARGS\" | grep -q -- \"-DskipTests compile\"; then",
        "  echo \"compile ok\"",
        "  exit 0",
        "fi",
        "if echo \"$ARGS\" | grep -q \" test\"; then",
        "  echo \"hung verify start\"",
        "  trap '' TERM INT",
        "  while :; do sleep 1; done",
        "fi",
        "exit 0"
      ].join("\n"),
      "utf8"
    );
    await execFileAsync("chmod", ["+x", mvnScript]);
    const originalPath = process.env.PATH;
    const originalTestTimeout = process.env.VERIFY_TEST_TIMEOUT_MS;
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    process.env.VERIFY_TEST_TIMEOUT_MS = "60000";

    try {
      const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "integration-cancel",
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

      const apply = await apiFetch<{ runId: string; status: string }>(
        baseUrl,
        `/campaigns/${campaign.id}/apply`,
        { method: "POST" }
      );
      expect(apply.status).toBe("queued");

      await waitForRunEvent(
        {
          baseUrl,
          runId: apply.runId,
          timeoutMs: 30000
        },
        (event) => event.eventType === "step_start" && event.step === "verify"
      );

      const cancel = await apiFetch<{
        runId: string;
        status: string;
        queueStatus: string;
        message?: string;
      }>(baseUrl, `/runs/${apply.runId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "operator cancel test" })
      });
      expect(cancel.runId).toBe(apply.runId);

      const run = await waitForRunTerminal<{
        status: string;
        queueStatus: string;
        evidencePath: string;
        evidenceArtifacts: Array<{ type: string; path: string }>;
        summary: Record<string, unknown>;
      }>({
        baseUrl,
        runId: apply.runId,
        timeoutMs: 60000
      });

      expect(run.status).toBe("cancelled");
      expect(run.queueStatus).toBe("cancelled");
      expect(run.summary.cancelRequestedAt).toBeTruthy();

      const verifyArtifact = JSON.parse(
        await readFile(
          findArtifactPath(
            run.evidenceArtifacts,
            "verify.json",
            join(run.evidencePath, "verify.json")
          ),
          "utf8"
        )
      ) as {
        compile: { status: string };
        tests: { status: string; aborted?: boolean; reason?: string; output?: string };
      };
      expect(verifyArtifact.compile.status).toBe("passed");
      expect(verifyArtifact.tests.status).toBe("failed");
      expect(verifyArtifact.tests.aborted).toBe(true);
      expect(verifyArtifact.tests.reason).toContain("operator cancel test");
      expect(verifyArtifact.tests.output).toContain("hung verify start");
    } finally {
      process.env.PATH = originalPath;
      if (originalTestTimeout === undefined) {
        delete process.env.VERIFY_TEST_TIMEOUT_MS;
      } else {
        process.env.VERIFY_TEST_TIMEOUT_MS = originalTestTimeout;
      }
    }
  });

  it("cleanup commands remove stale workspace and evidence cache entries", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "code-porter-int-workspace-cleanup-"));
    const evidenceCacheRoot = await mkdtemp(join(tmpdir(), "code-porter-int-evidence-cleanup-"));
    const evidenceExportRoot = await mkdtemp(
      join(tmpdir(), "code-porter-int-evidence-export-cleanup-")
    );
    cleanupPaths.push(workspaceRoot, evidenceCacheRoot, evidenceExportRoot);

    const staleWorkspace = join(workspaceRoot, "stale-workspace");
    const freshWorkspace = join(workspaceRoot, "fresh-workspace");
    const staleEvidence = join(evidenceCacheRoot, "stale-evidence");
    const freshEvidence = join(evidenceCacheRoot, "fresh-evidence");
    const staleExport = join(evidenceExportRoot, "stale-export");
    const freshExport = join(evidenceExportRoot, "fresh-export");

    await mkdir(staleWorkspace, { recursive: true });
    await mkdir(freshWorkspace, { recursive: true });
    await mkdir(staleEvidence, { recursive: true });
    await mkdir(freshEvidence, { recursive: true });
    await mkdir(staleExport, { recursive: true });
    await mkdir(freshExport, { recursive: true });

    const now = Date.now();
    const staleTime = new Date(now - 10 * 24 * 60 * 60 * 1000);
    const freshTime = new Date(now - 1 * 24 * 60 * 60 * 1000);

    await Promise.all([
      utimes(staleWorkspace, staleTime, staleTime),
      utimes(staleEvidence, staleTime, staleTime),
      utimes(staleExport, staleTime, staleTime),
      utimes(freshWorkspace, freshTime, freshTime),
      utimes(freshEvidence, freshTime, freshTime),
      utimes(freshExport, freshTime, freshTime)
    ]);

    await execFileAsync(
      "node",
      ["--import=tsx", "apps/api/src/ops/cleanup-workspaces.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WORKSPACE_ROOT: workspaceRoot,
          WORKSPACE_TTL_DAYS: "7"
        }
      }
    );

    expect(await exists(staleWorkspace)).toBe(false);
    expect(await exists(freshWorkspace)).toBe(true);

    await execFileAsync(
      "node",
      ["--import=tsx", "apps/api/src/ops/cleanup-evidence.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          EVIDENCE_STORE_MODE: "s3",
          EVIDENCE_KEEP_LOCAL_DISK: "true",
          EVIDENCE_CACHE_TTL_DAYS: "7",
          EVIDENCE_ROOT: evidenceCacheRoot,
          EVIDENCE_EXPORT_ROOT: evidenceExportRoot
        }
      }
    );

    expect(await exists(staleEvidence)).toBe(false);
    expect(await exists(freshEvidence)).toBe(true);
    expect(await exists(staleExport)).toBe(false);
    expect(await exists(freshExport)).toBe(true);
  });

  it("stores prUrl for github projects with mocked GitHub PR API", async () => {
    const remoteRepo = await prepareMavenRepo({ repoName: "code-porter-int-github-remote" });
    cleanupPaths.push(remoteRepo);
    const remoteDefaultBranch = await runGitStdout(remoteRepo, ["rev-parse", "--abbrev-ref", "HEAD"]);

    const originalAuthMode = process.env.GITHUB_AUTH_MODE;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_AUTH_MODE = "pat";
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

      const applyStart = await apiFetch<{ runId: string; status: string }>(
        baseUrl,
        `/campaigns/${campaign.id}/apply`,
        { method: "POST" }
      );
      expect(applyStart.status).toBe("queued");

      const run = await waitForRunTerminal<{
        id: string;
        status: string;
        queueStatus: string;
        prUrl?: string;
        summary: { prUrl?: string };
      }>({
        baseUrl,
        runId: applyStart.runId
      });

      expect(run.prUrl).toBe("https://github.com/Coreledger-tech/code-porter/pull/123");
      expect(run.summary.prUrl).toBe("https://github.com/Coreledger-tech/code-porter/pull/123");
    } finally {
      if (originalAuthMode === undefined) {
        delete process.env.GITHUB_AUTH_MODE;
      } else {
        process.env.GITHUB_AUTH_MODE = originalAuthMode;
      }
      if (originalToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = originalToken;
      }
      vi.unstubAllGlobals();
    }
  });

  it("keeps only one open keeper PR per project/base branch and closes superseded PRs", async () => {
    const remoteRepo = await prepareMavenRepo({ repoName: "code-porter-int-stage10-keeper-remote" });
    cleanupPaths.push(remoteRepo);
    const remoteDefaultBranch = await runGitStdout(remoteRepo, ["rev-parse", "--abbrev-ref", "HEAD"]);

    const originalAuthMode = process.env.GITHUB_AUTH_MODE;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_AUTH_MODE = "pat";
    process.env.GITHUB_TOKEN = "integration-token";
    const realFetch = global.fetch;

    let nextPrNumber = 100;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("http://127.0.0.1")) {
        return realFetch(input, init);
      }

      if (url.includes("api.github.com/repos/Coreledger-tech/code-porter/pulls") && init?.method === "POST") {
        nextPrNumber += 1;
        return new Response(
          JSON.stringify({
            html_url: `https://github.com/Coreledger-tech/code-porter/pull/${nextPrNumber}`,
            number: nextPrNumber
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" }
          }
        );
      }

      if (url.includes("api.github.com/repos/Coreledger-tech/code-porter/issues/101/comments")) {
        return new Response(JSON.stringify({ id: 1 }), {
          status: 201,
          headers: { "content-type": "application/json" }
        });
      }

      if (url.includes("api.github.com/repos/Coreledger-tech/code-porter/pulls/101") && init?.method === "PATCH") {
        return new Response(JSON.stringify({ number: 101, state: "closed" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
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
          name: "github-stage10-keeper",
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

      const firstApply = await apiFetch<{ runId: string; status: string }>(
        baseUrl,
        `/campaigns/${campaign.id}/apply`,
        { method: "POST" }
      );
      const firstRun = await waitForRunTerminal<{
        status: string;
        prUrl?: string | null;
        prState?: string | null;
        summary: {
          keeperCandidate?: boolean;
          supersededByPrNumber?: number | null;
          mergeChecklist?: { passed: boolean; reasons: string[] };
        };
      }>({
        baseUrl,
        runId: firstApply.runId
      });

      expect(firstRun.prUrl).toBe("https://github.com/Coreledger-tech/code-porter/pull/101");
      expect(firstRun.summary.mergeChecklist?.passed).toBe(true);

      const secondApply = await apiFetch<{ runId: string; status: string }>(
        baseUrl,
        `/campaigns/${campaign.id}/apply`,
        { method: "POST" }
      );
      const secondRun = await waitForRunTerminal<{
        status: string;
        prUrl?: string | null;
        prState?: string | null;
        summary: {
          keeperCandidate?: boolean;
          supersededByPrNumber?: number | null;
          mergeChecklist?: { passed: boolean; reasons: string[] };
        };
      }>({
        baseUrl,
        runId: secondApply.runId
      });

      const refreshedFirstRun = await apiFetch<{
        prState?: string | null;
        summary: {
          keeperCandidate?: boolean;
          supersededByPrNumber?: number | null;
        };
      }>(baseUrl, `/runs/${firstApply.runId}`);

      expect(secondRun.prUrl).toBe("https://github.com/Coreledger-tech/code-porter/pull/102");
      expect(secondRun.summary.keeperCandidate).toBe(true);
      expect(secondRun.summary.supersededByPrNumber ?? null).toBeNull();
      expect(refreshedFirstRun.prState).toBe("closed");
      expect(refreshedFirstRun.summary.keeperCandidate).toBe(false);
      expect(refreshedFirstRun.summary.supersededByPrNumber).toBe(102);

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/issues/101/comments"),
        expect.objectContaining({ method: "POST" })
      );
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/pulls/101"),
        expect.objectContaining({ method: "PATCH" })
      );
    } finally {
      if (originalAuthMode === undefined) {
        delete process.env.GITHUB_AUTH_MODE;
      } else {
        process.env.GITHUB_AUTH_MODE = originalAuthMode;
      }
      if (originalToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = originalToken;
      }
      vi.unstubAllGlobals();
    }
  });

  it("uses GitHub App auth mode with mocked token exchange and redacts secrets", async () => {
    const remoteRepo = await prepareMavenRepo({ repoName: "code-porter-int-github-app-remote" });
    cleanupPaths.push(remoteRepo);
    const remoteDefaultBranch = await runGitStdout(remoteRepo, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD"
    ]);

    const keyDir = await mkdtemp(join(tmpdir(), "code-porter-int-gh-app-key-"));
    cleanupPaths.push(keyDir);
    const keyPath = join(keyDir, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await writeFile(keyPath, privateKey.export({ type: "pkcs1", format: "pem" }), "utf8");

    const originalAuthMode = process.env.GITHUB_AUTH_MODE;
    const originalToken = process.env.GITHUB_TOKEN;
    const originalAppId = process.env.GITHUB_APP_ID;
    const originalInstallation = process.env.GITHUB_APP_INSTALLATION_ID;
    const originalKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;

    process.env.GITHUB_AUTH_MODE = "app";
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_INSTALLATION_ID = "67890";
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = keyPath;
    delete process.env.GITHUB_TOKEN;

    const realFetch = global.fetch;
    const appToken = "ghs_super_secret_install_token";

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("http://127.0.0.1")) {
        return realFetch(input, init);
      }

      if (url.includes("/app/installations/67890/access_tokens")) {
        return new Response(
          JSON.stringify({
            token: appToken,
            expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" }
          }
        );
      }

      if (url.includes("api.github.com/repos/Coreledger-tech/code-porter/pulls")) {
        return new Response(
          JSON.stringify({
            html_url: "https://github.com/Coreledger-tech/code-porter/pull/456"
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
          name: "github-app-integration",
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

      const applyStart = await apiFetch<{ runId: string; status: string }>(
        baseUrl,
        `/campaigns/${campaign.id}/apply`,
        { method: "POST" }
      );
      expect(applyStart.status).toBe("queued");

      const run = await waitForRunTerminal<{
        id: string;
        status: string;
        queueStatus: string;
        prUrl?: string | null;
        summary: Record<string, unknown>;
      }>({
        baseUrl,
        runId: applyStart.runId
      });

      const events = await apiFetch<{
        events: Array<{ message: string; payload: Record<string, unknown> }>;
      }>(baseUrl, `/runs/${applyStart.runId}/events`);

      expect(run.status).not.toBe("blocked");
      if (typeof run.prUrl === "string") {
        expect(run.prUrl).toBe("https://github.com/Coreledger-tech/code-porter/pull/456");
      }
      expect(fetchMock).toHaveBeenCalled();

      const serializedSummary = JSON.stringify(run.summary);
      const serializedEvents = JSON.stringify(events.events);
      expect(serializedSummary).not.toContain(appToken);
      expect(serializedEvents).not.toContain(appToken);
      expect(serializedSummary).not.toContain("authentication failed");
      expect(serializedEvents).not.toContain("authentication failed");
    } finally {
      if (originalAuthMode === undefined) {
        delete process.env.GITHUB_AUTH_MODE;
      } else {
        process.env.GITHUB_AUTH_MODE = originalAuthMode;
      }

      if (originalToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = originalToken;
      }

      if (originalAppId === undefined) {
        delete process.env.GITHUB_APP_ID;
      } else {
        process.env.GITHUB_APP_ID = originalAppId;
      }

      if (originalInstallation === undefined) {
        delete process.env.GITHUB_APP_INSTALLATION_ID;
      } else {
        process.env.GITHUB_APP_INSTALLATION_ID = originalInstallation;
      }

      if (originalKeyPath === undefined) {
        delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
      } else {
        process.env.GITHUB_APP_PRIVATE_KEY_PATH = originalKeyPath;
      }

      vi.unstubAllGlobals();
    }
  });

  it("polls PR lifecycle state and persists merged metadata", async () => {
    const remoteRepo = await prepareMavenRepo({ repoName: "code-porter-int-pr-poller-remote" });
    cleanupPaths.push(remoteRepo);
    const remoteDefaultBranch = await runGitStdout(remoteRepo, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD"
    ]);

    const originalAuthMode = process.env.GITHUB_AUTH_MODE;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_AUTH_MODE = "pat";
    process.env.GITHUB_TOKEN = "integration-token";
    const realFetch = global.fetch;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.startsWith("http://127.0.0.1")) {
        return realFetch(input, init);
      }

      if (url.includes("api.github.com/repos/Coreledger-tech/code-porter/pulls") && method === "POST") {
        return new Response(
          JSON.stringify({
            html_url: "https://github.com/Coreledger-tech/code-porter/pull/789",
            number: 789
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" }
          }
        );
      }

      if (url.includes("api.github.com/repos/Coreledger-tech/code-porter/pulls/789")) {
        return new Response(
          JSON.stringify({
            number: 789,
            state: "closed",
            merged_at: "2026-02-26T00:10:00.000Z",
            closed_at: "2026-02-26T00:10:00.000Z",
            created_at: "2026-02-25T00:00:00.000Z"
          }),
          {
            status: 200,
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
          name: "github-pr-poller-integration",
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

      const applyStart = await apiFetch<{ runId: string; status: string }>(
        baseUrl,
        `/campaigns/${campaign.id}/apply`,
        { method: "POST" }
      );
      expect(applyStart.status).toBe("queued");

      await waitForRunTerminal({
        baseUrl,
        runId: applyStart.runId
      });

      // PR creation is covered by a separate integration test. Seed the run with an
      // open PR so this test stays focused on lifecycle polling and persistence.
      await queryDb(
        `update runs
         set pr_url = $2,
             pr_number = $3,
             pr_state = 'open',
             pr_opened_at = $4::timestamptz,
             summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object(
               'prUrl', $2::text,
               'prNumber', $3::int,
               'prState', 'open'
             )
         where id = $1`,
        [
          applyStart.runId,
          "https://github.com/Coreledger-tech/code-porter/pull/789",
          789,
          "2026-02-25T00:00:00.000Z"
        ]
      );

      const prePollRun = await apiFetch<{
        id: string;
        prUrl: string | null;
        prNumber: number | null;
        prState: string | null;
      }>(baseUrl, `/runs/${applyStart.runId}`);

      expect(prePollRun?.prUrl).toBe("https://github.com/Coreledger-tech/code-porter/pull/789");
      expect(prePollRun?.prNumber).toBe(789);
      expect(prePollRun?.prState).toBe("open");

      const poller = new PrLifecyclePollerWorker({
        batchSize: 10,
        timeoutMs: 2_000
      });
      const updated = await poller.pollOnce();
      expect(updated).toBeGreaterThan(0);

      const run = await apiFetch<{
        id: string;
        prUrl: string | null;
        prNumber: number | null;
        prState: string | null;
        mergedAt: string | null;
      }>(baseUrl, `/runs/${applyStart.runId}`);

      expect(run.prUrl).toBe("https://github.com/Coreledger-tech/code-porter/pull/789");
      expect(run.prNumber).toBe(789);
      expect(run.prState).toBe("merged");
      expect(run.mergedAt).toBeTruthy();

      const campaignSummary = await apiFetch<{
        recentRuns: Array<{ runId: string; mergeState: string; prState: string | null }>;
      }>(baseUrl, `/campaigns/${campaign.id}/summary`);

      const recent = campaignSummary.recentRuns.find((item) => item.runId === applyStart.runId);
      expect(recent).toBeTruthy();
      expect(recent?.mergeState).toBe("merged");
      expect(recent?.prState).toBe("merged");
    } finally {
      if (originalAuthMode === undefined) {
        delete process.env.GITHUB_AUTH_MODE;
      } else {
        process.env.GITHUB_AUTH_MODE = originalAuthMode;
      }
      if (originalToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = originalToken;
      }
      vi.unstubAllGlobals();
    }
  });

  it("returns pilot report aggregates with offender ranking", async () => {
    const repoPath = await prepareMavenRepo({ repoName: "code-porter-int-report" });
    cleanupPaths.push(repoPath);

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-report-project",
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

    const runIds = Array.from({ length: 5 }, () => randomUUID());

    await queryDb(
      `insert into runs (
         id, campaign_id, mode, status, confidence_score, evidence_path, branch_name, pr_url,
         pr_number, pr_state, pr_opened_at, merged_at, closed_at, summary, started_at, finished_at
       ) values
       ($1, $6, 'apply', 'completed', 80, null, null, 'https://github.com/acme/demo/pull/1',
         1, 'merged', now() - interval '48 hours', now() - interval '24 hours', now() - interval '24 hours',
         '{}'::jsonb, now() - interval '49 hours', now() - interval '23 hours'),
       ($2, $6, 'apply', 'blocked', null, null, null, 'https://github.com/acme/demo/pull/2',
         2, 'closed', now() - interval '50 hours', null, now() - interval '20 hours',
         '{\"failureKind\":\"artifact_resolution\"}'::jsonb, now() - interval '51 hours', now() - interval '19 hours'),
       ($3, $6, 'apply', 'blocked', null, null, null, null,
         null, null, null, null, null,
         '{\"failureKind\":\"artifact_resolution\"}'::jsonb, now() - interval '30 hours', now() - interval '29 hours'),
       ($4, $6, 'apply', 'needs_review', 65, null, null, 'https://github.com/acme/demo/pull/3',
         3, 'open', now() - interval '5 hours', null, null,
         '{\"failureKind\":\"code_failure\"}'::jsonb, now() - interval '6 hours', now() - interval '4 hours'),
       ($5, $6, 'apply', 'completed', 90, null, null, null,
         null, null, null, null, null,
         '{}'::jsonb, now() - interval '10 hours', now() - interval '9 hours')`,
      [runIds[0], runIds[1], runIds[2], runIds[3], runIds[4], campaign.id]
    );

    await queryDb(
      `insert into run_jobs (
         run_id, campaign_id, mode, status, attempt_count, attempts, max_attempts,
         next_attempt_at, available_at, created_at, updated_at
       ) values
       ($1, $6, 'apply', 'completed', 1, 1, 3, now(), now(), now(), now()),
       ($2, $6, 'apply', 'completed', 2, 2, 3, now(), now(), now(), now()),
       ($3, $6, 'apply', 'completed', 1, 1, 3, now(), now(), now(), now()),
       ($4, $6, 'apply', 'completed', 2, 2, 3, now(), now(), now(), now()),
       ($5, $6, 'apply', 'completed', 1, 1, 3, now(), now(), now(), now())`,
      [runIds[0], runIds[1], runIds[2], runIds[3], runIds[4], campaign.id]
    );

    const report = await apiFetch<{
      window: string;
      cohort: string;
      cohortCounts: {
        totalApplyRuns: number;
        cohortApplyRuns: number;
        excludedApplyRuns: number;
      };
      totalsByStatus: Record<string, number>;
      prOutcomes: { opened: number; merged: number; mergeRate: number };
      retryRate: { retriedRuns: number; totalRuns: number; rate: number };
      worstOffendersByProject: Array<{
        projectId: string;
        blockedRate: number;
        topFailureKind: string;
      }>;
    }>(baseUrl, "/reports/pilot?window=30d");

    expect(report.window).toBe("30d");
    expect(report.cohort).toBe("all");
    expect(report.cohortCounts).toEqual({
      totalApplyRuns: 5,
      cohortApplyRuns: 5,
      excludedApplyRuns: 0
    });
    expect(report.totalsByStatus.completed).toBe(2);
    expect(report.totalsByStatus.blocked).toBe(2);
    expect(report.prOutcomes.opened).toBe(3);
    expect(report.prOutcomes.merged).toBe(1);
    expect(report.prOutcomes.mergeRate).toBeCloseTo(1 / 3);
    expect(report.retryRate.retriedRuns).toBe(2);
    expect(report.retryRate.totalRuns).toBe(5);
    expect(report.retryRate.rate).toBeCloseTo(0.4);
    expect(report.worstOffendersByProject.length).toBe(1);
    expect(report.worstOffendersByProject[0]).toMatchObject({
      projectId: project.id,
      topFailureKind: "artifact_resolution"
    });

    const actionable = await apiFetch<{
      cohort: string;
      cohortCounts: {
        totalApplyRuns: number;
        cohortApplyRuns: number;
        excludedApplyRuns: number;
      };
      topFailureKinds: Array<{ failureKind: string; count: number }>;
    }>(baseUrl, "/reports/pilot?window=30d&cohort=actionable_maven");
    expect(actionable.cohort).toBe("actionable_maven");
    expect(actionable.cohortCounts).toEqual({
      totalApplyRuns: 5,
      cohortApplyRuns: 0,
      excludedApplyRuns: 5
    });
    expect(actionable.topFailureKinds).toEqual([]);

    const coverage = await apiFetch<{
      cohort: string;
      cohortCounts: {
        totalApplyRuns: number;
        cohortApplyRuns: number;
        excludedApplyRuns: number;
      };
      topFailureKinds: Array<{ failureKind: string; count: number }>;
    }>(baseUrl, "/reports/pilot?window=30d&cohort=coverage");
    expect(coverage.cohort).toBe("coverage");
    expect(coverage.cohortCounts).toEqual({
      totalApplyRuns: 5,
      cohortApplyRuns: 5,
      excludedApplyRuns: 0
    });
    expect(coverage.topFailureKinds.length).toBeGreaterThan(0);

    const invalid = await apiFetchRaw(baseUrl, "/reports/pilot?window=90d");
    expect(invalid.status).toBe(400);

    const invalidCohort = await apiFetchRaw(baseUrl, "/reports/pilot?window=30d&cohort=bad");
    expect(invalidCohort.status).toBe(400);
  });

  it("executes a queued run only once when two workers are active", async () => {
    const repoPath = await prepareMavenRepo({ repoName: "code-porter-int-two-workers" });
    cleanupPaths.push(repoPath);

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-two-workers",
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

    const secondWorker = new AsyncRunWorker({
      workerId: "integration-worker-2",
      pollMs: 50,
      concurrency: 1
    });
    const secondWorkerPromise = secondWorker.start();

    try {
      const applyStart = await apiFetch<{ runId: string; status: string }>(
        baseUrl,
        `/campaigns/${campaign.id}/apply`,
        { method: "POST" }
      );
      expect(applyStart.status).toBe("queued");

      await waitForRunTerminal({
        baseUrl,
        runId: applyStart.runId
      });

      const events = await apiFetch<{
        events: Array<{ eventType: string; message: string }>;
      }>(baseUrl, `/runs/${applyStart.runId}/events?limit=500`);

      const workerStartEvents = events.events.filter((event) =>
        event.eventType === "lifecycle" && event.message === "Worker started run execution"
      );
      expect(workerStartEvents).toHaveLength(1);
    } finally {
      secondWorker.stop();
      await Promise.race([
        secondWorkerPromise,
        sleep(5000)
      ]);
    }
  });

  it("reclaims an expired lease and completes the run on a retry claim", async () => {
    const repoPath = await prepareMavenRepo({ repoName: "code-porter-int-lease-reclaim" });
    cleanupPaths.push(repoPath);

    worker.stop();
    await Promise.race([
      workerPromise,
      sleep(5000)
    ]);

    const project = await apiFetch<{ id: string }>(baseUrl, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "integration-lease-reclaim",
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

    const applyStart = await apiFetch<{ runId: string; status: string }>(
      baseUrl,
      `/campaigns/${campaign.id}/apply`,
      { method: "POST" }
    );
    expect(applyStart.status).toBe("queued");

    await queryDb(
      `update run_jobs
       set status = 'running',
           attempt_count = 1,
           attempts = 1,
           lease_owner = 'stale-worker',
           leased_at = now() - make_interval(secs => 600),
           lease_expires_at = now() - make_interval(secs => 60),
           locked_by = 'stale-worker',
           locked_at = now() - make_interval(secs => 600),
           next_attempt_at = now() - make_interval(secs => 60),
           available_at = now() - make_interval(secs => 60)
       where run_id = $1`,
      [applyStart.runId]
    );
    await queryDb(
      `update runs
       set status = 'running'
       where id = $1`,
      [applyStart.runId]
    );

    const reclaimWorker = new AsyncRunWorker({
      workerId: "integration-reclaim-worker",
      pollMs: 50,
      concurrency: 1
    });
    const reclaimWorkerPromise = reclaimWorker.start();

    try {
      await waitForRunTerminal({
        baseUrl,
        runId: applyStart.runId
      });
    } finally {
      reclaimWorker.stop();
      await Promise.race([
        reclaimWorkerPromise,
        sleep(5000)
      ]);
    }

    const attempts = await queryDb<{ attempt_count: number }>(
      `select attempt_count
       from run_jobs
       where run_id = $1`,
      [applyStart.runId]
    );
    expect(Number(attempts.rows[0]?.attempt_count ?? 0)).toBeGreaterThanOrEqual(2);

    const metricsResponse = await apiFetchRaw(baseUrl, "/metrics");
    const metricsText = await metricsResponse.text();
    const reclaimMetric = metricsText.match(
      /^codeporter_queue_lease_reclaims_total\s+([0-9.]+)$/m
    );
    expect(reclaimMetric).toBeTruthy();
    expect(Number(reclaimMetric?.[1] ?? 0)).toBeGreaterThan(0);
  });
});
