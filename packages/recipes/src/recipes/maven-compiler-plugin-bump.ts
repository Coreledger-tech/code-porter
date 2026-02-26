import type { ScanResult } from "@code-porter/core/src/models.js";
import type {
  AppliedChange,
  FileMap,
  PlannedEdit,
  Recipe,
  RecipeApplyOutput,
  RecipePlanItem
} from "../types.js";

const TARGET_VERSION = "3.11.0";
const MIN_VERSION = "3.11.0";

function parseVersion(version: string): number[] {
  const cleaned = version.trim();
  const main = cleaned.split("-")[0];
  return main.split(".").map((segment) => Number.parseInt(segment, 10) || 0);
}

function isLowerVersion(current: string, threshold: string): boolean {
  const left = parseVersion(current);
  const right = parseVersion(threshold);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l < r) {
      return true;
    }
    if (l > r) {
      return false;
    }
  }

  return false;
}

function updateCompilerPluginVersion(
  content: string,
  recipeId: string
): {
  updated: string;
  edits: PlannedEdit[];
  advisories: string[];
} {
  const edits: PlannedEdit[] = [];
  const advisories: string[] = [];

  const pluginBlockRegex = /<plugin>[\s\S]*?<\/plugin>/g;
  const pluginBlocks = content.match(pluginBlockRegex) ?? [];

  let foundCompilerPlugin = false;
  let updated = content;

  for (const pluginBlock of pluginBlocks) {
    if (!/<artifactId>\s*maven-compiler-plugin\s*<\/artifactId>/.test(pluginBlock)) {
      continue;
    }

    foundCompilerPlugin = true;

    const versionRegex = /<version>\s*([^<]+)\s*<\/version>/;
    const match = pluginBlock.match(versionRegex);

    if (!match) {
      advisories.push(
        "maven-compiler-plugin exists without <version>; recipe leaves config unchanged"
      );
      continue;
    }

    const currentVersion = match[1].trim();

    if (!isLowerVersion(currentVersion, MIN_VERSION)) {
      advisories.push(
        `maven-compiler-plugin version (${currentVersion}) already meets Java 17 baseline`
      );
      continue;
    }

    edits.push({
      filePath: "pom.xml",
      recipeId,
      description: `Bump maven-compiler-plugin version from ${currentVersion} to ${TARGET_VERSION}`,
      lineDelta: 2,
      changeType: "update",
      before: `<version>${currentVersion}</version>`,
      after: `<version>${TARGET_VERSION}</version>`
    });

    const updatedBlock = pluginBlock.replace(
      versionRegex,
      `<version>${TARGET_VERSION}</version>`
    );
    updated = updated.replace(pluginBlock, updatedBlock);
  }

  if (!foundCompilerPlugin) {
    advisories.push("maven-compiler-plugin not configured; no-op");
  }

  return { updated, edits, advisories };
}

export class MavenCompilerPluginBumpRecipe implements Recipe {
  readonly id = "java.maven.compiler-plugin-bump";

  appliesTo(scan: ScanResult): boolean {
    return scan.buildSystem === "maven";
  }

  plan(files: FileMap): RecipePlanItem {
    const pom = files["pom.xml"];
    if (!pom) {
      return {
        recipeId: this.id,
        explanation: this.explain(),
        edits: [],
        advisories: ["pom.xml not found; recipe skipped"]
      };
    }

    const result = updateCompilerPluginVersion(pom, this.id);
    return {
      recipeId: this.id,
      explanation: this.explain(),
      edits: result.edits,
      advisories: result.advisories
    };
  }

  apply(files: FileMap): RecipeApplyOutput {
    const pom = files["pom.xml"];
    if (!pom) {
      return {
        files,
        changes: [],
        advisories: ["pom.xml not found; no changes applied"]
      };
    }

    const result = updateCompilerPluginVersion(pom, this.id);
    if (result.updated === pom) {
      return {
        files,
        changes: [
          {
            filePath: "pom.xml",
            recipeId: this.id,
            description: "No compiler plugin bump required",
            changed: false,
            addedLines: 0,
            removedLines: 0
          }
        ],
        advisories: result.advisories
      };
    }

    const changedLines = result.edits.reduce((sum, edit) => sum + edit.lineDelta, 0);

    const change: AppliedChange = {
      filePath: "pom.xml",
      recipeId: this.id,
      description: `Updated maven-compiler-plugin to ${TARGET_VERSION}`,
      changed: true,
      addedLines: changedLines / 2,
      removedLines: changedLines / 2
    };

    return {
      files: {
        ...files,
        "pom.xml": result.updated
      },
      changes: [change],
      advisories: result.advisories
    };
  }

  explain(): string {
    return "Bump legacy maven-compiler-plugin versions to a Java 17-ready baseline (3.11.0) when the configured version is too old.";
  }
}
