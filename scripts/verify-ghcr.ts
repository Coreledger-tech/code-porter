import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function parseArgs(argv: string[]): { tag: string; platform?: string } {
  const tagFlagIndex = argv.findIndex((arg) => arg === "--tag");
  if (tagFlagIndex === -1 || tagFlagIndex + 1 >= argv.length) {
    throw new Error("Usage: npm run verify:ghcr -- --tag <release-tag>");
  }

  const tag = argv[tagFlagIndex + 1]?.trim();
  if (!tag) {
    throw new Error("Release tag must be non-empty");
  }

  const platformFlagIndex = argv.findIndex((arg) => arg === "--platform");
  if (platformFlagIndex === -1) {
    return { tag };
  }

  if (platformFlagIndex + 1 >= argv.length) {
    throw new Error("Platform must be provided after --platform");
  }

  const platform = argv[platformFlagIndex + 1]?.trim();
  if (!platform) {
    throw new Error("Platform must be non-empty");
  }

  return { tag, platform };
}

function normalizeErrorOutput(error: unknown): string {
  const typed = error as {
    stdout?: string;
    stderr?: string;
    message?: string;
  };

  return [typed.stdout, typed.stderr, typed.message].filter(Boolean).join("\n");
}

function buildPullArgs(image: string, platform?: string): string[] {
  const args = ["pull"];
  if (platform) {
    args.push("--platform", platform);
  }
  args.push(image);
  return args;
}

async function pullImage(image: string, dockerConfigDir: string, platform?: string): Promise<void> {
  await execFileAsync("docker", buildPullArgs(image, platform), {
    env: {
      ...process.env,
      DOCKER_CONFIG: dockerConfigDir
    },
    timeout: 10 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024
  });
}

export async function verifyGhcrImage(tag: string, platform?: string): Promise<void> {
  const image = `ghcr.io/coreledger-tech/code-porter:${tag}`;
  const dockerConfigDir = mkdtempSync(join(tmpdir(), "code-porter-ghcr-"));

  try {
    await pullImage(image, dockerConfigDir, platform);
    if (platform) {
      console.log(`[verify:ghcr] Pulled ${image} using platform ${platform}`);
      return;
    }
    console.log(`[verify:ghcr] Pulled ${image}`);
    return;
  } catch (error) {
    const output = normalizeErrorOutput(error);

    // Existing RC tags may be single-arch (amd64). Allow a deterministic arm64 fallback.
    if (!platform && /no matching manifest/i.test(output)) {
      const fallbackPlatform = "linux/amd64";
      console.error(
        `[verify:ghcr] No matching manifest for host platform. Retrying with ${fallbackPlatform}...`
      );
      try {
        await pullImage(image, dockerConfigDir, fallbackPlatform);
        console.log(`[verify:ghcr] Pulled ${image} using fallback platform ${fallbackPlatform}`);
        return;
      } catch (fallbackError) {
        const fallbackOutput = normalizeErrorOutput(fallbackError);
        console.error(`[verify:ghcr] Failed to pull ${image}`);
        console.error(fallbackOutput);
        throw fallbackError;
      }
    }

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
  const { tag, platform } = parseArgs(argv);
  await verifyGhcrImage(tag, platform);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[verify:ghcr] ${message}`);
    process.exitCode = 1;
  });
}
