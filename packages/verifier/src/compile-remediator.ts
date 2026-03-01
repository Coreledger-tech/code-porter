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
const COMPILER_PLUGIN_VERSION = "3.11.0";
const LOMBOK_COMPILE_PATTERNS = [
  /cannot find symbol[\s\S]{0,300}\bBuilder\b/i,
  /cannot find symbol[\s\S]{0,300}\bbuilder\s*\(/i,
  /cannot find symbol[\s\S]{0,300}\blog\b/i,
  /symbol:\s+class\s+[A-Za-z0-9_]*Builder\b/i,
  /symbol:\s+method\s+builder\s*\(/i,
  /symbol:\s+variable\s+log\b/i
];

type AllowedFix =
  NonNullable<NonNullable<PolicyConfig["remediation"]>["mavenCompile"]>["allowedFixes"][number];

type RemediationIteration = {
  iteration: number;
  ruleId: AllowedFix;
  filesChanged: number;
  linesChanged: number;
  triggerFailureKind: "code_compile_failure";
  verifyAfter: {
    compileStatus: VerifySummary["compile"]["status"];
    compileFailureKind: VerifySummary["compile"]["failureKind"];
  };
};

type FixCandidate = {
  ruleId: AllowedFix;
  updatedPom: string;
  description: string;
};

function combinedCompileText(verify: VerifySummary): string {
  return `${verify.compile.reason ?? ""}\n${verify.compile.output ?? ""}`;
}

function hasLombokCompileSymptoms(verify: VerifySummary): boolean {
  const text = combinedCompileText(verify);
  return LOMBOK_COMPILE_PATTERNS.some((pattern) => pattern.test(text));
}

function resolvePropertyValue(content: string, propertyName: string): string | null {
  const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`<${escaped}>\\s*([^<]+)\\s*<\\/${escaped}>`, "i"));
  return match?.[1]?.trim() ?? null;
}

function resolveLombokVersion(content: string): string | null {
  const dependencyBlocks = content.match(/<dependency>[\s\S]*?<\/dependency>/g) ?? [];
  for (const block of dependencyBlocks) {
    if (
      !/<groupId>\s*org\.projectlombok\s*<\/groupId>/.test(block) ||
      !/<artifactId>\s*lombok\s*<\/artifactId>/.test(block)
    ) {
      continue;
    }

    const versionMatch = block.match(/<version>\s*([^<]+)\s*<\/version>/);
    if (!versionMatch) {
      return null;
    }

    const rawVersion = versionMatch[1].trim();
    const propertyRef = rawVersion.match(/^\$\{([^}]+)\}$/);
    if (propertyRef) {
      return resolvePropertyValue(content, propertyRef[1]);
    }

    return rawVersion;
  }

  return null;
}

function findPluginBlock(content: string, groupId: string, artifactId: string): string | null {
  const pluginBlocks = content.match(/<plugin>[\s\S]*?<\/plugin>/g) ?? [];
  for (const block of pluginBlocks) {
    if (
      new RegExp(`<groupId>\\s*${groupId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*<\\/groupId>`, "i").test(block) &&
      new RegExp(`<artifactId>\\s*${artifactId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*<\\/artifactId>`, "i").test(block)
    ) {
      return block;
    }
  }

  return null;
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
  const tempDir = await mkdtemp(join(tmpdir(), "code-porter-remediation-"));
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
  await runGit(repoPath, ["commit", "-m", "codeporter: deterministic compile remediation"]);
  return runGit(repoPath, ["rev-parse", "HEAD"]);
}

function buildCompilerPluginBlock(lombokVersion: string, indent: string): string {
  const child = `${indent}  `;
  const nested = `${child}  `;
  const inner = `${nested}  `;
  const leaf = `${inner}  `;
  return [
    `${indent}<plugin>`,
    `${child}<groupId>org.apache.maven.plugins</groupId>`,
    `${child}<artifactId>maven-compiler-plugin</artifactId>`,
    `${child}<version>${COMPILER_PLUGIN_VERSION}</version>`,
    `${child}<configuration>`,
    `${nested}<annotationProcessorPaths>`,
    `${inner}<path>`,
    `${leaf}<groupId>org.projectlombok</groupId>`,
    `${leaf}<artifactId>lombok</artifactId>`,
    `${leaf}<version>${lombokVersion}</version>`,
    `${inner}</path>`,
    `${nested}</annotationProcessorPaths>`,
    `${child}</configuration>`,
    `${indent}</plugin>`
  ].join("\n");
}

