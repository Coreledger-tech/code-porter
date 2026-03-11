import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  CheckResult,
  PolicyConfig,
  ScanResult,
  VerifyAttempt,
  VerifySummary
} from "@code-porter/core/src/models.js";
import type { VerifierPort } from "@code-porter/core/src/workflow-runner.js";
import {
  classifyVerifyFailure,
  isCachedResolutionFailure,
  suggestRemediations
} from "./failure-classifier.js";
import { getBuildCommand, getTestCommand, runCommand } from "./commands.js";

const SKIP_DIRS = new Set([".git", "node_modules", "target", "build", "dist", "evidence"]);

async function walkFiles(rootPath: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });

    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = join(currentPath, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) {
            await walk(fullPath);
          }
          return;
        }

        files.push(fullPath);
      })
    );
  }

  const rootStat = await stat(rootPath);
  if (!rootStat.isDirectory()) {
    return files;
  }

  await walk(rootPath);
  return files;
}

async function runBasicStaticChecks(repoPath: string): Promise<VerifySummary["staticChecks"]> {
  const files = await walkFiles(repoPath);
  const candidates = files.filter((filePath) => {
    return /\.(java|xml|gradle|kts|js|ts|json|properties|yml|yaml)$/i.test(filePath);
  });

  for (const filePath of candidates) {
    const content = await readFile(filePath, "utf8");
    if (content.includes("<<<<<<<") || content.includes(">>>>>>>") || content.includes("=======")) {
      return {
        status: "failed",
        reason: `Merge conflict markers detected in ${filePath}`,
        failureKind: "code_failure",
        blockedReason: "Resolve merge conflicts before verification"
      };
    }
  }

  return {
    status: "passed",
    reason: "No merge conflict markers found"
  };
}

function commandAvailable(scan: ScanResult, command: "mvn" | "gradle" | "npm"): boolean {
  return scan.metadata.toolAvailability[command];
}

function commandSpecAvailable(scan: ScanResult, command?: string): boolean {
  if (!command) {
    return false;
  }

  if (command === "mvn" || command === "gradle" || command === "npm") {
    return commandAvailable(scan, command);
  }

  if (command === "sh") {
    return true;
  }

  return true;
}

function buildAttempt(input: {
  command: string;
  args: string[];
  result: CheckResult;
  retryReason?: string;
}): VerifyAttempt {
  return {
    command: input.command,
    args: input.args,
    status: input.result.status,
    exitCode: input.result.exitCode,
    output: input.result.output,
    failureKind: input.result.failureKind,
    retryReason: input.retryReason
  };
}

function withFailureClassification(
  check: CheckResult,
  context: {
    command?: string;
    buildSystem: ScanResult["buildSystem"];
    phase: "compile" | "tests" | "static";
  }
): CheckResult {
  if (check.failureKind) {
    return check;
  }

  if (check.status === "passed") {
    return check;
  }

  const failureKind = classifyVerifyFailure(check, context);
  if (!failureKind) {
    return check;
  }

  const blockedReason =
    failureKind === "tool_missing"
      ? "Required build tool is not available"
      : failureKind === "artifact_resolution"
        ? "Artifact resolution failed for repository dependencies/plugins"
        : failureKind === "repo_unreachable"
          ? "Repository endpoint appears unreachable"
          : undefined;

  return {
    ...check,
    failureKind,
    blockedReason
  };
}

function buildBudgetExceededResult(input: {
  command: string;
  args: string[];
  key: "maxVerifyMinutesPerRun" | "maxVerifyRetries";
  limit: number;
  observed: number;
  reason: string;
}): CheckResult {
  return {
    status: "failed",
    command: [input.command, ...input.args].join(" "),
    reason: input.reason,
    failureKind: "budget_exceeded",
    blockedReason: `Budget guardrail hit: ${input.key} limit=${input.limit}, observed=${input.observed}`,
    budgetKey: input.key,
    budgetLimit: input.limit,
    budgetObserved: input.observed
  };
}

function buildMissingCommandResult(input: {
  buildSystem: ScanResult["buildSystem"];
  command?: string;
  args?: string[];
  reason: string;
}): CheckResult {
  const base: CheckResult = {
    status: "not_run",
    reason: input.reason,
    command: input.command && input.args ? [input.command, ...input.args].join(" ") : undefined,
    failureKind: "tool_missing",
    blockedReason: input.reason
  };

  const classified = withFailureClassification(base, {
    command: input.command,
    buildSystem: input.buildSystem,
    phase: "compile"
  });

  if (input.command && input.args) {
    classified.attempts = [
      buildAttempt({
        command: input.command,
        args: input.args,
        result: classified
      })
    ];
  }

  return classified;
}

function collectSuggestions(checks: CheckResult[]): string[] {
  const suggestions = checks.flatMap((check) => suggestRemediations(check));
  return [...new Set(suggestions)];
}

function withForceUpdate(args: string[]): string[] {
  return args.includes("-U") ? args : ["-U", ...args];
}

