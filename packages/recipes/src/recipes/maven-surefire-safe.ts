import type { ScanResult } from "@code-porter/core/src/models.js";
import type {
  AppliedChange,
  FileMap,
  PlannedEdit,
  Recipe,
  RecipeApplyOutput,
  RecipePlanItem
} from "../types.js";

const TARGET_SUREFIRE_VERSION = "3.2.5";

function updateSurefire(content: string, recipeId: string): {
  updated: string;
  edits: PlannedEdit[];
  advisories: string[];
} {
  const edits: PlannedEdit[] = [];
  const advisories: string[] = [];

  const pluginRegex = /<plugin>[\s\S]*?<artifactId>\s*maven-surefire-plugin\s*<\/artifactId>[\s\S]*?<\/plugin>/g;

  let foundPlugin = false;
  let updated = content.replace(pluginRegex, (pluginBlock) => {
    foundPlugin = true;
    const versionRegex = /<version>\s*([^<]+)\s*<\/version>/;
    const match = pluginBlock.match(versionRegex);

    if (!match) {
      advisories.push(
        "maven-surefire-plugin exists without <version>; recipe leaves config unchanged for safety"
      );
      return pluginBlock;
    }

    const currentVersion = match[1].trim();
    if (currentVersion === TARGET_SUREFIRE_VERSION) {
      advisories.push("maven-surefire-plugin version already aligned");
      return pluginBlock;
    }

    edits.push({
      filePath: "pom.xml",
      recipeId,
      description: `Update maven-surefire-plugin version to ${TARGET_SUREFIRE_VERSION}`,
      lineDelta: 2,
      changeType: "update",
      before: `<version>${currentVersion}</version>`,
      after: `<version>${TARGET_SUREFIRE_VERSION}</version>`
    });

    return pluginBlock.replace(versionRegex, `<version>${TARGET_SUREFIRE_VERSION}</version>`);
  });

  if (!foundPlugin) {
    advisories.push("maven-surefire-plugin not configured; safe no-op applied");
    updated = content;
  }

  return { updated, edits, advisories };
}

export class MavenSurefireSafeRecipe implements Recipe {
  readonly id = "java.maven.surefire-safe-version";

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

    const result = updateSurefire(pom, this.id);

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

    const result = updateSurefire(pom, this.id);
    if (result.updated === pom) {
      return {
        files,
        changes: [
          {
            filePath: "pom.xml",
            recipeId: this.id,
            description: "No surefire version update required",
            changed: false,
            addedLines: 0,
            removedLines: 0
          }
        ],
        advisories: result.advisories
      };
    }

    const nextFiles: FileMap = { ...files, "pom.xml": result.updated };
    const changedLines = result.edits.reduce((sum, edit) => sum + edit.lineDelta, 0);

    const change: AppliedChange = {
      filePath: "pom.xml",
      recipeId: this.id,
      description: `Updated maven-surefire-plugin version to ${TARGET_SUREFIRE_VERSION}`,
      changed: true,
      addedLines: changedLines / 2,
      removedLines: changedLines / 2
    };

    return {
      files: nextFiles,
      changes: [change],
      advisories: result.advisories
    };
  }

  explain(): string {
    return "Safely align existing Maven Surefire plugin declarations to a stable version without injecting behavior-changing test configuration.";
  }
}
