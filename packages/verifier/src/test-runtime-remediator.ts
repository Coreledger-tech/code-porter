import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  PolicyConfig,
  ScanResult,
  VerifySummary
} from "@code-porter/core/src/models.js";
import type {
  DeterministicRemediator,
  RemediationAction,
  RemediationArtifact,
  RemediationResult,
  VerifierPort
} from "@code-porter/core/src/workflow-runner.js";

const execFileAsync = promisify(execFile);
const JAVA17_OPEN = "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED";
const TARGET_PLUGINS = ["maven-surefire-plugin", "maven-failsafe-plugin"] as const;

type AllowedFix =
  NonNullable<
    NonNullable<PolicyConfig["remediation"]>["mavenTestRuntime"]
  >["allowedFixes"][number];

type RemediationIteration = {
  iteration: number;
  ruleId: AllowedFix;
  filesChanged: number;
  linesChanged: number;
  triggerFailureKind: "java17_module_access_test_failure";
  verifyAfter: {
    testsStatus: VerifySummary["tests"]["status"];
    testsFailureKind: VerifySummary["tests"]["failureKind"];
  };
};

type FixCandidate = {
  ruleId: AllowedFix;
  updatedPom: string;
  touchedPlugins: string[];
  description: string;
};

function findPluginBlocks(content: string): string[] {
  return content.match(/<plugin>[\s\S]*?<\/plugin>/g) ?? [];
}

function pluginArtifactId(pluginBlock: string): string | null {
  const match = pluginBlock.match(/<artifactId>\s*([^<]+)\s*<\/artifactId>/i);
  return match?.[1]?.trim() ?? null;
}

function updatePluginArgLine(pluginBlock: string): {
  changed: boolean;
  updated: string;
} {
  if (/<argLine>[\s\S]*?<\/argLine>/i.test(pluginBlock)) {
    const updated = pluginBlock.replace(
      /<argLine>([\s\S]*?)<\/argLine>/i,
      (match, content: string) => {
        if (content.includes(JAVA17_OPEN)) {
          return match;
        }
        const trimmed = content.trim();
        const next = trimmed.length > 0 ? `${trimmed} ${JAVA17_OPEN}` : JAVA17_OPEN;
        return `<argLine>${next}</argLine>`;
      }
    );
    return { changed: updated !== pluginBlock, updated };
  }

  const pluginIndent = pluginBlock.match(/^(\s*)<plugin>/m)?.[1] ?? "      ";
  const configurationIndent = `${pluginIndent}  `;
  const argLineIndent = `${configurationIndent}  `;

  if (/<configuration>[\s\S]*?<\/configuration>/i.test(pluginBlock)) {
    const updated = pluginBlock.replace(
      /<\/configuration>/i,
      `${argLineIndent}<argLine>${JAVA17_OPEN}</argLine>\n${configurationIndent}</configuration>`
    );
    return { changed: updated !== pluginBlock, updated };
  }

  const configurationBlock = [
    `${configurationIndent}<configuration>`,
    `${argLineIndent}<argLine>${JAVA17_OPEN}</argLine>`,
    `${configurationIndent}</configuration>`
  ].join("\n");
  const updated = pluginBlock.replace(
    /<\/plugin>/i,
    `${configurationBlock}\n${pluginIndent}</plugin>`
  );
  return { changed: updated !== pluginBlock, updated };
}

function ensureModuleAccessOpenInPom(pom: string): FixCandidate | null {
  const blocks = findPluginBlocks(pom);
  if (blocks.length === 0) {
    return null;
  }

  let updatedPom = pom;
  const touchedPlugins: string[] = [];
  for (const block of blocks) {
    const artifactId = pluginArtifactId(block);
    if (!artifactId || !TARGET_PLUGINS.includes(artifactId as (typeof TARGET_PLUGINS)[number])) {
      continue;
    }

    const updatedBlock = updatePluginArgLine(block);
    if (!updatedBlock.changed) {
      continue;
    }

    updatedPom = updatedPom.replace(block, updatedBlock.updated);
    touchedPlugins.push(artifactId);
  }

  if (updatedPom === pom) {
    return null;
  }

  return {
    ruleId: "ensure_add_opens_sun_nio_ch",
    updatedPom,
    touchedPlugins,
    description: `Added minimal Java 17 module-open argLine for ${touchedPlugins.join(", ")}`
  };
}

function countPatchChangedLines(patch: string): number {
  return patch
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") || line.startsWith("-")) &&
        !line.startsWith("+++") &&
        !line.startsWith("---")
    ).length;
}

async function buildPatch(before: string, after: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "code-porter-runtime-remediation-"));
  const beforePath = join(tempDir, "before.xml");
  const afterPath = join(tempDir, "after.xml");
  await writeFile(beforePath, before, "utf8");
  await writeFile(afterPath, after, "utf8");

  try {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "--no-index", "--no-color", "--unified=3", "--", beforePath, afterPath],
        { maxBuffer: 8 * 1024 * 1024 }
      );
      return stdout;
    } catch (error) {
      const typed = error as { code?: number; stdout?: string };
      if (typed.code === 1) {
        return typed.stdout ?? "";
      }
      throw error;
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runGit(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024
  });
  return stdout.trim();
}

