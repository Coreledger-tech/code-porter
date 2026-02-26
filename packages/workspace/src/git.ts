import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GitCommandError extends Error {
  readonly command: string;
  readonly args: string[];
  readonly exitCode?: number;
  readonly output?: string;

  constructor(input: {
    command: string;
    args: string[];
    message: string;
    exitCode?: number;
    output?: string;
  }) {
    super(input.message);
    this.name = "GitCommandError";
    this.command = input.command;
    this.args = input.args;
    this.exitCode = input.exitCode;
    this.output = input.output;
  }
}

export async function runGit(
  args: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
  } = {}
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 120000,
      maxBuffer: 16 * 1024 * 1024
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const typedError = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };

    throw new GitCommandError({
      command: "git",
      args,
      message: typedError.message ?? `git ${args.join(" ")} failed`,
      exitCode: typeof typedError.code === "number" ? typedError.code : undefined,
      output: [typedError.stdout, typedError.stderr].filter(Boolean).join("\n")
    });
  }
}

export function sanitizeBranchSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function isAuthLikeFailure(message: string): boolean {
  return (
    /authentication failed/i.test(message) ||
    /could not read username/i.test(message) ||
    /permission denied/i.test(message) ||
    /http basic: access denied/i.test(message) ||
    /403 forbidden/i.test(message) ||
    /401 unauthorized/i.test(message)
  );
}
