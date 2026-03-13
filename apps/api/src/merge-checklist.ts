import { access, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type {
  MergeChecklistSummary,
  PolicyConfig,
  ScanResult,
  VerifySummary
} from "@code-porter/core/src/models.js";
import { runGit } from "@code-porter/workspace/src/git.js";

export interface MergeChecklistArtifact {
  passed: boolean;
  reasons: string[];
  advisories: string[];
  changedFiles: number;
  changedLines: number;
  changedFilePaths: string[];
  allowedFileScope: string[];
  verifyArtifactExists: boolean;
  remediationArtifactsRequired: boolean;
  remediationJsonArtifacts: string[];
  remediationPatchArtifacts: string[];
  parseability: Array<{
    filePath: string;
    parseable: boolean;
  }>;
}

export interface MergeChecklistEvaluation {
  summary: MergeChecklistSummary;
  artifact: MergeChecklistArtifact;
}

function scopePrefix(scan: ScanResult): string {
  const buildRoot = scan.metadata.selectedBuildRoot ?? ".";
  return buildRoot === "." ? "" : `${buildRoot.replace(/\/+$/, "")}/`;
}

function buildAllowedFileScope(scan: ScanResult): string[] {
  const prefix = scopePrefix(scan);

  if (scan.buildSystem === "maven") {
    return [`${prefix}pom.xml`, `${prefix}src/test/`];
  }

  if (scan.buildSystem === "gradle" && scan.metadata.gradleProjectType === "android") {
    return [
      `${prefix}gradle.properties`,
      `${prefix}gradle/wrapper/gradle-wrapper.properties`
    ];
  }

  if (scan.buildSystem === "gradle") {
    return [
      `${prefix}build.gradle`,
      `${prefix}build.gradle.kts`,
      `${prefix}settings.gradle`,
      `${prefix}settings.gradle.kts`,
      `${prefix}gradle.properties`,
      `${prefix}gradle/wrapper/gradle-wrapper.properties`
    ];
  }

  return [];
}

function isPathAllowed(path: string, allowedScope: string[]): boolean {
  return allowedScope.some((allowed) => {
    return allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed;
  });
}

function extractRuntimeRemediationRules(summary: Record<string, unknown>): string[] {
  const applySummary =
    summary.applySummary && typeof summary.applySummary === "object"
      ? (summary.applySummary as Record<string, unknown>)
      : {};
  const remediation =
    applySummary.remediation && typeof applySummary.remediation === "object"
      ? (applySummary.remediation as Record<string, unknown>)
      : {};
  const rulesApplied = remediation.rulesApplied;
  return Array.isArray(rulesApplied)
    ? rulesApplied.filter((value): value is string => typeof value === "string")
    : [];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findMatchingArtifacts(root: string, pattern: RegExp): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => join(root, entry.name))
      .sort();
  } catch {
    return [];
  }
}

export function isLikelyParseableXml(content: string): boolean {
  const sanitized = content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");

  const stack: string[] = [];
  const tagPattern = /<([^<>]+)>/g;

  for (const match of sanitized.matchAll(tagPattern)) {
    const raw = (match[1] ?? "").trim();
    if (!raw || raw.startsWith("!") || raw.startsWith("?")) {
      continue;
    }

    if (raw.startsWith("/")) {
      const closing = raw.slice(1).trim().split(/\s+/)[0];
      const open = stack.pop();
      if (open !== closing) {
        return false;
      }
      continue;
    }

    if (raw.endsWith("/")) {
      continue;
    }

    const tagName = raw.split(/\s+/)[0];
    if (!tagName) {
      return false;
    }
    stack.push(tagName);
  }

  return stack.length === 0;
}

