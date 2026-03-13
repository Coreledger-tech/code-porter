import { spawn } from "node:child_process";
import type { CheckResult, ScanResult } from "@code-porter/core/src/models.js";

const OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;
const KILL_GRACE_MS = 1_000;

export interface CommandSpec {
  command: string;
  args: string[];
}

function appendOutput(current: string, chunk: string): string {
  if (current.length >= OUTPUT_LIMIT_BYTES) {
    return current;
  }

  const next = current + chunk;
  if (next.length <= OUTPUT_LIMIT_BYTES) {
    return next;
  }

  const remaining = Math.max(0, OUTPUT_LIMIT_BYTES - current.length);
  return `${current}${chunk.slice(0, remaining)}\n[output truncated]`;
}

function buildCommandText(spec: CommandSpec): string {
  return [spec.command, ...spec.args].join(" ");
}

function formatAbortReason(reason: unknown): string {
  if (typeof reason === "string" && reason.trim().length > 0) {
    return reason;
  }

  if (reason instanceof Error && reason.message.trim().length > 0) {
    return reason.message;
  }

  return "abort requested";
}

async function killChildProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  const target = process.platform === "win32" ? pid : -pid;
  try {
    process.kill(target, "SIGTERM");
  } catch {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));

  try {
    process.kill(target, "SIGKILL");
  } catch {
    // Process already exited between TERM and KILL.
  }
}

export function getBuildCommand(scan: ScanResult): CommandSpec | undefined {
  switch (scan.buildSystem) {
    case "maven":
      return { command: "mvn", args: ["-q", "-DskipTests", "compile"] };
    case "gradle":
      return scan.metadata.gradleWrapperPath
        ? { command: "sh", args: ["./gradlew", "--no-daemon", "-q", "classes"] }
        : undefined;
    case "node":
      return { command: "npm", args: ["run", "build", "--if-present"] };
    default:
      return undefined;
  }
}

export function getTestCommand(scan: ScanResult): CommandSpec | undefined {
  switch (scan.buildSystem) {
    case "maven":
      return { command: "mvn", args: ["-q", "test"] };
    case "gradle":
      return scan.metadata.gradleWrapperPath
        ? { command: "sh", args: ["./gradlew", "--no-daemon", "-q", "test"] }
        : undefined;
    case "node":
      return { command: "npm", args: ["test", "--if-present"] };
    default:
      return undefined;
  }
}

export async function runCommand(
  spec: CommandSpec,
  cwd: string,
  options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }
): Promise<CheckResult> {
  const commandText = buildCommandText(spec);
  const startedAt = Date.now();

  return await new Promise<CheckResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let terminationSignal: string | undefined;
    let exitCode: number | undefined;
    let reason: string | undefined;

    const child = spawn(spec.command, spec.args, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });

    const timeoutHandle =
      options?.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            reason = `Verification command timed out after ${options.timeoutMs}ms`;
            void killChildProcessTree(child.pid ?? 0);
          }, options.timeoutMs)
        : undefined;

    const abortListener = () => {
      aborted = true;
      reason = `Verification command aborted: ${formatAbortReason(options?.signal?.reason)}`;
      void killChildProcessTree(child.pid ?? 0);
    };

    const cleanup = (): void => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      options?.signal?.removeEventListener("abort", abortListener);
    };

    const finalize = (result: CheckResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({
        ...result,
        command: commandText,
        stdout: stdout || undefined,
        stderr: stderr || undefined,
        output: [stdout, stderr].filter(Boolean).join("\n") || undefined,
        elapsedMs: Date.now() - startedAt,
        exitCode,
        timedOut: (result.timedOut ?? timedOut) || undefined,
        aborted: (result.aborted ?? aborted) || undefined,
        terminationSignal: result.terminationSignal ?? terminationSignal
      });
    };

    if (options?.signal?.aborted) {
      abortListener();
    } else {
      options?.signal?.addEventListener("abort", abortListener, { once: true });
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendOutput(stderr, chunk);
    });

    child.once("error", (error) => {
      reason = error.message || "command failed to start";
      finalize({
        status: "failed",
        reason,
        failureKind: "verifier_infrastructure_failure"
      });
    });

    child.once("close", (code, signal) => {
      exitCode = typeof code === "number" ? code : undefined;
      terminationSignal = signal ?? undefined;

      if (timedOut) {
        finalize({
          status: "failed",
          reason,
          failureKind: "verify_timeout",
          blockedReason: reason
        });
        return;
      }

      if (aborted) {
        finalize({
          status: "failed",
          reason,
          failureKind: "verifier_infrastructure_failure",
          blockedReason: reason
        });
        return;
      }

      if (code === 0) {
        finalize({
          status: "passed"
        });
        return;
      }

      finalize({
        status: "failed",
        reason:
          reason ??
          (signal
            ? `Verification command exited via signal ${signal}`
            : `Verification command exited with code ${code ?? "unknown"}`)
      });
    });
  });
}