function ensureMavenCompilerPluginForLombok(
  pom: string,
  lombokVersion: string | null,
  verify: VerifySummary
): FixCandidate | null {
  if (!hasLombokCompileSymptoms(verify) || !lombokVersion) {
    return null;
  }

  if (!/<build>[\s\S]*?<plugins>[\s\S]*?<\/plugins>[\s\S]*?<\/build>/i.test(pom)) {
    return null;
  }

  if (findPluginBlock(pom, "org.apache.maven.plugins", "maven-compiler-plugin")) {
    return null;
  }

  const closingMatch = pom.match(/^(\s*)<\/plugins>/m);
  const indent = closingMatch?.[1] ?? "    ";
  const pluginBlock = buildCompilerPluginBlock(lombokVersion, indent);
  const updatedPom = pom.replace(/<\/plugins>/i, `\n${pluginBlock}\n${indent}</plugins>`);
  if (updatedPom === pom) {
    return null;
  }

  return {
    ruleId: "ensure_maven_compiler_plugin_for_lombok",
    updatedPom,
    description: `Inserted maven-compiler-plugin with Lombok annotationProcessorPaths (${lombokVersion})`
  };
}

function ensureLombokAnnotationProcessorPath(
  pom: string,
  lombokVersion: string | null,
  verify: VerifySummary
): FixCandidate | null {
  if (!hasLombokCompileSymptoms(verify) || !lombokVersion) {
    return null;
  }

  const compilerPlugin = findPluginBlock(pom, "org.apache.maven.plugins", "maven-compiler-plugin");
  if (!compilerPlugin) {
    return null;
  }

  if (
    /<annotationProcessorPaths>[\s\S]*?<groupId>\s*org\.projectlombok\s*<\/groupId>[\s\S]*?<artifactId>\s*lombok\s*<\/artifactId>[\s\S]*?<\/annotationProcessorPaths>/i.test(
      compilerPlugin
    )
  ) {
    return null;
  }

  const pluginIndent = compilerPlugin.match(/^(\s*)<plugin>/m)?.[1] ?? "      ";
  const configIndent = `${pluginIndent}  `;
  const pathsIndent = `${configIndent}  `;
  const pathIndent = `${pathsIndent}  `;
  const leafIndent = `${pathIndent}  `;
  const lombokPath = [
    `${pathsIndent}<annotationProcessorPaths>`,
    `${pathIndent}<path>`,
    `${leafIndent}<groupId>org.projectlombok</groupId>`,
    `${leafIndent}<artifactId>lombok</artifactId>`,
    `${leafIndent}<version>${lombokVersion}</version>`,
    `${pathIndent}</path>`,
    `${pathsIndent}</annotationProcessorPaths>`
  ].join("\n");

  let updatedPlugin = compilerPlugin;
  if (/<annotationProcessorPaths>[\s\S]*?<\/annotationProcessorPaths>/i.test(compilerPlugin)) {
    updatedPlugin = compilerPlugin.replace(
      /(<annotationProcessorPaths>[\s\S]*?)(<\/annotationProcessorPaths>)/i,
      (_match, start, end) => {
        const indent = `${pathsIndent}  `;
        const pathBlock = [
          `${indent}<path>`,
          `${leafIndent}<groupId>org.projectlombok</groupId>`,
          `${leafIndent}<artifactId>lombok</artifactId>`,
          `${leafIndent}<version>${lombokVersion}</version>`,
          `${indent}</path>`
        ].join("\n");
        return `${start.trimEnd()}\n${pathBlock}\n${pathsIndent}${end}`;
      }
    );
  } else if (/<configuration>[\s\S]*?<\/configuration>/i.test(compilerPlugin)) {
    updatedPlugin = compilerPlugin.replace(
      /<\/configuration>/i,
      `${lombokPath}\n${configIndent}</configuration>`
    );
  } else {
    const configurationBlock = [
      `${configIndent}<configuration>`,
      lombokPath,
      `${configIndent}</configuration>`
    ].join("\n");
    updatedPlugin = compilerPlugin.replace(/<\/plugin>/i, `${configurationBlock}\n${pluginIndent}</plugin>`);
  }

  if (updatedPlugin === compilerPlugin) {
    return null;
  }

  return {
    ruleId: "ensure_lombok_annotation_processor_path",
    updatedPom: pom.replace(compilerPlugin, updatedPlugin),
    description: `Added Lombok annotationProcessorPaths (${lombokVersion}) to maven-compiler-plugin`
  };
}

