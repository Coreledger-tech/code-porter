import type { ScanResult } from "@code-porter/core/src/models.js";
import type {
  AppliedChange,
  FileMap,
  PlannedEdit,
  Recipe,
  RecipeApplyOutput,
  RecipePlanItem
} from "../types.js";

const JUNIT4_VERSION = "4.13.2";
const NASHORN_IGNORE_IMPORT = /import\s+jdk\.nashorn\.internal\.ir\.annotations\.Ignore\s*;/g;
const JUNIT4_IGNORE_IMPORT = /import\s+org\.junit\.Ignore\s*;/g;
const JUNIT5_DISABLED_IMPORT = "import org.junit.jupiter.api.Disabled;";
const IGNORE_ANNOTATION = /@Ignore\b/g;

function testJavaPaths(files: FileMap): string[] {
  return Object.keys(files)
    .filter((filePath) => filePath.startsWith("src/test/java/") && filePath.endsWith(".java"))
    .sort();
}

function hasIgnoreAnnotation(content: string): boolean {
  return /@Ignore\b/.test(content);
}

function hasJunit5InPom(pom: string): boolean {
  return (
    /<groupId>\s*org\.junit\.jupiter\s*<\/groupId>/i.test(pom) ||
    /<artifactId>\s*junit-jupiter(?:-[^<]*)?\s*<\/artifactId>/i.test(pom)
  );
}

function hasJunit4Dependency(pom: string): boolean {
  return (
    /<groupId>\s*junit\s*<\/groupId>[\s\S]*?<artifactId>\s*junit\s*<\/artifactId>/i.test(pom) ||
    /<artifactId>\s*junit\s*<\/artifactId>[\s\S]*?<groupId>\s*junit\s*<\/groupId>/i.test(pom)
  );
}

function ensureSingleDisabledImport(content: string): string {
  const lines = content.split("\n");
  let seen = false;
  const nextLines: string[] = [];
  for (const line of lines) {
    if (line.trim() === JUNIT5_DISABLED_IMPORT) {
      if (seen) {
        continue;
      }
      seen = true;
    }
    nextLines.push(line);
  }
  return nextLines.join("\n");
}

function migrateIgnoreToDisabled(
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
    if (!hasIgnoreAnnotation(current)) {
      changes.push({
        filePath,
        recipeId,
        description: "No JUnit Ignore annotation migration required",
        changed: false,
        addedLines: 0,
        removedLines: 0
      });
      continue;
    }
    let updated = current
      .replace(NASHORN_IGNORE_IMPORT, JUNIT5_DISABLED_IMPORT)
      .replace(JUNIT4_IGNORE_IMPORT, JUNIT5_DISABLED_IMPORT)
      .replace(IGNORE_ANNOTATION, "@Disabled");
    updated = ensureSingleDisabledImport(updated);

    if (updated === current) {
      changes.push({
        filePath,
        recipeId,
        description: "No JUnit Ignore annotation migration required",
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
      description: "Migrate JUnit @Ignore usage to JUnit 5 @Disabled",
      lineDelta: 4,
      changeType: "update",
      before: "@Ignore",
      after: "@Disabled"
    });
    changes.push({
      filePath,
      recipeId,
      description: "Migrated JUnit Ignore annotation usage to JUnit 5 Disabled",
      changed: true,
      addedLines: 2,
      removedLines: 2
    });
    advisories.push(`Matched test-failure signature '@Ignore' in ${filePath}`);
  }

  if (advisories.length === 0) {
    advisories.push("No @Ignore annotations found in src/test/java; recipe no-op");
  } else {
    advisories.push("Detected JUnit 5 in pom.xml; migrated @Ignore usages to @Disabled");
  }

  return {
    nextFiles,
    edits,
    changes,
    advisories
  };
}

