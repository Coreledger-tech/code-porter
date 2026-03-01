import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  BuildSystem,
  BuildSystemDetection,
  BuildSystemDisposition,
  ScanResult
} from "../models.js";

const execFileAsync = promisify(execFile);

const MAX_SCAN_DEPTH = 2;
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "target",
  "build",
  "dist",
  ".venv",
  "vendor",
  "__pycache__"
]);

const BUILD_SYSTEM_PRIORITY: Record<Exclude<BuildSystem, "unknown">, number> = {
  maven: 0,
  gradle: 1,
  node: 2,
  python: 3,
  go: 4
};

const BUILD_SYSTEM_MANIFESTS: Array<{
  buildSystem: Exclude<BuildSystem, "unknown">;
  files: string[];
}> = [
  { buildSystem: "maven", files: ["pom.xml", "mvnw"] },
  {
    buildSystem: "gradle",
    files: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradlew"]
  },
  { buildSystem: "node", files: ["package.json"] },
  { buildSystem: "python", files: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"] },
  { buildSystem: "go", files: ["go.mod"] }
];

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function getGitBranch(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoPath
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function normalizeRelativePath(path: string): string {
  if (path === "." || path.length === 0) {
    return ".";
  }
  return path.split(sep).join("/");
}

async function listDirectoryEntries(repoPath: string, depth = 0, currentRelative = "."): Promise<
  Array<{
    depth: number;
    buildRoot: string;
    fileNames: string[];
  }>
> {
  const currentAbsolute = currentRelative === "." ? repoPath : join(repoPath, currentRelative);
  const entries = await readdir(currentAbsolute, { withFileTypes: true });
  const sortedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name));

  const directories = [
    {
      depth,
      buildRoot: currentRelative,
      fileNames: sortedEntries.map((entry) => entry.name)
    }
  ];

  if (depth >= MAX_SCAN_DEPTH) {
    return directories;
  }

  for (const entry of sortedEntries) {
    if (!entry.isDirectory() || EXCLUDED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const childRelative =
      currentRelative === "." ? entry.name : join(currentRelative, entry.name);
    directories.push(...(await listDirectoryEntries(repoPath, depth + 1, childRelative)));
  }

  return directories;
}

function detectProjects(
  directoryEntries: Array<{ depth: number; buildRoot: string; fileNames: string[] }>
): BuildSystemDetection[] {
  const detections: BuildSystemDetection[] = [];

  for (const directory of directoryEntries) {
    for (const rule of BUILD_SYSTEM_MANIFESTS) {
      const manifest = rule.files.find((fileName) => directory.fileNames.includes(fileName));
      if (!manifest) {
        continue;
      }

      detections.push({
        buildSystem: rule.buildSystem,
        buildRoot: normalizeRelativePath(directory.buildRoot),
        manifestPath: normalizeRelativePath(
          directory.buildRoot === "." ? manifest : join(directory.buildRoot, manifest)
        ),
        depth: directory.depth
      });
    }
  }

  return detections.sort((left, right) => {
    if (left.depth !== right.depth) {
      return left.depth - right.depth;
    }

    const priorityDelta =
      BUILD_SYSTEM_PRIORITY[left.buildSystem as Exclude<BuildSystem, "unknown">] -
      BUILD_SYSTEM_PRIORITY[right.buildSystem as Exclude<BuildSystem, "unknown">];
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    return left.manifestPath.localeCompare(right.manifestPath);
  });
}

function selectPrimaryProject(
  detections: BuildSystemDetection[]
): BuildSystemDetection | null {
  return detections[0] ?? null;
}

async function hasSelectedTests(repoPath: string, buildRoot: string | null): Promise<boolean> {
  if (!buildRoot) {
    return false;
  }

  const absoluteBuildRoot = buildRoot === "." ? repoPath : join(repoPath, buildRoot);
  const directoryChecks = [
    join(absoluteBuildRoot, "src", "test"),
    join(absoluteBuildRoot, "test"),
    join(absoluteBuildRoot, "tests"),
    join(absoluteBuildRoot, "__tests__")
  ];

  const directoryMatches = await Promise.all(directoryChecks.map((path) => fileExists(path)));
  if (directoryMatches.some(Boolean)) {
    return true;
  }

  try {
    const entries = await readdir(absoluteBuildRoot, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name.endsWith("_test.go"));
  } catch {
    return false;
  }
}

function buildDisposition(
  selectedProject: BuildSystemDetection | null
): { buildSystem: BuildSystem; disposition: BuildSystemDisposition; reason: string } {
  if (!selectedProject) {
    return {
      buildSystem: "unknown",
      disposition: "no_supported_manifest",
      reason: "No supported build manifest found in root or depth<=2"
    };
  }

  return {
    buildSystem: selectedProject.buildSystem,
    disposition: "supported",
    reason: `Selected build system '${selectedProject.buildSystem}' from '${selectedProject.manifestPath}'`
  };
}

export async function runScanStep(repoPath: string): Promise<ScanResult> {
  const repoRoot = resolve(repoPath);
  const [directoryEntries, mvn, gradle, npm, node, gitBranch] = await Promise.all([
    listDirectoryEntries(repoRoot),
    commandExists("mvn"),
    commandExists("gradle"),
    commandExists("npm"),
    commandExists("node"),
    getGitBranch(repoRoot)
  ]);

  const detectedProjects = detectProjects(directoryEntries);
  const selectedProject = selectPrimaryProject(detectedProjects);
  const disposition = buildDisposition(selectedProject);
  const detectedFiles = [...new Set(detectedProjects.map((project) => project.manifestPath))];
  const detectedBuildSystems = [...new Set(detectedProjects.map((project) => project.buildSystem))];

  return {
    buildSystem: disposition.buildSystem,
    hasTests: await hasSelectedTests(repoRoot, selectedProject?.buildRoot ?? null),
    metadata: {
      gitBranch,
      toolAvailability: {
        mvn,
        gradle,
        npm,
        node
      },
      detectedFiles,
      detectedBuildSystems,
      detectedProjects,
      selectedManifestPath: selectedProject?.manifestPath ?? null,
      selectedBuildRoot: selectedProject?.buildRoot ?? null,
      buildSystemDisposition: disposition.disposition,
      buildSystemReason: disposition.reason
    }
  };
}
