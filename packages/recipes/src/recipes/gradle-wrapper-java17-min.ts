import type { ScanResult } from "@code-porter/core/src/models.js";
import type {
  AppliedChange,
  FileMap,
  PlannedEdit,
  Recipe,
  RecipeApplyOutput,
  RecipePlanItem
} from "../types.js";

const WRAPPER_FILE = "gradle/wrapper/gradle-wrapper.properties";
const MIN_WRAPPER_VERSION = "7.6.4";
const DISTRIBUTION_REGEX = /(distributionUrl\s*=.*gradle-)(\d+\.\d+(?:\.\d+)?)(-[^\\\n]*)/i;

function parseVersion(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function isLowerVersion(current: string, target: string): boolean {
  const currentParts = parseVersion(current);
  const targetParts = parseVersion(target);
  const maxLength = Math.max(currentParts.length, targetParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const currentValue = currentParts[index] ?? 0;
    const targetValue = targetParts[index] ?? 0;
    if (currentValue === targetValue) {
      continue;
    }
    return currentValue < targetValue;
  }

  return false;
}

function updateWrapperVersion(
  content: string,
  recipeId: string
): {
  updated: string;
  edits: PlannedEdit[];
  advisories: string[];
} {
  const match = content.match(DISTRIBUTION_REGEX);
  if (!match) {
    return {
      updated: content,
      edits: [],
      advisories: ["Gradle wrapper distributionUrl not found; no-op"]
    };
  }

  const currentVersion = match[2];
  if (!isLowerVersion(currentVersion, MIN_WRAPPER_VERSION)) {
    return {
      updated: content,
      edits: [],
      advisories: [`Gradle wrapper version ${currentVersion} already meets Java 17 minimum`]
    };
  }

  const updated = content.replace(DISTRIBUTION_REGEX, `$1${MIN_WRAPPER_VERSION}$3`);
  return {
    updated,
    edits: [
      {
        filePath: WRAPPER_FILE,
        recipeId,
        description: `Bump Gradle wrapper from ${currentVersion} to ${MIN_WRAPPER_VERSION}`,
        lineDelta: 2,
        changeType: "update",
        before: `gradle-${currentVersion}`,
        after: `gradle-${MIN_WRAPPER_VERSION}`
      }
    ],
    advisories: [
      `Updated gradle-wrapper distribution from ${currentVersion} to ${MIN_WRAPPER_VERSION} for Java 17 compatibility`
    ]
  };
}

export class GradleWrapperJava17MinRecipe implements Recipe {
  readonly id = "java.gradle.wrapper-java17-min";

  appliesTo(scan: ScanResult): boolean {
    return scan.buildSystem === "gradle";
  }

  plan(files: FileMap): RecipePlanItem {
    const wrapper = files[WRAPPER_FILE];
    if (!wrapper) {
      return {
        recipeId: this.id,
        explanation: this.explain(),
        edits: [],
        advisories: ["gradle-wrapper.properties not found; recipe skipped"]
      };
    }

    const result = updateWrapperVersion(wrapper, this.id);
    return {
      recipeId: this.id,
      explanation: this.explain(),
      edits: result.edits,
      advisories: result.advisories
    };
  }

  apply(files: FileMap): RecipeApplyOutput {
    const wrapper = files[WRAPPER_FILE];
    if (!wrapper) {
      return {
        files,
        changes: [],
        advisories: ["gradle-wrapper.properties not found; no changes applied"]
      };
    }

    const result = updateWrapperVersion(wrapper, this.id);
    if (result.updated === wrapper) {
      return {
        files,
        changes: [
          {
            filePath: WRAPPER_FILE,
            recipeId: this.id,
            description: "Gradle wrapper already compatible with Java 17",
            changed: false,
            addedLines: 0,
            removedLines: 0
          }
        ],
        advisories: result.advisories
      };
    }

    const change: AppliedChange = {
      filePath: WRAPPER_FILE,
      recipeId: this.id,
      description: `Bumped Gradle wrapper to ${MIN_WRAPPER_VERSION} for Java 17 compatibility`,
      changed: true,
      addedLines: 1,
      removedLines: 1
    };

    return {
      files: {
        ...files,
        [WRAPPER_FILE]: result.updated
      },
      changes: [change],
      advisories: result.advisories
    };
  }

  explain(): string {
    return "Bump existing Gradle wrapper distributionUrl to a Java 17-compatible minimum version without changing plugin/dependency declarations.";
  }
}
