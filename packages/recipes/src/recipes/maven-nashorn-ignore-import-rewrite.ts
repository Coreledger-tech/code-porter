import type { ScanResult } from "@code-porter/core/src/models.js";
import type {
  AppliedChange,
  FileMap,
  PlannedEdit,
  Recipe,
  RecipeApplyOutput,
  RecipePlanItem
} from "../types.js";

const NASHORN_IGNORE_IMPORT = /import\s+jdk\.nashorn\.internal\.ir\.annotations\.Ignore\s*;/g;
const JUNIT4_IGNORE_IMPORT = "import org.junit.Ignore;";

function testJavaPaths(files: FileMap): string[] {
  return Object.keys(files)
    .filter((filePath) => filePath.startsWith("src/test/java/") && filePath.endsWith(".java"))
    .sort();
}

function rewriteIgnoreImports(
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
    NASHORN_IGNORE_IMPORT.lastIndex = 0;
    if (!NASHORN_IGNORE_IMPORT.test(current)) {
      changes.push({
        filePath,
        recipeId,
        description: "No Nashorn Ignore import rewrite required",
        changed: false,
        addedLines: 0,
        removedLines: 0
      });
      continue;
    }

    NASHORN_IGNORE_IMPORT.lastIndex = 0;
    const updated = current.replace(NASHORN_IGNORE_IMPORT, JUNIT4_IGNORE_IMPORT);
    if (updated === current) {
      changes.push({
        filePath,
        recipeId,
        description: "No Nashorn Ignore import rewrite required",
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
      description: "Replace Nashorn Ignore import with JUnit Ignore import",
      lineDelta: 2,
      changeType: "update",
      before: "import jdk.nashorn.internal.ir.annotations.Ignore;",
      after: JUNIT4_IGNORE_IMPORT
    });
    changes.push({
      filePath,
      recipeId,
      description: "Rewrote Nashorn Ignore import to JUnit Ignore import",
      changed: true,
      addedLines: 1,
      removedLines: 1
    });
    advisories.push(
      `Matched test-failure signature 'jdk.nashorn.internal.ir.annotations.Ignore' in ${filePath}`
    );
  }

  if (advisories.length === 0) {
    advisories.push("No Nashorn Ignore imports found in src/test/java; recipe no-op");
  }

  return {
    nextFiles,
    edits,
    changes,
    advisories
  };
}

export class MavenNashornIgnoreImportRewriteRecipe implements Recipe {
  readonly id = "java.maven.nashorn-ignore-import-rewrite";

  appliesTo(scan: ScanResult): boolean {
    return scan.buildSystem === "maven";
  }

  plan(files: FileMap): RecipePlanItem {
    const result = rewriteIgnoreImports(files, this.id);
    return {
      recipeId: this.id,
      explanation: this.explain(),
      edits: result.edits,
      advisories: result.advisories
    };
  }

  apply(files: FileMap): RecipeApplyOutput {
    const result = rewriteIgnoreImports(files, this.id);
    return {
      files: result.nextFiles,
      changes: result.changes,
      advisories: result.advisories
    };
  }

  explain(): string {
    return "Rewrite legacy Nashorn @Ignore imports in test sources to standard JUnit Ignore imports without changing non-test files.";
  }
}
