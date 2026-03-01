import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RC_TAG_PATTERN = /^v\d+\.\d+\.\d+-rc\.\d+$/;

export function parseReleaseRcArgs(argv: string[]): { tag: string } {
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--tag") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --tag. Example: npm run release:rc -- --tag v1.0.0-rc.2");
      }
      return { tag: validateRcTag(next) };
    }

    if (current.startsWith("--tag=")) {
      return { tag: validateRcTag(current.slice("--tag=".length)) };
    }
  }

  throw new Error("Missing required --tag argument. Example: npm run release:rc -- --tag v1.0.0-rc.2");
}

export function validateRcTag(tag: string): string {
  const trimmed = tag.trim();
  if (!RC_TAG_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid RC tag '${tag}'. Expected format: v<major>.<minor>.<patch>-rc.<n>`
    );
  }

  return trimmed;
}

function runChecked(command: string, args: string[], options?: { capture?: boolean }): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options?.capture ? "pipe" : "inherit"
  });

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}${output ? `\n${output}` : ""}`
    );
  }

  return (result.stdout ?? "").trim();
}

function assertCleanTree(): void {
  const status = runChecked("git", ["status", "--porcelain"], { capture: true });
  if (status.length > 0) {
    throw new Error(
      "Git working tree is not clean. Move local artifacts (for example local PDFs) outside the repo or commit/stash changes before running release:rc."
    );
  }
}

function assertMainBranch(): void {
  const branch = runChecked("git", ["branch", "--show-current"], { capture: true });
  if (branch !== "main") {
    throw new Error(`release:rc must run from main. Current branch: ${branch}`);
  }
}

function assertTagMissing(tag: string): void {
  const tagMatch = runChecked("git", ["tag", "--list", tag], { capture: true });
  if (tagMatch === tag) {
    throw new Error(`Tag '${tag}' already exists.`);
  }
}

export function main(argv = process.argv.slice(2)): void {
  const { tag } = parseReleaseRcArgs(argv);

  console.log(`[release:rc] validating git state for ${tag}...`);
  assertCleanTree();
  assertMainBranch();
  assertTagMissing(tag);

  console.log("[release:rc] running typecheck...");
  runChecked("npm", ["run", "typecheck"]);

  console.log("[release:rc] running test suite...");
  runChecked("npm", ["test"]);

  console.log("[release:rc] running integration suite...");
  runChecked("npm", ["run", "test:integration"]);

  console.log(`[release:rc] creating local annotated tag ${tag}...`);
  runChecked("git", ["tag", "-a", tag, "-m", `Code Porter ${tag}`]);

  console.log("");
  console.log(`[release:rc] local tag created: ${tag}`);
  console.log("[release:rc] next steps:");
  console.log("  git push origin main");
  console.log(`  git push origin ${tag}`);
  console.log("  Verify GitHub Actions docker-publish workflow for tag v*");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[release:rc] ${message}`);
    process.exit(1);
  }
}
