import type { ScanResult } from "@code-porter/core/src/models.js";
import type { AppliedChange, FileMap, PlannedEdit, Recipe, RecipeApplyOutput, RecipePlanItem } from "../types.js";

const TARGET_VERSION = "17";

function replaceTagValue(
  content: string,
  tagName: string,
  nextValue: string,
  recipeId: string,
  edits: PlannedEdit[]
): string {
  const escapedTag = tagName.replace(/\./g, "\\.");
  const regex = new RegExp(`<${escapedTag}>\\s*([^<]+)\\s*</${escapedTag}>`, "g");

  return content.replace(regex, (fullMatch, currentValue: string) => {
    if (currentValue.trim() === nextValue) {
      return fullMatch;
    }

    edits.push({
      filePath: "pom.xml",
      recipeId,
      description: `Set <${tagName}> to ${nextValue}`,
      lineDelta: 2,
      changeType: "update",
      before: `<${tagName}>${currentValue.trim()}</${tagName}>`,
      after: `<${tagName}>${nextValue}</${tagName}>`
    });

    return `<${tagName}>${nextValue}</${tagName}>`;
  });
}

function replaceCompilerPluginTag(
  content: string,
  tagName: "source" | "target",
  nextValue: string,
  recipeId: string,
  edits: PlannedEdit[]
): string {
  const pluginRegex = /<plugin>[\s\S]*?<artifactId>\s*maven-compiler-plugin\s*<\/artifactId>[\s\S]*?<\/plugin>/g;

  return content.replace(pluginRegex, (pluginBlock) => {
    const tagRegex = new RegExp(`<${tagName}>\\s*([^<]+)\\s*</${tagName}>`, "g");

    return pluginBlock.replace(tagRegex, (fullMatch, currentValue: string) => {
      if (currentValue.trim() === nextValue) {
        return fullMatch;
      }

      edits.push({
        filePath: "pom.xml",
        recipeId,
        description: `Set maven-compiler-plugin <${tagName}> to ${nextValue}`,
        lineDelta: 2,
        changeType: "update",
        before: `<${tagName}>${currentValue.trim()}</${tagName}>`,
        after: `<${tagName}>${nextValue}</${tagName}>`
      });

      return `<${tagName}>${nextValue}</${tagName}>`;
    });
  });
}

function transformPom(content: string, recipeId: string): { updated: string; edits: PlannedEdit[] } {
  const edits: PlannedEdit[] = [];

  let updated = content;
  updated = replaceTagValue(updated, "maven.compiler.source", TARGET_VERSION, recipeId, edits);
  updated = replaceTagValue(updated, "maven.compiler.target", TARGET_VERSION, recipeId, edits);
  updated = replaceCompilerPluginTag(updated, "source", TARGET_VERSION, recipeId, edits);
  updated = replaceCompilerPluginTag(updated, "target", TARGET_VERSION, recipeId, edits);

  return { updated, edits };
}

export class MavenCompilerTarget17Recipe implements Recipe {
  readonly id = "java.maven.compiler-target-17";

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

    const { edits } = transformPom(pom, this.id);

    if (edits.length === 0) {
      return {
        recipeId: this.id,
        explanation: this.explain(),
        edits: [],
        advisories: ["Maven compiler source/target already aligned with Java 17"]
      };
    }

    return {
      recipeId: this.id,
      explanation: this.explain(),
      edits,
      advisories: []
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

    const { updated, edits } = transformPom(pom, this.id);
    if (updated === pom) {
      return {
        files,
        changes: [
          {
            filePath: "pom.xml",
            recipeId: this.id,
            description: "No compiler source/target updates required",
            changed: false,
            addedLines: 0,
            removedLines: 0
          }
        ],
        advisories: ["No compiler source/target updates were required"]
      };
    }

    const nextFiles: FileMap = { ...files, "pom.xml": updated };
    const changedLines = edits.reduce((sum, edit) => sum + edit.lineDelta, 0);

    const change: AppliedChange = {
      filePath: "pom.xml",
      recipeId: this.id,
      description: "Aligned Maven compiler source/target to Java 17",
      changed: true,
      addedLines: changedLines / 2,
      removedLines: changedLines / 2
    };

    return {
      files: nextFiles,
      changes: [change],
      advisories: []
    };
  }

  explain(): string {
    return "Upgrade Maven compiler source/target declarations to Java 17 to prepare for LTS modernization and reduce runtime drift.";
  }
}