function ensureJunit4PomDependency(
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

  if (!pom) {
    advisories.push("pom.xml not found; cannot ensure junit:junit dependency");
    return { nextFiles, edits, changes, advisories };
  }

  if (hasJunit4Dependency(pom)) {
    advisories.push("junit:junit dependency already present for @Ignore compatibility");
    changes.push({
      filePath: "pom.xml",
      recipeId,
      description: "JUnit4 dependency already present",
      changed: false,
      addedLines: 0,
      removedLines: 0
    });
    return { nextFiles, edits, changes, advisories };
  }

  if (!/<dependencies>[\s\S]*<\/dependencies>/i.test(pom)) {
    advisories.push("No <dependencies> block found; leaving @Ignore usage unchanged");
    changes.push({
      filePath: "pom.xml",
      recipeId,
      description: "Unable to add junit:junit dependency without <dependencies> block",
      changed: false,
      addedLines: 0,
      removedLines: 0
    });
    return { nextFiles, edits, changes, advisories };
  }

  const dependencyBlock = [
    "    <dependency>",
    "      <groupId>junit</groupId>",
    "      <artifactId>junit</artifactId>",
    `      <version>${JUNIT4_VERSION}</version>`,
    "      <scope>test</scope>",
    "    </dependency>"
  ].join("\n");

  const updated = pom.replace(/<\/dependencies>/i, `${dependencyBlock}\n  </dependencies>`);

  nextFiles["pom.xml"] = updated;
  edits.push({
    filePath: "pom.xml",
    recipeId,
    description: "Ensure junit:junit test dependency for @Ignore compatibility",
    lineDelta: 12,
    changeType: "update",
    before: "</dependencies>",
    after: `${dependencyBlock}\n  </dependencies>`
  });
  changes.push({
    filePath: "pom.xml",
    recipeId,
    description: "Added junit:junit test dependency for @Ignore compatibility",
    changed: true,
    addedLines: 6,
    removedLines: 0
  });
  advisories.push("Matched test-failure signature '@Ignore'; ensured junit:junit test dependency");

  return { nextFiles, edits, changes, advisories };
}

export class MavenJunitIgnoreCompatRecipe implements Recipe {
  readonly id = "java.maven.junit-ignore-compat";

  appliesTo(scan: ScanResult): boolean {
    return scan.buildSystem === "maven";
  }

  plan(files: FileMap): RecipePlanItem {
    const hasIgnoreUsage = testJavaPaths(files).some((filePath) =>
      hasIgnoreAnnotation(files[filePath])
    );
    if (!hasIgnoreUsage) {
      return {
        recipeId: this.id,
        explanation: this.explain(),
        edits: [],
        advisories: ["No @Ignore usage detected in src/test/java; recipe skipped"]
      };
    }

    const pom = files["pom.xml"] ?? "";
    if (pom && hasJunit5InPom(pom)) {
      const result = migrateIgnoreToDisabled(files, this.id);
      return {
        recipeId: this.id,
        explanation: this.explain(),
        edits: result.edits,
        advisories: result.advisories
      };
    }

    const result = ensureJunit4PomDependency(files, this.id);
    return {
      recipeId: this.id,
      explanation: this.explain(),
      edits: result.edits,
      advisories: result.advisories
    };
  }

  apply(files: FileMap): RecipeApplyOutput {
    const hasIgnoreUsage = testJavaPaths(files).some((filePath) =>
      hasIgnoreAnnotation(files[filePath])
    );
    if (!hasIgnoreUsage) {
      return {
        files,
        changes: [],
        advisories: ["No @Ignore usage detected in src/test/java; no changes applied"]
      };
    }

    const pom = files["pom.xml"] ?? "";
    if (pom && hasJunit5InPom(pom)) {
      const result = migrateIgnoreToDisabled(files, this.id);
      return {
        files: result.nextFiles,
        changes: result.changes,
        advisories: result.advisories
      };
    }

    const result = ensureJunit4PomDependency(files, this.id);
    return {
      files: result.nextFiles,
      changes: result.changes,
      advisories: result.advisories
    };
  }

  explain(): string {
    return "Resolve deterministic @Ignore test compatibility by migrating to JUnit 5 @Disabled when JUnit 5 is present, or by ensuring junit:junit test dependency for JUnit 4 usage.";
  }
}