function shouldRetryArtifactResolution(
  check: CheckResult,
  policy: PolicyConfig
): boolean {
  return (
    check.status === "failed" &&
    check.failureKind === "artifact_resolution" &&
    policy.verify.retryOnCachedResolution &&
    policy.verify.maven.forceUpdate &&
    isCachedResolutionFailure(check)
  );
}

async function runCommandWithClassification(input: {
  buildSystem: ScanResult["buildSystem"];
  command: string;
  args: string[];
  repoPath: string;
  phase: "compile" | "tests" | "static";
  verifyBudget?: {
    startedAtMs: number;
    deadlineMs: number;
    maxVerifyMinutesPerRun: number;
  };
}): Promise<CheckResult> {
  if (input.verifyBudget) {
    const remainingMs = input.verifyBudget.deadlineMs - Date.now();
    if (remainingMs <= 0) {
      const observedMinutes = Number(
        ((Date.now() - input.verifyBudget.startedAtMs) / 60_000).toFixed(2)
      );
      return buildBudgetExceededResult({
        command: input.command,
        args: input.args,
        key: "maxVerifyMinutesPerRun",
        limit: input.verifyBudget.maxVerifyMinutesPerRun,
        observed: observedMinutes,
        reason: "Verification runtime budget exhausted before command execution"
      });
    }
  }

  const timeoutMs = input.verifyBudget
    ? Math.max(1, input.verifyBudget.deadlineMs - Date.now())
    : undefined;
  const result = await runCommand(
    {
      command: input.command,
      args: input.args
    },
    input.repoPath,
    { timeoutMs }
  );

  if (result.status === "failed" && result.timedOut && input.verifyBudget) {
    const observedMinutes = Number(
      ((Date.now() - input.verifyBudget.startedAtMs) / 60_000).toFixed(2)
    );
    const budgetResult = buildBudgetExceededResult({
      command: input.command,
      args: input.args,
      key: "maxVerifyMinutesPerRun",
      limit: input.verifyBudget.maxVerifyMinutesPerRun,
      observed: observedMinutes,
      reason: "Verification command timed out due to maxVerifyMinutesPerRun budget"
    });
    budgetResult.output = result.output;
    return budgetResult;
  }

  const classified = withFailureClassification(result, {
    command: input.command,
    buildSystem: input.buildSystem,
    phase: input.phase
  });

  return {
    ...classified,
    attempts: [
      buildAttempt({
        command: input.command,
        args: input.args,
        result: classified
      })
    ]
  };
}

async function maybeRunMavenPrefetch(input: {
  scan: ScanResult;
  repoPath: string;
  policy: PolicyConfig;
  verifyBudget?: {
    startedAtMs: number;
    deadlineMs: number;
    maxVerifyMinutesPerRun: number;
  };
}): Promise<VerifyAttempt | undefined> {
  if (
    input.scan.buildSystem !== "maven" ||
    !input.policy.verify.maven.prefetchPlugins ||
    !input.scan.metadata.toolAvailability.mvn
  ) {
    return undefined;
  }

  const args = ["-q", "-U", "dependency:resolve-plugins"];
  const result = await runCommandWithClassification({
    buildSystem: input.scan.buildSystem,
    command: "mvn",
    args,
    repoPath: input.repoPath,
    phase: "compile",
    verifyBudget: input.verifyBudget
  });

  return buildAttempt({
    command: "mvn",
    args,
    result,
    retryReason: "prefetch_plugins"
  });
}

