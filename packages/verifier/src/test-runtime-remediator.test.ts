import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { PolicyConfig, VerifySummary } from "@code-porter/core/src/models.js";
import { MavenTestRuntimeDeterministicRemediator } from "./test-runtime-remediator.js";

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
  defaultRecipePack: "java-maven-test-compat-v2-pack",
  allowedBuildSystems: ["maven", "gradle"],
  verifyFailureMode: "warn",
  verify: {
    blockingFailureKinds: [
      "code_compile_failure",
      "code_test_failure",
      "java17_plugin_incompat",
      "java17_module_access_test_failure"
    ],
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
    mavenTestRuntime: {
      enabled: true,
      maxIterations: 1,
      maxFilesChangedPerIteration: 2,
      maxLinesChangedPerIteration: 20,
      maxFilesChangedTotal: 2,
      maxLinesChangedTotal: 30,
      allowedFixes: ["ensure_add_opens_sun_nio_ch", "ensure_add_opens_java_nio"]
    }
  },
  confidenceThresholds: {
    pass: 70,
    needsReview: 55
  }
};

const moduleAccessFailure: VerifySummary = {
  buildSystem: "maven",
  hasTests: true,
  compile: {
    status: "passed"
  },
  tests: {
    status: "failed",
    failureKind: "java17_module_access_test_failure",
    output:
      "java.lang.IllegalAccessError: class org.apache.lucene.store.MMapDirectory cannot access class sun.nio.ch.FileChannelImpl"
  },
  staticChecks: {
    status: "passed"
  }
};

