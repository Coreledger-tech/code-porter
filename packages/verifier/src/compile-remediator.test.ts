import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { PolicyConfig, VerifySummary } from "@code-porter/core/src/models.js";
import { MavenCompileDeterministicRemediator } from "./compile-remediator.js";

const execFileAsync = promisify(execFile);

const basePolicy: PolicyConfig = {
  maxChangeLines: 300,
  maxFilesChanged: 10,
  requireTestsIfPresent: true,
  maxInflightRunsPerProject: 2,
  maxInflightRunsGlobal: 10,
  maxVerifyMinutesPerRun: 20,
  maxVerifyRetries: 2,
  maxEvidenceZipBytes: 52428800,
  defaultRecipePack: "java-maven-plugin-modernize",
  allowedBuildSystems: ["maven", "gradle"],
  verifyFailureMode: "warn",
  verify: {
    blockingFailureKinds: ["code_compile_failure", "code_test_failure", "java17_plugin_incompat"],
    nonBlockingFailureKinds: [
      "tool_missing",
      "artifact_resolution",
      "repo_unreachable",
      "budget_exceeded"
    ],
    retryOnCachedResolution: true,
    maven: {
      forceUpdate: true,
      prefetchPlugins: true,
      purgeLocalCache: false
    }
  },
  remediation: {
    mavenCompile: {
      enabled: true,
      maxIterations: 2,
      maxFilesChangedPerIteration: 1,
      maxLinesChangedPerIteration: 25,
      maxFilesChangedTotal: 2,
      maxLinesChangedTotal: 40,
      allowedFixes: [
        "ensure_maven_compiler_plugin_for_lombok",
        "ensure_lombok_annotation_processor_path",
        "remove_proc_none"
      ]
    }
  },
  confidenceThresholds: {
    pass: 70,
    needsReview: 55
  }
};

const compileFailure: VerifySummary = {
  buildSystem: "maven",
  hasTests: false,
  compile: {
    status: "failed",
    failureKind: "code_compile_failure",
    output: "[ERROR] cannot find symbol\n[ERROR]   symbol:   method builder()\n[ERROR]   symbol:   variable log"
  },
  tests: {
    status: "not_run",
    reason: "compile failed first"
  },
  staticChecks: {
    status: "passed"
  }
};

async function initGitRepo(repoPath: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "tests@codeporter.local"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "Code Porter Tests"], { cwd: repoPath });
  await execFileAsync("git", ["add", "."], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: repoPath });
}

async function createRepo(pom: string): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "code-porter-compile-remediator-"));
  await mkdir(join(repoPath, "src", "main", "java"), { recursive: true });
  await writeFile(join(repoPath, "pom.xml"), pom, "utf8");
  await writeFile(join(repoPath, "src", "main", "java", "App.java"), "class App {}\n", "utf8");
  await initGitRepo(repoPath);
  return repoPath;
}