async function listChangedFilePaths(input: {
  workspacePath: string;
  commitBefore: string;
  commitAfter?: string;
}): Promise<string[]> {
  if (!input.commitAfter) {
    return [];
  }

  const diff = await runGit(
    ["diff", "--name-only", input.commitBefore, input.commitAfter],
    { cwd: input.workspacePath }
  );
  return diff.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function evaluateMergeChecklist(input: {
  workspacePath: string;
  evidencePath: string;
  commitBefore: string;
  commitAfter?: string;
  changedFiles: number;
  changedLines: number;
  policy: PolicyConfig;
  scan: ScanResult;
  verifySummary: VerifySummary;
  summary: Record<string, unknown>;
}): Promise<MergeChecklistEvaluation> {
  const reasons: string[] = [];
  const advisories: string[] = [];
  const allowedFileScope = buildAllowedFileScope(input.scan);
  const changedFilePaths = await listChangedFilePaths({
    workspacePath: input.workspacePath,
    commitBefore: input.commitBefore,
    commitAfter: input.commitAfter
  });

  if (allowedFileScope.length > 0) {
    const outOfScope = changedFilePaths.filter((filePath) => !isPathAllowed(filePath, allowedFileScope));
    if (outOfScope.length > 0) {
      reasons.push(`Changed files exceed lane scope: ${outOfScope.join(", ")}`);
    }
  }

  if (input.changedFiles > input.policy.maxFilesChanged) {
    reasons.push(
      `Changed files ${input.changedFiles} exceed policy maxFilesChanged ${input.policy.maxFilesChanged}`
    );
  }

  if (input.changedLines > input.policy.maxChangeLines) {
    reasons.push(
      `Changed lines ${input.changedLines} exceed policy maxChangeLines ${input.policy.maxChangeLines}`
    );
  }

  const verifyArtifactExists = await exists(join(input.evidencePath, "verify.json"));
  if (!verifyArtifactExists) {
    reasons.push("verify.json is missing");
  }

  const remediationRules = extractRuntimeRemediationRules(input.summary);
  const remediationJsonArtifacts = await findMatchingArtifacts(
    input.evidencePath,
    /^remediation.*\.json$/i
  );
  const remediationPatchArtifacts = await findMatchingArtifacts(
    join(input.evidencePath, "artifacts"),
    /^remediation.*\.patch$/i
  );
  const remediationArtifactsRequired = remediationRules.length > 0;

  if (remediationArtifactsRequired && remediationJsonArtifacts.length === 0) {
    reasons.push("Remediation fired but remediation JSON artifacts are missing");
  }

  if (remediationArtifactsRequired && remediationPatchArtifacts.length === 0) {
    reasons.push("Remediation fired but remediation patch artifacts are missing");
  }

  const parseability: Array<{ filePath: string; parseable: boolean }> = [];
  for (const filePath of changedFilePaths.filter((candidate) => candidate.endsWith(".xml"))) {
    const absolutePath = join(input.workspacePath, filePath);
    const content = await readFile(absolutePath, "utf8");
    const parseable = isLikelyParseableXml(content);
    parseability.push({
      filePath: relative(input.workspacePath, absolutePath),
      parseable
    });
    if (!parseable) {
      reasons.push(`XML file is not parseable after patching: ${filePath}`);
    }
  }

  if (!input.commitAfter) {
    advisories.push("No committed changes were produced; PR creation is not applicable");
  }

  if (
    input.scan.buildSystem === "gradle" &&
    input.scan.metadata.gradleProjectType === "android" &&
    input.changedFiles === 0
  ) {
    advisories.push("Guarded Android baseline is already satisfied; no PR is needed");
  }

  const passed = reasons.length === 0;
  return {
    summary: {
      passed,
      reasons: passed ? advisories : reasons
    },
    artifact: {
      passed,
      reasons,
      advisories,
      changedFiles: input.changedFiles,
      changedLines: input.changedLines,
      changedFilePaths,
      allowedFileScope,
      verifyArtifactExists,
      remediationArtifactsRequired,
      remediationJsonArtifacts,
      remediationPatchArtifacts,
      parseability
    }
  };
}