function removeProcNone(pom: string, verify: VerifySummary): FixCandidate | null {
  if (!hasLombokCompileSymptoms(verify)) {
    return null;
  }

  const compilerPlugin = findPluginBlock(pom, "org.apache.maven.plugins", "maven-compiler-plugin");
  if (!compilerPlugin) {
    return null;
  }

  let updatedPlugin = compilerPlugin;
  updatedPlugin = updatedPlugin.replace(/\s*<proc>\s*none\s*<\/proc>\s*/gi, "\n");
  updatedPlugin = updatedPlugin.replace(/\s*<arg>\s*-proc:none\s*<\/arg>\s*/gi, "\n");

  if (updatedPlugin === compilerPlugin) {
    return null;
  }

  return {
    ruleId: "remove_proc_none",
    updatedPom: pom.replace(compilerPlugin, updatedPlugin),
    description: "Removed proc:none compiler configuration that disables annotation processing"
  };
}

function selectApplicableFix(
  pom: string,
  verify: VerifySummary,
  allowedFixes: AllowedFix[]
): FixCandidate | null {
  const lombokVersion = resolveLombokVersion(pom);
  const candidates: Record<AllowedFix, () => FixCandidate | null> = {
    ensure_maven_compiler_plugin_for_lombok: () =>
      ensureMavenCompilerPluginForLombok(pom, lombokVersion, verify),
    ensure_lombok_annotation_processor_path: () =>
      ensureLombokAnnotationProcessorPath(pom, lombokVersion, verify),
    remove_proc_none: () => removeProcNone(pom, verify)
  };

  for (const fixId of allowedFixes) {
    const candidate = candidates[fixId]?.();
    if (candidate && candidate.updatedPom !== pom) {
      return candidate;
    }
  }

  return null;
}

export class MavenCompileDeterministicRemediator implements DeterministicRemediator {
  appliesTo(input: {
    scan: ScanResult;
    verify: VerifySummary;
    policy: PolicyConfig;
  }): boolean {
    return (
      input.scan.buildSystem === "maven" &&
      input.verify.compile.failureKind === "code_compile_failure" &&
      input.policy.remediation?.mavenCompile?.enabled === true
    );
  }

  async run(input: {
    scan: ScanResult;
    verify: VerifySummary;
    repoPath: string;
    policy: PolicyConfig;
    verifier: VerifierPort;
  }): Promise<RemediationResult> {
    const config = input.policy.remediation?.mavenCompile;
    const actions: RemediationAction[] = [];
    const artifacts: RemediationArtifact[] = [];
    const iterations: RemediationIteration[] = [];

    if (!config || !this.appliesTo(input)) {
      return {
        applied: false,
        actions: [
          {
            action: "maven_compile_remediation",
            status: "skipped",
            reason: "Compile remediator not applicable"
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
      if (verifySummary.compile.failureKind !== "code_compile_failure") {
        break;
      }

      const beforePom = await readFile(pomPath, "utf8");
      const candidate = selectApplicableFix(beforePom, verifySummary, config.allowedFixes);
      if (!candidate) {
        actions.push({
          action: "maven_compile_remediation",
          status: "skipped",
          reason: "No applicable Maven compile remediation rule matched the current failure"
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
          reason: "Compile remediation patch exceeded policy change limits",
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
        type: `artifacts/remediation-${iteration}.patch`,
        data: patch
      });

      verifySummary = await input.verifier.run(input.scan, input.repoPath, input.policy);
      iterations.push({
        iteration,
        ruleId: candidate.ruleId,
        filesChanged,
        linesChanged,
        triggerFailureKind: "code_compile_failure",
        verifyAfter: {
          compileStatus: verifySummary.compile.status,
          compileFailureKind: verifySummary.compile.failureKind
        }
      });
    }

    let commitAfter: string | undefined;
    if (actions.some((action) => action.status === "applied")) {
      commitAfter = await commitPendingPomChanges(input.repoPath);
    }

    artifacts.unshift({
      type: "remediation.json",
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
