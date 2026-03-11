import type { ScanResult } from "@code-porter/core/src/models.js";
import type {
  AppliedChange,
  FileMap,
  PlannedEdit,
  Recipe,
  RecipeApplyOutput,
  RecipePlanItem
} from "../types.js";

const NASHORN_GROUP_ID = "org.openjdk.nashorn";
const NASHORN_ARTIFACT_ID = "nashorn-core";
const NASHORN_VERSION = "15.4";

const NASHORN_TEST_SIGNATURE = /\borg\.openjdk\.nashorn\./;
const NASHORN_DEPENDENCY_PATTERN =
  /<groupId>\s*org\.openjdk\.nashorn\s*<\/groupId>[\s\S]*?<artifactId>\s*nashorn-core\s*<\/artifactId>/i;

function testJavaPaths(files: FileMap): string[] {
  return Object.keys(files)
    .filter((filePath) => filePath.startsWith("src/test/java/") && filePath.endsWith(".java"))
    .sort();
}

function requiresNashornDependency(files: FileMap): boolean {
  return testJavaPaths(files).some((filePath) => NASHORN_TEST_SIGNATURE.test(files[filePath]));
}

function ensureNashornDependency(
  files: FileMap,
  recipeId: string
): {
  nextFiles: FileMap;
  edits: PlannedEdit[];
  changes: AppliedChange[];
  advisories: string[];
} {
  const pom = files["pom.xml"];
  const nextFiles: FileMap = { ...files };
  const edits: PlannedEdit[] = [];
  const changes: AppliedChange[] = [];
  const advisories: string[] = [];

  if (!requiresNashornDependency(files)) {
    advisories.push("No org.openjdk.nashorn test references detected; dependency recipe no-op");
    changes.push({
      filePath: "pom.xml",
      recipeId,
      description: "No Nashorn dependency update required",
      changed: false,
      addedLines: 0,
      removedLines: 0
    });
    return { nextFiles, edits, changes, advisories };
  }

  if (!pom) {
    advisories.push("pom.xml not found; cannot ensure nashorn-core test dependency");
    changes.push({
      filePath: "pom.xml",
      recipeId,
      description: "Missing pom.xml; no Nashorn dependency update",
      changed: false,
      addedLines: 0,
      removedLines: 0
    });
    return { nextFiles, edits, changes, advisories };
  }

  if (NASHORN_DEPENDENCY_PATTERN.test(pom)) {
    advisories.push("nashorn-core dependency already present; recipe no-op");
    changes.push({
      filePath: "pom.xml",
      recipeId,
      description: "nashorn-core dependency already present",
      changed: false,
      addedLines: 0,
      removedLines: 0
    });
    return { nextFiles, edits, changes, advisories };
  }

  if (!/<dependencies>[\s\S]*<\/dependencies>/i.test(pom)) {
    advisories.push("No <dependencies> block found; skipping nashorn-core insertion");
    changes.push({
      filePath: "pom.xml",
      recipeId,
      description: "Unable to insert nashorn-core without <dependencies> block",
      changed: false,
      addedLines: 0,
      removedLines: 0
    });
    return { nextFiles, edits, changes, advisories };
  }

  const dependencyBlock = [
    "    <dependency>",
    `      <groupId>${NASHORN_GROUP_ID}</groupId>`,
    `      <artifactId>${NASHORN_ARTIFACT_ID}</artifactId>`,
    `      <version>${NASHORN_VERSION}</version>`,
    "      <scope>test</scope>",
    "    </dependency>"
  ].join("\n");

  const updated = pom.replace(/<\/dependencies>/i, `${dependencyBlock}\n  </dependencies>`);
  nextFiles["pom.xml"] = updated;

  edits.push({
    filePath: "pom.xml",
    recipeId,
    description: "Ensure nashorn-core test dependency when org.openjdk.nashorn references exist",
    lineDelta: 12,
    changeType: "update",
    before: "</dependencies>",
    after: `${dependencyBlock}\n  </dependencies>`
  });

  changes.push({
    filePath: "pom.xml",
    recipeId,
    description: "Added org.openjdk.nashorn:nashorn-core test dependency",
    changed: true,
    addedLines: 6,
    removedLines: 0
  });

  advisories.push(
    "Matched org.openjdk.nashorn test references; ensured org.openjdk.nashorn:nashorn-core:15.4 test dependency"
  );

  return { nextFiles, edits, changes, advisories };
}

export class MavenNashornCoreTestDependencyRecipe implements Recipe {
  readonly id = "java.maven.nashorn-core-test-dependency";

  appliesTo(scan: ScanResult): boolean {
    return scan.buildSystem === "maven";
  }

  plan(files: FileMap): RecipePlanItem {
    const result = ensureNashornDependency(files, this.id);
    return {
      recipeId: this.id,
      explanation: this.explain(),
      edits: result.edits,
      advisories: result.advisories
    };
  }

  apply(files: FileMap): RecipeApplyOutput {
    const result = ensureNashornDependency(files, this.id);
    return {
      files: result.nextFiles,
      changes: result.changes,
      advisories: result.advisories
    };
  }

  explain(): string {
    return "Ensure org.openjdk.nashorn:nashorn-core test dependency only when rewritten test sources require Nashorn classes.";
  }
}
