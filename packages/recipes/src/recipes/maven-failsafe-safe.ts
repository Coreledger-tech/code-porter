import type { ScanResult } from "@code-porter/core/src/models.js";
import type {
  AppliedChange,
  FileMap,
  PlannedEdit,
  Recipe,
  RecipeApplyOutput,
  RecipePlanItem
} from "../types.js";

const TARGET_FAILSAFE_VERSION = "3.2.5";

function parseVersion(version: string): number[] {
  return version
    .trim()
    .split("-")[0]
    .split(".")
    .map((segment) => Number.parseInt(segment, 10) || 0);
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

function updateFailsafe(content: string, recipeId: string): {
  updated: string;
  edits: PlannedEdit[];
  advisories: string[];
} {
  const edits: PlannedEdit[] = [];
  const advisories: string[] = [];

  const pluginBlockRegex = /<plugin>[\s\S]*?<\/plugin>/g;
  const pluginBlocks = content.match(pluginBlockRegex) ?? [];
  let found = false;
  let updated = content;

  for (const pluginBlock of pluginBlocks) {
    if (!/<artifactId>\s*maven-failsafe-plugin\s*<\/artifactId>/.test(pluginBlock)) {
      continue;
    }
    found = true;

    const versionRegex = /<version>\s*([^<]+)\s*<\/version>/;
    const match = pluginBlock.match(versionRegex);
    if (!match) {
      advisories.push(
        "maven-failsafe-plugin exists without <version>; recipe leaves config unchanged"
      );
      continue;
    }

    const currentVersion = match[1].trim();
    if (!isLowerVersion(currentVersion, TARGET_FAILSAFE_VERSION)) {
      advisories.push(
        `maven-failsafe-plugin version (${currentVersion}) already meets baseline`
      );
      continue;
    }

    edits.push({
      filePath: "pom.xml",
      recipeId,
      description: `Update maven-failsafe-plugin version to ${TARGET_FAILSAFE_VERSION}`,
      lineDelta: 2,
      changeType: "update",
      before: `<version>${currentVersion}</version>`,
      after: `<version>${TARGET_FAILSAFE_VERSION}</version>`
    });

    updated = updated.replace(
      pluginBlock,
      pluginBlock.replace(versionRegex, `<version>${TARGET_FAILSAFE_VERSION}</version>`)
    );
  }

  if (!found) {
    advisories.push("maven-failsafe-plugin not configured; safe no-op applied");
  }

  return { updated, edits, advisories };
}

export class MavenFailsafeSafeRecipe implements Recipe {
  readonly id = "java.maven.failsafe-safe-version";

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

    const result = updateFailsafe(pom, this.id);
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

    const result = updateFailsafe(pom, this.id);
    if (result.updated === pom) {
      return {
        files,
        changes: [
          {
            filePath: "pom.xml",
            recipeId: this.id,
            description: "No failsafe version update required",
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
      description: `Updated maven-failsafe-plugin version to ${TARGET_FAILSAFE_VERSION}`,
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
    return "Safely modernize existing maven-failsafe-plugin version to improve Java 17 compatibility without inserting new plugin config.";
  }
}

