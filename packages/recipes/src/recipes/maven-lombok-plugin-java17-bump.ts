import type { ScanResult } from "@code-porter/core/src/models.js";
import type {
  AppliedChange,
  FileMap,
  PlannedEdit,
  Recipe,
  RecipeApplyOutput,
  RecipePlanItem
} from "../types.js";

const TARGET_VERSION = "1.18.20.0";
const MIN_VERSION = "1.18.20.0";

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

function updateLombokPluginVersion(
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

  let foundLombokPlugin = false;
  let updated = content;

  for (const pluginBlock of pluginBlocks) {
    if (
      !/<groupId>\s*org\.projectlombok\s*<\/groupId>/.test(pluginBlock) ||
      !/<artifactId>\s*lombok-maven-plugin\s*<\/artifactId>/.test(pluginBlock)
    ) {
      continue;
    }

    foundLombokPlugin = true;

    const versionRegex = /<version>\s*([^<]+)\s*<\/version>/;
    const match = pluginBlock.match(versionRegex);

    if (!match) {
      advisories.push(
        "lombok-maven-plugin exists without <version>; recipe leaves config unchanged"
      );
      advisories.push(
        "Lombok dependency versions are intentionally left unchanged by this recipe"
      );
      continue;
    }

    const currentVersion = match[1].trim();
    if (!isLowerVersion(currentVersion, MIN_VERSION)) {
      advisories.push(
        `lombok-maven-plugin version (${currentVersion}) already meets Java 17 baseline`
      );
      advisories.push(
        "Lombok dependency versions are intentionally left unchanged by this recipe"
      );
      continue;
    }

    edits.push({
      filePath: "pom.xml",
      recipeId,
      description: `Bump lombok-maven-plugin version from ${currentVersion} to ${TARGET_VERSION}`,
      lineDelta: 2,
      changeType: "update",
      before: `<version>${currentVersion}</version>`,
      after: `<version>${TARGET_VERSION}</version>`
    });

    advisories.push(
      `Updated lombok-maven-plugin from ${currentVersion} to ${TARGET_VERSION} for Java 17 compatibility`
    );
    advisories.push(
      "Lombok dependency versions are intentionally left unchanged by this recipe"
    );

    const updatedBlock = pluginBlock.replace(versionRegex, `<version>${TARGET_VERSION}</version>`);
    updated = updated.replace(pluginBlock, updatedBlock);
  }

  if (!foundLombokPlugin) {
    advisories.push("lombok-maven-plugin not configured; no-op");
    advisories.push(
      "Lombok dependency versions are intentionally left unchanged by this recipe"
    );
  }

  return { updated, edits, advisories };
}

export class MavenLombokPluginJava17BumpRecipe implements Recipe {
  readonly id = "java.maven.lombok-plugin-java17-bump";

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

    const result = updateLombokPluginVersion(pom, this.id);
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

    const result = updateLombokPluginVersion(pom, this.id);
    if (result.updated === pom) {
      return {
        files,
        changes: [
          {
            filePath: "pom.xml",
            recipeId: this.id,
            description: "No lombok plugin bump required",
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
      description: `Updated lombok-maven-plugin to ${TARGET_VERSION}`,
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
    return "Update an existing lombok-maven-plugin declaration to a Java 17-compatible baseline when the configured plugin version is too old. This recipe is conservative and does not rewrite Lombok dependency versions.";
  }
}
