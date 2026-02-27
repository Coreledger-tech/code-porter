import { spawnSync } from "node:child_process";

const RC_TAG = "v1.0.0-rc.1";

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

function main(): void {
  console.log(`[release:rc] validating git state for ${RC_TAG}...`);
  assertCleanTree();
  assertMainBranch();
  assertTagMissing(RC_TAG);

  console.log("[release:rc] running typecheck...");
  runChecked("npm", ["run", "typecheck"]);

  console.log("[release:rc] running test suite...");
  runChecked("npm", ["test"]);

  console.log("[release:rc] running integration suite...");
  runChecked("npm", ["run", "test:integration"]);

  console.log(`[release:rc] creating local annotated tag ${RC_TAG}...`);
  runChecked("git", ["tag", "-a", RC_TAG, "-m", `Code Porter ${RC_TAG}`]);

  console.log("");
  console.log(`[release:rc] local tag created: ${RC_TAG}`);
  console.log("[release:rc] next steps:");
  console.log("  git push origin main");
  console.log(`  git push origin ${RC_TAG}`);
  console.log("  Verify GitHub Actions docker-publish workflow for tag v*");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[release:rc] ${message}`);
  process.exit(1);
}
