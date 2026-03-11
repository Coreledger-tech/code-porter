import type { ScanResult } from "@code-porter/core/src/models.js";
import type {
  AppliedChange,
  FileMap,
  PlannedEdit,
  Recipe,
  RecipeApplyOutput,
  RecipePlanItem
} from "../types.js";

const JDK_NASHORN_NAMESPACE = /\bjdk\.nashorn\./g;
const OPENJDK_NASHORN_NAMESPACE = "org.openjdk.nashorn.";

function testJavaPaths(files: FileMap): string[] {
  return Object.keys(files)
    .filter((filePath) => filePath.startsWith("src/test/java/") && filePath.endsWith(".java"))
    .sort();
}

function rewriteNamespace(
  files: FileMap,
  recipeId: string
): {
  nextFiles: FileMap;
  edits: PlannedEdit[];
  changes: AppliedChange[];
  advisories: string[];
} {
  const nextFiles: FileMap = { ...files };
  const edits: PlannedEdit[] = [];
  const changes: AppliedChange[] = [];
  const advisories: string[] = [];

  for (const filePath of testJavaPaths(files)) {
    const current = files[filePath];
    JDK_NASHORN_NAMESPACE.lastIndex = 0;
    if (!JDK_NASHORN_NAMESPACE.test(current)) {
      changes.push({
        filePath,
        recipeId,
        description: "No Nashorn namespace rewrite required",
        changed: false,
        addedLines: 0,
        removedLines: 0
      });
      continue;
    }

    JDK_NASHORN_NAMESPACE.lastIndex = 0;
    const updated = current.replace(JDK_NASHORN_NAMESPACE, OPENJDK_NASHORN_NAMESPACE);
    if (updated === current) {
      changes.push({
        filePath,
        recipeId,
        description: "No Nashorn namespace rewrite required",
        changed: false,
        addedLines: 0,
        removedLines: 0
      });
      continue;
    }

    nextFiles[filePath] = updated;
    edits.push({
      filePath,
      recipeId,
      description: "Rewrite test-source Nashorn namespace to org.openjdk",
      lineDelta: 2,
      changeType: "update",
      before: "jdk.nashorn.",
      after: OPENJDK_NASHORN_NAMESPACE
    });
    changes.push({
      filePath,
      recipeId,
      description: "Rewrote test-source Nashorn namespace to org.openjdk",
      changed: true,
      addedLines: 1,
      removedLines: 1
    });
    advisories.push(
      `Matched test-failure signature 'jdk.nashorn.*' in ${filePath}; rewrote to org.openjdk namespace`
    );
  }

  if (advisories.length === 0) {
    advisories.push("No jdk.nashorn references found in src/test/java; recipe no-op");
  }

  return {
    nextFiles,
    edits,
    changes,
    advisories
  };
}

export class MavenNashornNamespaceRewriteRecipe implements Recipe {
  readonly id = "java.maven.nashorn-namespace-rewrite";

  appliesTo(scan: ScanResult): boolean {
    return scan.buildSystem === "maven";
  }

  plan(files: FileMap): RecipePlanItem {
    const result = rewriteNamespace(files, this.id);
    return {
      recipeId: this.id,
      explanation: this.explain(),
      edits: result.edits,
      advisories: result.advisories
    };
  }

  apply(files: FileMap): RecipeApplyOutput {
    const result = rewriteNamespace(files, this.id);
    return {
      files: result.nextFiles,
      changes: result.changes,
      advisories: result.advisories
    };
  }

  explain(): string {
    return "Rewrite legacy jdk.nashorn test-source references to org.openjdk.nashorn without editing non-test Java sources.";
  }
}