async function runBuildCheck(input: {
  scan: ScanResult;
  repoPath: string;
  policy: PolicyConfig;
  commandSpec: {
    command: string;
    args: string[];
  };
  phase: "compile" | "tests";
  prefaceAttempts?: VerifyAttempt[];
  verifyBudget?: {
    startedAtMs: number;
    deadlineMs: number;
    maxVerifyMinutesPerRun: number;
  };
}): Promise<CheckResult> {
  const attempts: VerifyAttempt[] = [...(input.prefaceAttempts ?? [])];
  let retryCount = 0;

  let current = await runCommandWithClassification({
    buildSystem: input.scan.buildSystem,
    command: input.commandSpec.command,
    args: input.commandSpec.args,
    repoPath: input.repoPath,
    phase: input.phase,
    verifyBudget: input.verifyBudget
  });
  attempts.push(
    buildAttempt({
      command: input.commandSpec.command,
      args: input.commandSpec.args,
      result: current
    })
  );

  if (input.scan.buildSystem !== "maven") {
    return {
      ...current,
      attempts
    };
  }

  if (shouldRetryArtifactResolution(current, input.policy)) {
    if (retryCount >= input.policy.maxVerifyRetries) {
      return {
        ...buildBudgetExceededResult({
          command: input.commandSpec.command,
          args: input.commandSpec.args,
          key: "maxVerifyRetries",
          limit: input.policy.maxVerifyRetries,
          observed: retryCount + 1,
          reason: "Retry cap reached before attempting Maven cached-resolution retry"
        }),
        attempts
      };
    }

    const retryArgs = withForceUpdate(input.commandSpec.args);
    current = await runCommandWithClassification({
      buildSystem: input.scan.buildSystem,
      command: input.commandSpec.command,
      args: retryArgs,
      repoPath: input.repoPath,
      phase: input.phase,
      verifyBudget: input.verifyBudget
    });
    retryCount += 1;
    attempts.push(
      buildAttempt({
        command: input.commandSpec.command,
        args: retryArgs,
        result: current,
        retryReason: "retry_force_update_cached_resolution"
      })
    );
  }

  if (
    input.policy.verify.maven.purgeLocalCache &&
    current.status === "failed" &&
    current.failureKind === "artifact_resolution" &&
    isCachedResolutionFailure(current)
  ) {
    if (retryCount >= input.policy.maxVerifyRetries) {
      return {
        ...buildBudgetExceededResult({
          command: input.commandSpec.command,
          args: input.commandSpec.args,
          key: "maxVerifyRetries",
          limit: input.policy.maxVerifyRetries,
          observed: retryCount + 1,
          reason: "Retry cap reached before purge-and-retry path"
        }),
        attempts
      };
    }

    const purgeArgs = ["-q", "dependency:purge-local-repository"];
    const purgeResult = await runCommandWithClassification({
      buildSystem: input.scan.buildSystem,
      command: "mvn",
      args: purgeArgs,
      repoPath: input.repoPath,
      phase: input.phase,
      verifyBudget: input.verifyBudget
    });
    attempts.push(
      buildAttempt({
        command: "mvn",
        args: purgeArgs,
        result: purgeResult,
        retryReason: "purge_local_cache_before_retry"
      })
    );

    const retryArgs = withForceUpdate(input.commandSpec.args);
    current = await runCommandWithClassification({
      buildSystem: input.scan.buildSystem,
      command: input.commandSpec.command,
      args: retryArgs,
      repoPath: input.repoPath,
      phase: input.phase,
      verifyBudget: input.verifyBudget
    });
    retryCount += 1;
    attempts.push(
      buildAttempt({
        command: input.commandSpec.command,
        args: retryArgs,
        result: current,
        retryReason: "retry_after_purge_local_cache"
      })
    );
  }

  return {
    ...current,
    attempts
  };
}

export class DefaultVerifier implements VerifierPort {
  async run(scan: ScanResult, repoPath: string, policy: PolicyConfig): Promise<VerifySummary> {
    const startedAtMs = Date.now();
    const verifyBudget = {
      startedAtMs,
      deadlineMs: startedAtMs + policy.maxVerifyMinutesPerRun * 60_000,
      maxVerifyMinutesPerRun: policy.maxVerifyMinutesPerRun
    };
    const buildCommand = getBuildCommand(scan);
    const testCommand = getTestCommand(scan);
    const prefetchAttempt = await maybeRunMavenPrefetch({
      scan,
      repoPath,
      policy,
      verifyBudget
    });

    const compileMissingReason =
      scan.buildSystem === "gradle" &&
      scan.metadata.gradleProjectType === "jvm" &&
      !scan.metadata.gradleWrapperPath
        ? "Gradle wrapper missing; Stage 3 minimal Gradle lane requires wrapper-based builds"
        : undefined;

    const compile =
      buildCommand && commandSpecAvailable(scan, buildCommand.command)
        ? await runBuildCheck({
            scan,
            repoPath,
            policy,
            commandSpec: buildCommand,
            phase: "compile",
            prefaceAttempts: prefetchAttempt ? [prefetchAttempt] : undefined,
            verifyBudget
          })
        : buildMissingCommandResult({
            buildSystem: scan.buildSystem,
            command: buildCommand?.command,
            args: buildCommand?.args,
            reason: compileMissingReason ?? (buildCommand
              ? `Command '${buildCommand.command}' not available`
              : `No build command configured for build system '${scan.buildSystem}'`)
          });

    const tests = !scan.hasTests
      ? {
          status: "not_run" as const,
          reason: "No tests detected"
        }
      : testCommand && commandSpecAvailable(scan, testCommand.command)
        ? await runBuildCheck({
            scan,
            repoPath,
            policy,
            commandSpec: testCommand,
            phase: "tests",
            verifyBudget
          })
        : buildMissingCommandResult({
            buildSystem: scan.buildSystem,
            command: testCommand?.command,
            args: testCommand?.args,
            reason: compileMissingReason ?? (testCommand
              ? `Command '${testCommand.command}' not available`
              : `No test command configured for build system '${scan.buildSystem}'`)
          });

    const staticChecks = await runBasicStaticChecks(repoPath);

    return {
      buildSystem: scan.buildSystem,
      hasTests: scan.hasTests,
      compile,
      tests,
      staticChecks,
      remediationSuggestions: collectSuggestions([compile, tests])
    };
  }
}

export {
  CompositeDeterministicRemediator,
  MavenDeterministicRemediator,
  MavenInfraDeterministicRemediator
} from "./remediator.js";
export { MavenCompileDeterministicRemediator } from "./compile-remediator.js";
export { MavenTestRuntimeDeterministicRemediator } from "./test-runtime-remediator.js";