describe("MavenCompileDeterministicRemediator", () => {
  it("inserts maven-compiler-plugin with Lombok processor path when absent", async () => {
    const pom = [
      "<project>",
      "  <properties><lombok.version>1.18.30</lombok.version></properties>",
      "  <dependencies>",
      "    <dependency>",
      "      <groupId>org.projectlombok</groupId>",
      "      <artifactId>lombok</artifactId>",
      "      <version>${lombok.version}</version>",
      "    </dependency>",
      "  </dependencies>",
      "  <build><plugins></plugins></build>",
      "</project>"
    ].join("\n");
    const repoPath = await createRepo(pom);
    const verifier = {
      run: vi.fn().mockResolvedValue({
        ...compileFailure,
        compile: { status: "passed" }
      })
    };

    const result = await new MavenCompileDeterministicRemediator().run({
      scan: {
        buildSystem: "maven",
        hasTests: false,
        metadata: {
          gitBranch: "main",
          toolAvailability: { mvn: true, gradle: false, npm: false, node: true },
          detectedFiles: ["pom.xml"]
        }
      },
      verify: compileFailure,
      repoPath,
      policy: basePolicy,
      verifier: verifier as any
    });

    const updatedPom = await readFile(join(repoPath, "pom.xml"), "utf8");
    expect(updatedPom).toContain("<artifactId>maven-compiler-plugin</artifactId>");
    expect(updatedPom).toContain("<annotationProcessorPaths>");
    expect(updatedPom).toContain("<version>1.18.30</version>");
    expect(result.summary?.rulesApplied).toContain("ensure_maven_compiler_plugin_for_lombok");
    expect(result.artifacts?.some((artifact) => artifact.type === "remediation.json")).toBe(true);
  });

  it("adds Lombok annotationProcessorPaths when compiler plugin exists without them", async () => {
    const pom = [
      "<project>",
      "  <properties><lombok.version>1.18.30</lombok.version></properties>",
      "  <dependencies>",
      "    <dependency>",
      "      <groupId>org.projectlombok</groupId>",
      "      <artifactId>lombok</artifactId>",
      "      <version>${lombok.version}</version>",
      "    </dependency>",
      "  </dependencies>",
      "  <build>",
      "    <plugins>",
      "      <plugin>",
      "        <groupId>org.apache.maven.plugins</groupId>",
      "        <artifactId>maven-compiler-plugin</artifactId>",
      "        <version>3.11.0</version>",
      "      </plugin>",
      "    </plugins>",
      "  </build>",
      "</project>"
    ].join("\n");
    const repoPath = await createRepo(pom);
    const verifier = {
      run: vi.fn().mockResolvedValue({
        ...compileFailure,
        compile: { status: "passed" }
      })
    };

    await new MavenCompileDeterministicRemediator().run({
      scan: {
        buildSystem: "maven",
        hasTests: false,
        metadata: {
          gitBranch: "main",
          toolAvailability: { mvn: true, gradle: false, npm: false, node: true },
          detectedFiles: ["pom.xml"]
        }
      },
      verify: compileFailure,
      repoPath,
      policy: basePolicy,
      verifier: verifier as any
    });

    const updatedPom = await readFile(join(repoPath, "pom.xml"), "utf8");
    expect(updatedPom).toContain("<annotationProcessorPaths>");
    expect(updatedPom).toContain("<artifactId>lombok</artifactId>");
  });

  it("removes proc:none and -proc:none compiler settings", async () => {
    const pom = [
      "<project>",
      "  <properties><lombok.version>1.18.30</lombok.version></properties>",
      "  <dependencies>",
      "    <dependency>",
      "      <groupId>org.projectlombok</groupId>",
      "      <artifactId>lombok</artifactId>",
      "      <version>${lombok.version}</version>",
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
      "          <compilerArgs>",
      "            <arg>-proc:none</arg>",
      "          </compilerArgs>",
      "          <annotationProcessorPaths>",
      "            <path>",
      "              <groupId>org.projectlombok</groupId>",
      "              <artifactId>lombok</artifactId>",
      "              <version>${lombok.version}</version>",
      "            </path>",
      "          </annotationProcessorPaths>",
      "        </configuration>",
      "      </plugin>",
      "    </plugins>",
      "  </build>",
      "</project>"
    ].join("\n");
    const repoPath = await createRepo(pom);
    const verifier = {
      run: vi.fn().mockResolvedValue({
        ...compileFailure,
        compile: { status: "passed" }
      })
    };

    const result = await new MavenCompileDeterministicRemediator().run({
      scan: {
        buildSystem: "maven",
        hasTests: false,
        metadata: {
          gitBranch: "main",
          toolAvailability: { mvn: true, gradle: false, npm: false, node: true },
          detectedFiles: ["pom.xml"]
        }
      },
      verify: compileFailure,
      repoPath,
      policy: {
        ...basePolicy,
        remediation: {
          mavenCompile: {
            ...basePolicy.remediation!.mavenCompile!,
            allowedFixes: ["remove_proc_none"]
          }
        }
      },
      verifier: verifier as any
    });

    const updatedPom = await readFile(join(repoPath, "pom.xml"), "utf8");
    expect(updatedPom).not.toContain("<proc>none</proc>");
    expect(updatedPom).not.toContain("<arg>-proc:none</arg>");
    expect(result.summary?.rulesApplied).toContain("remove_proc_none");
  });

  it("does not patch when Lombok version cannot be resolved", async () => {
    const pom = [
      "<project>",
      "  <dependencies>",
      "    <dependency>",
      "      <groupId>org.projectlombok</groupId>",
      "      <artifactId>lombok</artifactId>",
      "    </dependency>",
      "  </dependencies>",
      "  <build><plugins></plugins></build>",
      "</project>"
    ].join("\n");
    const repoPath = await createRepo(pom);
    const verifier = { run: vi.fn() };

    const result = await new MavenCompileDeterministicRemediator().run({
      scan: {
        buildSystem: "maven",
        hasTests: false,
        metadata: {
          gitBranch: "main",
          toolAvailability: { mvn: true, gradle: false, npm: false, node: true },
          detectedFiles: ["pom.xml"]
        }
      },
      verify: compileFailure,
      repoPath,
      policy: basePolicy,
      verifier: verifier as any
    });

    expect(result.applied).toBe(false);
    expect(result.actions.some((action) => action.status === "skipped")).toBe(true);
  });

  it("stops when a patch would exceed iteration limits", async () => {
    const pom = [
      "<project>",
      "  <properties><lombok.version>1.18.30</lombok.version></properties>",
      "  <dependencies>",
      "    <dependency>",
      "      <groupId>org.projectlombok</groupId>",
      "      <artifactId>lombok</artifactId>",
      "      <version>${lombok.version}</version>",
      "    </dependency>",
      "  </dependencies>",
      "  <build><plugins></plugins></build>",
      "</project>"
    ].join("\n");
    const repoPath = await createRepo(pom);
    const verifier = { run: vi.fn() };

    const result = await new MavenCompileDeterministicRemediator().run({
      scan: {
        buildSystem: "maven",
        hasTests: false,
        metadata: {
          gitBranch: "main",
          toolAvailability: { mvn: true, gradle: false, npm: false, node: true },
          detectedFiles: ["pom.xml"]
        }
      },
      verify: compileFailure,
      repoPath,
      policy: {
        ...basePolicy,
        remediation: {
          mavenCompile: {
            ...basePolicy.remediation!.mavenCompile!,
            maxLinesChangedPerIteration: 1
          }
        }
      },
      verifier: verifier as any
    });

    const updatedPom = await readFile(join(repoPath, "pom.xml"), "utf8");
    expect(updatedPom).toBe(pom);
    expect(result.applied).toBe(false);
    expect(result.actions.some((action) => action.status === "failed")).toBe(true);
  });
});
