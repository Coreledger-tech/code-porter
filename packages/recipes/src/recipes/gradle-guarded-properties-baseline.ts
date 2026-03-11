import type { ScanResult } from "@code-porter/core/src/models.js";
import type {
  AppliedChange,
  FileMap,
  PlannedEdit,
  Recipe,
  RecipeApplyOutput,
  RecipePlanItem
} from "../types.js";

const GRADLE_PROPERTIES_PATH = "gradle.properties";
const REQUIRED_PROPERTIES: Array<{ key: string; value: string }> = [
  { key: "org.gradle.java.installations.auto-detect", value: "true" },
  { key: "org.gradle.java.installations.auto-download", value: "true" }
];

function propertyPattern(key: string): RegExp {
  return new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*=\\s*(.*)\\s*$`);
}

function normalizeProperties(content: string | undefined): {
  updated: string;
  changed: boolean;
  touched: string[];
} {
  const hadFile = typeof content === "string";
  const source = content ?? "";
  const lines = source.length > 0 ? source.split("\n") : [];

  let changed = !hadFile;
  const touched = new Set<string>();

  for (const required of REQUIRED_PROPERTIES) {
    const regex = propertyPattern(required.key);
    const nextLines: string[] = [];
    let seen = false;

    for (const line of lines) {
      const match = line.match(regex);
      if (!match) {
        nextLines.push(line);
        continue;
      }

      if (!seen) {
        seen = true;
        const normalized = `${required.key}=${required.value}`;
        nextLines.push(normalized);
        if (line.trim() !== normalized) {
          changed = true;
          touched.add(required.key);
        }
      } else {
        changed = true;
        touched.add(required.key);
      }
    }

    lines.length = 0;
    lines.push(...nextLines);

    if (!seen) {
      lines.push(`${required.key}=${required.value}`);
      changed = true;
      touched.add(required.key);
    }
  }

  return {
    updated: lines.join("\n"),
    changed,
    touched: [...touched]
  };
}

function buildResult(files: FileMap, recipeId: string): {
  nextFiles: FileMap;
  edits: PlannedEdit[];
  changes: AppliedChange[];
  advisories: string[];
} {
  const nextFiles: FileMap = { ...files };
  const edits: PlannedEdit[] = [];
  const changes: AppliedChange[] = [];
  const advisories: string[] = [];

  const current = files[GRADLE_PROPERTIES_PATH];
  const normalized = normalizeProperties(current);

  if (!normalized.changed) {
    changes.push({
      filePath: GRADLE_PROPERTIES_PATH,
      recipeId,
      description: "Gradle guarded baseline properties already set",
      changed: false,
      addedLines: 0,
      removedLines: 0
    });
    advisories.push("Gradle guarded baseline properties already configured");
    return { nextFiles, edits, changes, advisories };
  }

  nextFiles[GRADLE_PROPERTIES_PATH] = normalized.updated;
  edits.push({
    filePath: GRADLE_PROPERTIES_PATH,
    recipeId,
    description: "Ensure guarded Android Gradle baseline java-installation properties",
    lineDelta: 4,
    changeType: "update",
    before: current ?? "",
    after: normalized.updated
  });
  changes.push({
    filePath: GRADLE_PROPERTIES_PATH,
    recipeId,
    description: "Set deterministic guarded Android Gradle java-installation properties",
    changed: true,
    addedLines: normalized.touched.length,
    removedLines: current ? normalized.touched.length : 0
  });
  advisories.push(
    `Ensured guarded baseline gradle.properties keys: ${REQUIRED_PROPERTIES.map((entry) => entry.key).join(", ")}`
  );

  return { nextFiles, edits, changes, advisories };
}

export class GradleGuardedPropertiesBaselineRecipe implements Recipe {
  readonly id = "java.gradle.guarded-properties-baseline";

  appliesTo(scan: ScanResult): boolean {
    return scan.buildSystem === "gradle";
  }

  plan(files: FileMap): RecipePlanItem {
    const result = buildResult(files, this.id);
    return {
      recipeId: this.id,
      explanation: this.explain(),
      edits: result.edits,
      advisories: result.advisories
    };
  }

  apply(files: FileMap): RecipeApplyOutput {
    const result = buildResult(files, this.id);
    return {
      files: result.nextFiles,
      changes: result.changes,
      advisories: result.advisories
    };
  }

  explain(): string {
    return "Ensure deterministic gradle.properties baseline for guarded Android Java installation discovery/download without changing build scripts or dependencies.";
  }
}
