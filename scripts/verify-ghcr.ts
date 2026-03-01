import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function parseArgs(argv: string[]): { tag: string } {
  const tagFlagIndex = argv.findIndex((arg) => arg === "--tag");
  if (tagFlagIndex === -1 || tagFlagIndex + 1 >= argv.length) {
    throw new Error("Usage: npm run verify:ghcr -- --tag <release-tag>");
  }

  const tag = argv[tagFlagIndex + 1]?.trim();
  if (!tag) {
    throw new Error("Release tag must be non-empty");
  }

  return { tag };
}

export async function verifyGhcrImage(tag: string): Promise<void> {
  const image = `ghcr.io/coreledger-tech/code-porter:${tag}`;
  const dockerConfigDir = mkdtempSync(join(tmpdir(), "code-porter-ghcr-"));

  try {
    await execFileAsync("docker", ["pull", image], {
      env: {
        ...process.env,
        DOCKER_CONFIG: dockerConfigDir
      },
      timeout: 10 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024
    });
    console.log(`[verify:ghcr] Pulled ${image}`);
  } catch (error) {
    const typed = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const output = [typed.stdout, typed.stderr, typed.message].filter(Boolean).join("\n");
    console.error(`[verify:ghcr] Failed to pull ${image}`);
    console.error(output);
    if (/unauthorized|authentication required|denied|credential/i.test(output)) {
      console.error("[verify:ghcr] Private package fallback:");
      console.error('echo "$GITHUB_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin');
      console.error(`docker pull ${image}`);
    }
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { tag } = parseArgs(argv);
  await verifyGhcrImage(tag);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[verify:ghcr] ${message}`);
    process.exitCode = 1;
  });
}