async function commitPendingPomChanges(repoPath: string): Promise<string | undefined> {
  const status = await runGit(repoPath, ["status", "--porcelain", "--", "pom.xml"]);
  if (status.length === 0) {
    return undefined;
  }

  await runGit(repoPath, ["add", "--", "pom.xml"]);
  await runGit(repoPath, ["commit", "-m", "codeporter: deterministic test runtime remediation"]);
  return runGit(repoPath, ["rev-parse", "HEAD"]);
}

export class MavenTestRuntimeDeterministicRemediator implements DeterministicRemediator {
  appliesTo(input: {
    scan: ScanResult;
    verify: VerifySummary;
    policy: PolicyConfig;
  }): boolean {
    return (
      input.scan.buildSystem === "maven" &&
      input.verify.tests.failureKind === "java17_module_access_test_failure" &&
      input.policy.remediation?.mavenTestRuntime?.enabled === true
    );
  }

  async run(input: {
    scan: ScanResult;
    verify: VerifySummary;
    repoPath: string;
    policy: PolicyConfig;
    verifier: VerifierPort;
  }): Promise<RemediationResult> {
    const config = input.policy.remediation?.mavenTestRuntime;
    const actions: RemediationAction[] = [];
    const artifacts: RemediationArtifact[] = [];
    const iterations: RemediationIteration[] = [];

    if (!config || !this.appliesTo(input)) {
      return {
        applied: false,
        actions: [
          {
            action: "maven_test_runtime_remediation",
            status: "skipped",
            reason: "Test runtime remediator not applicable"
          }
        ],
        verifySummary: input.verify,
        reason: "not_applicable"
      };
    }

    const pomPath = join(input.repoPath, "pom.xml");
    let verifySummary = input.verify;
    let totalFilesChanged = 0;
    let totalLinesChanged = 0;

    for (let iteration = 1; iteration <= config.maxIterations; iteration += 1) {
      if (verifySummary.tests.failureKind !== "java17_module_access_test_failure") {
        break;
      }

      const beforePom = await readFile(pomPath, "utf8");
      const candidate = ensureModuleAccessOpenInPom(beforePom);
      if (!candidate || !config.allowedFixes.includes(candidate.ruleId)) {
        actions.push({
          action: "maven_test_runtime_remediation",
          status: "skipped",
          reason: "No applicable surefire/failsafe plugin block found for add-opens remediation"
        });
        break;
      }

      const patch = await buildPatch(beforePom, candidate.updatedPom);
      const linesChanged = countPatchChangedLines(patch);
      const filesChanged = 1;
      const nextTotalFiles = totalFilesChanged + filesChanged;
      const nextTotalLines = totalLinesChanged + linesChanged;

      if (
        filesChanged > config.maxFilesChangedPerIteration ||
        linesChanged > config.maxLinesChangedPerIteration ||
        nextTotalFiles > config.maxFilesChangedTotal ||
        nextTotalLines > config.maxLinesChangedTotal
      ) {
        actions.push({
          action: candidate.ruleId,
          status: "failed",
          reason: "Test runtime remediation patch exceeded policy change limits",
          filesChanged,
          linesChanged
        });
        break;
      }

      await writeFile(pomPath, candidate.updatedPom, "utf8");
      totalFilesChanged = nextTotalFiles;
      totalLinesChanged = nextTotalLines;

      actions.push({
        action: candidate.ruleId,
        status: "applied",
        reason: candidate.description,
        filesChanged,
        linesChanged
      });
      artifacts.push({
        type: `artifacts/remediation-test-runtime-${iteration}.patch`,
        data: patch
      });

      verifySummary = await input.verifier.run(input.scan, input.repoPath, input.policy);
      iterations.push({
        iteration,
        ruleId: candidate.ruleId,
        filesChanged,
        linesChanged,
        triggerFailureKind: "java17_module_access_test_failure",
        verifyAfter: {
          testsStatus: verifySummary.tests.status,
          testsFailureKind: verifySummary.tests.failureKind
        }
      });
    }

    let commitAfter: string | undefined;
    if (actions.some((action) => action.status === "applied")) {
      commitAfter = await commitPendingPomChanges(input.repoPath);
    }

    artifacts.unshift({
      type: "remediation-test-runtime.json",
      data: {
        applied: actions.some((action) => action.status === "applied"),
        iterations
      }
    });

    return {
      applied: actions.some((action) => action.status === "applied"),
      actions,
      verifySummary,
      reason: iterations.length > 0 ? "actions_executed" : "no_actions_executed",
      artifacts,
      summary: {
        changedFiles: totalFilesChanged,
        changedLines: totalLinesChanged,
        rulesApplied: iterations.map((item) => item.ruleId),
        commitAfter
      }
    };
  }
}
