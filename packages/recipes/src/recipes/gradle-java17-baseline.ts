import type { ScanResult } from "@code-porter/core/src/models.js";
import type {
  AppliedChange,
  FileMap,
  PlannedEdit,
  Recipe,
  RecipeApplyOutput,
  RecipePlanItem
} from "../types.js";

const TARGET = "JavaVersion.VERSION_17";
const TARGET_TOOLCHAIN = "JavaLanguageVersion.of(17)";
const TARGET_TOOLCHAIN_SET = "languageVersion.set(JavaLanguageVersion.of(17))";

function selectGradleFile(files: FileMap): "build.gradle" | "build.gradle.kts" | null {
  if (files["build.gradle"]) {
    return "build.gradle";
  }
  if (files["build.gradle.kts"]) {
    return "build.gradle.kts";
  }
  return null;
}

function replaceAll(input: {
  content: string;
  recipeId: string;
  filePath: string;
  patterns: Array<{
    regex: RegExp;
    replace: string | ((substring: string, ...args: string[]) => string);
    description: string;
  }>;
}): {
  updated: string;
  edits: PlannedEdit[];
} {
  let updated = input.content;
  const edits: PlannedEdit[] = [];

  for (const pattern of input.patterns) {
    updated = updated.replace(pattern.regex, (...args) => {
      const match = args[0] as string;
      const groups = args.slice(1, -2) as string[];
      const replacement =
        typeof pattern.replace === "function"
          ? pattern.replace(match, ...groups)
          : pattern.replace;
      if (replacement !== match) {
        edits.push({
          filePath: input.filePath,
          recipeId: input.recipeId,
          description: pattern.description,
          lineDelta: 2,
          changeType: "update",
          before: match,
          after: replacement
        });
      }
      return replacement;
    });
  }

  return { updated, edits };
}

function updateGradleJavaVersion(
  filePath: "build.gradle" | "build.gradle.kts",
  content: string,
  recipeId: string
): {
  updated: string;
  edits: PlannedEdit[];
  advisories: string[];
} {
  const patterns = [
    {
      regex: /(sourceCompatibility\s*=\s*)JavaVersion\.VERSION_(?:1_8|11)\b/g,
      replace: (_match: string, prefix: string) => `${prefix}${TARGET}`,
      description: "Align sourceCompatibility to Java 17"
    },
    {
      regex: /(targetCompatibility\s*=\s*)JavaVersion\.VERSION_(?:1_8|11)\b/g,
      replace: (_match: string, prefix: string) => `${prefix}${TARGET}`,
      description: "Align targetCompatibility to Java 17"
    },
    {
      regex: /(sourceCompatibility\s*=\s*)(?:"1\.8"|'1\.8'|1\.8|"11"|'11'|11)\b/g,
      replace: (_match: string, prefix: string) => `${prefix}${TARGET}`,
      description: "Align numeric sourceCompatibility to Java 17"
    },
    {
      regex: /(targetCompatibility\s*=\s*)(?:"1\.8"|'1\.8'|1\.8|"11"|'11'|11)\b/g,
      replace: (_match: string, prefix: string) => `${prefix}${TARGET}`,
      description: "Align numeric targetCompatibility to Java 17"
    },
    {
      regex: /(languageVersion\s*=\s*)JavaLanguageVersion\.of\(\s*(?:8|11)\s*\)/g,
      replace: (_match: string, prefix: string) => `${prefix}${TARGET_TOOLCHAIN}`,
      description: "Align Gradle Java toolchain to Java 17"
    },
    {
      regex: /languageVersion\.set\(JavaLanguageVersion\.of\(\s*(?:8|11)\s*\)\)/g,
      replace: TARGET_TOOLCHAIN_SET,
      description: "Align Gradle Kotlin DSL toolchain to Java 17"
    }
  ];

  const result = replaceAll({
    content,
    recipeId,
    filePath,
    patterns
  });

  return {
    updated: result.updated,
    edits: result.edits,
    advisories:
      result.edits.length > 0
        ? ["Updated existing Gradle Java baseline declarations to Java 17"]
        : ["No existing Gradle Java baseline declarations required updates"]
  };
}

export class GradleJava17BaselineRecipe implements Recipe {
  readonly id = "java.gradle.java17-baseline";

  appliesTo(scan: ScanResult): boolean {
    return scan.buildSystem === "gradle" && scan.metadata.gradleProjectType === "jvm";
  }

  plan(files: FileMap): RecipePlanItem {
    const filePath = selectGradleFile(files);
    if (!filePath) {
      return {
        recipeId: this.id,
        explanation: this.explain(),
        edits: [],
        advisories: ["No Gradle build file found; recipe skipped"]
      };
    }

    const result = updateGradleJavaVersion(filePath, files[filePath], this.id);
    return {
      recipeId: this.id,
      explanation: this.explain(),
      edits: result.edits,
      advisories: result.advisories
    };
  }

  apply(files: FileMap): RecipeApplyOutput {
    const filePath = selectGradleFile(files);
    if (!filePath) {
      return {
        files,
        changes: [],
        advisories: ["No Gradle build file found; no changes applied"]
      };
    }

    const result = updateGradleJavaVersion(filePath, files[filePath], this.id);
    if (result.updated === files[filePath]) {
      return {
        files,
        changes: [
          {
            filePath,
            recipeId: this.id,
            description: "No Gradle Java 17 baseline update required",
            changed: false,
            addedLines: 0,
            removedLines: 0
          }
        ],
        advisories: result.advisories
      };
    }

    const changedLines = result.edits.length;
    const change: AppliedChange = {
      filePath,
      recipeId: this.id,
      description: "Updated existing Gradle Java baseline declarations to Java 17",
      changed: true,
      addedLines: changedLines,
      removedLines: changedLines
    };

    return {
      files: {
        ...files,
        [filePath]: result.updated
      },
      changes: [change],
      advisories: result.advisories
    };
  }

  explain(): string {
    return "Update existing Gradle JVM Java compatibility and toolchain declarations to Java 17 without inserting new blocks or touching Android DSL configuration.";
  }
}
