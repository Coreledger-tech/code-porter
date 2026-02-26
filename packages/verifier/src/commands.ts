import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BuildSystem, CheckResult } from "@code-porter/core/src/models.js";

const execFileAsync = promisify(execFile);

export interface CommandSpec {
  command: string;
  args: string[];
}

export function getBuildCommand(buildSystem: BuildSystem): CommandSpec | undefined {
  switch (buildSystem) {
    case "maven":
      return { command: "mvn", args: ["-q", "-DskipTests", "compile"] };
    case "gradle":
      return { command: "gradle", args: ["build", "-x", "test"] };
    case "node":
      return { command: "npm", args: ["run", "build", "--if-present"] };
    default:
      return undefined;
  }
}

export function getTestCommand(buildSystem: BuildSystem): CommandSpec | undefined {
  switch (buildSystem) {
    case "maven":
      return { command: "mvn", args: ["-q", "test"] };
    case "gradle":
      return { command: "gradle", args: ["test"] };
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
  }
): Promise<CheckResult> {
  try {
    const { stdout, stderr } = await execFileAsync(spec.command, spec.args, {
      cwd,
      timeout: options?.timeoutMs ?? 300000,
      maxBuffer: 10 * 1024 * 1024
    });

    return {
      status: "passed",
      command: [spec.command, ...spec.args].join(" "),
      output: [stdout, stderr].filter(Boolean).join("\n")
    };
  } catch (error) {
    const typedError = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
      killed?: boolean;
      signal?: NodeJS.Signals;
    };
    const timedOut =
      typedError.killed === true &&
      (typedError.signal === "SIGTERM" ||
        /timed?\s*out|timeout/i.test(typedError.message ?? ""));

    return {
      status: "failed",
      command: [spec.command, ...spec.args].join(" "),
      exitCode:
        typeof typedError.code === "number"
          ? typedError.code
          : undefined,
      reason: typedError.message ?? "command failed",
      output: [typedError.stdout, typedError.stderr].filter(Boolean).join("\n"),
      timedOut
    };
  }
}