const chronicleModuleAccessFailure: VerifySummary = {
  buildSystem: "maven",
  hasTests: true,
  compile: {
    status: "passed"
  },
  tests: {
    status: "failed",
    failureKind: "java17_module_access_test_failure",
    output:
      "java.lang.NoSuchFieldException: address at net.openhft.chronicle.bytes.internal.NativeBytesStore"
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
  const repoPath = await mkdtemp(join(tmpdir(), "code-porter-runtime-remediator-"));
  await mkdir(join(repoPath, "src", "test", "java"), { recursive: true });
  await writeFile(join(repoPath, "pom.xml"), pom, "utf8");
  await writeFile(join(repoPath, "src", "test", "java", "SampleTest.java"), "class SampleTest {}\n", "utf8");
  await initGitRepo(repoPath);
  return repoPath;
}

describe("MavenTestRuntimeDeterministicRemediator", () => {
  it("adds minimal add-opens argLine to existing surefire and failsafe plugins", async () => {
    const pom = [
      "<project>",
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
      "        <configuration>",
      "          <argLine>-Xmx512m</argLine>",
      "        </configuration>",
      "      </plugin>",
      "    </plugins>",
      "  </build>",
      "</project>"
    ].join("\n");

    const repoPath = await createRepo(pom);
    const verifier = {
      run: vi.fn().mockResolvedValue({
        ...moduleAccessFailure,
        tests: {
          status: "passed"
        }
      })
    };

    const result = await new MavenTestRuntimeDeterministicRemediator().run({
      scan: {
        buildSystem: "maven",
        hasTests: true,
        metadata: {
          gitBranch: "main",
          toolAvailability: { mvn: true, gradle: false, npm: false, node: true },
          detectedFiles: ["pom.xml"]
        }
      },
      verify: moduleAccessFailure,
      repoPath,
      policy: basePolicy,
      verifier: verifier as any
    });

    const updatedPom = await readFile(join(repoPath, "pom.xml"), "utf8");
    expect(updatedPom).toContain("<artifactId>maven-surefire-plugin</artifactId>");
    expect(updatedPom).toContain("<artifactId>maven-failsafe-plugin</artifactId>");
    expect(updatedPom).toContain(
      "<argLine>-Xmx512m --add-opens=java.base/sun.nio.ch=ALL-UNNAMED</argLine>"
    );
    expect(updatedPom).toContain(
      "<argLine>--add-opens=java.base/sun.nio.ch=ALL-UNNAMED</argLine>"
    );
    expect(result.summary?.rulesApplied).toContain("ensure_add_opens_sun_nio_ch");
    expect(result.artifacts?.some((artifact) => artifact.type === "remediation-test-runtime.json")).toBe(
      true
    );
  });

  it("is idempotent when add-opens is already present", async () => {
    const pom = [
      "<project>",
      "  <build>",
      "    <plugins>",
      "      <plugin>",
      "        <artifactId>maven-surefire-plugin</artifactId>",
      "        <configuration>",
      "          <argLine>--add-opens=java.base/sun.nio.ch=ALL-UNNAMED</argLine>",
      "        </configuration>",
      "      </plugin>",
      "    </plugins>",
      "  </build>",
      "</project>"
    ].join("\n");
    const repoPath = await createRepo(pom);
    const verifier = { run: vi.fn() };

    const result = await new MavenTestRuntimeDeterministicRemediator().run({
      scan: {
        buildSystem: "maven",
        hasTests: true,
        metadata: {
          gitBranch: "main",
          toolAvailability: { mvn: true, gradle: false, npm: false, node: true },
          detectedFiles: ["pom.xml"]
        }
      },
      verify: moduleAccessFailure,
      repoPath,
      policy: basePolicy,
      verifier: verifier as any
    });

    expect(result.applied).toBe(false);
    expect(result.actions.some((action) => action.status === "skipped")).toBe(true);
    expect(verifier.run).not.toHaveBeenCalled();
  });

  it("does not apply when surefire/failsafe plugins are absent", async () => {
    const repoPath = await createRepo("<project></project>");
    const verifier = { run: vi.fn() };

    const result = await new MavenTestRuntimeDeterministicRemediator().run({
      scan: {
        buildSystem: "maven",
        hasTests: true,
        metadata: {
          gitBranch: "main",
          toolAvailability: { mvn: true, gradle: false, npm: false, node: true },
          detectedFiles: ["pom.xml"]
        }
      },
      verify: moduleAccessFailure,
      repoPath,
      policy: basePolicy,
      verifier: verifier as any
    });

    expect(result.applied).toBe(false);
    expect(result.actions.some((action) => action.status === "skipped")).toBe(true);
    expect(verifier.run).not.toHaveBeenCalled();
  });

  it("adds java.nio open for Chronicle reflective-access signatures", async () => {
    const pom = [
      "<project>",
      "  <build>",
      "    <plugins>",
      "      <plugin>",
      "        <groupId>org.apache.maven.plugins</groupId>",
      "        <artifactId>maven-surefire-plugin</artifactId>",
      "        <version>3.2.5</version>",
      "      </plugin>",
      "    </plugins>",
      "  </build>",
      "</project>"
    ].join("\n");

    const repoPath = await createRepo(pom);
    const verifier = {
      run: vi.fn().mockResolvedValue({
        ...chronicleModuleAccessFailure,
        tests: {
          status: "passed"
        }
      })
    };

    const result = await new MavenTestRuntimeDeterministicRemediator().run({
      scan: {
        buildSystem: "maven",
        hasTests: true,
        metadata: {
          gitBranch: "main",
          toolAvailability: { mvn: true, gradle: false, npm: false, node: true },
          detectedFiles: ["pom.xml"]
        }
      },
      verify: chronicleModuleAccessFailure,
      repoPath,
      policy: basePolicy,
      verifier: verifier as any
    });

    const updatedPom = await readFile(join(repoPath, "pom.xml"), "utf8");
    expect(updatedPom).toContain(
      "<argLine>--add-opens=java.base/java.nio=ALL-UNNAMED</argLine>"
    );
    expect(result.summary?.rulesApplied).toContain("ensure_add_opens_java_nio");
    expect(result.summary?.rulesApplied).not.toContain("ensure_add_opens_sun_nio_ch");
  });

  it("does not rewrite commented argLine content while adding active configuration", async () => {
    const pom = [
      "<project>",
      "  <build>",
      "    <plugins>",
      "      <plugin>",
      "        <groupId>org.apache.maven.plugins</groupId>",
      "        <artifactId>maven-surefire-plugin</artifactId>",
      "        <version>3.2.5</version>",
      "        <configuration combine.self=\"override\">",
      "          <!--<argLine>-XX:+PrintApplicationStoppedTime</argLine>-->",
      "          <redirectTestOutputToFile>true</redirectTestOutputToFile>",
      "        </configuration>",
      "      </plugin>",
      "    </plugins>",
      "  </build>",
      "</project>"
    ].join("\n");

    const repoPath = await createRepo(pom);
    const verifier = {
      run: vi.fn().mockResolvedValue({
        ...moduleAccessFailure,
        tests: {
          status: "passed"
        }
      })
    };

    const result = await new MavenTestRuntimeDeterministicRemediator().run({
      scan: {
        buildSystem: "maven",
        hasTests: true,
        metadata: {
          gitBranch: "main",
          toolAvailability: { mvn: true, gradle: false, npm: false, node: true },
          detectedFiles: ["pom.xml"]
        }
      },
      verify: moduleAccessFailure,
      repoPath,
      policy: basePolicy,
      verifier: verifier as any
    });

    const updatedPom = await readFile(join(repoPath, "pom.xml"), "utf8");
    const configurationCount = (updatedPom.match(/<configuration\b/gi) ?? []).length;
    expect(updatedPom).toContain("<!--<argLine>-XX:+PrintApplicationStoppedTime</argLine>-->");
    expect(updatedPom).toContain("<argLine>--add-opens=java.base/sun.nio.ch=ALL-UNNAMED</argLine>");
    expect(updatedPom).not.toContain(
      "<!--<argLine>-XX:+PrintApplicationStoppedTime --add-opens=java.base/sun.nio.ch=ALL-UNNAMED</argLine>-->"
    );
    expect(configurationCount).toBe(1);
    expect(result.summary?.rulesApplied).toContain("ensure_add_opens_sun_nio_ch");
  });
});
