import type { ScanResult } from "@code-porter/core/src/models.js";
import type {
  AppliedChange,
  FileMap,
  PlannedEdit,
  Recipe,
  RecipeApplyOutput,
  RecipePlanItem
} from "../types.js";

const TARGET_PHASE = "prepare-package";
const EARLY_PHASES = new Set([
  "generate-sources",
  "process-sources",
  "generate-test-sources",
  "process-test-sources"
]);

function updateDelombokPhase(
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
  const executionBlockRegex = /<execution>[\s\S]*?<\/execution>/g;
  const phaseRegex = /<phase>\s*([^<]+)\s*<\/phase>/;
  const pluginBlocks = content.match(pluginBlockRegex) ?? [];

  let foundLombokPlugin = false;
  let foundDelombokExecution = false;
  let updated = content;

  for (const pluginBlock of pluginBlocks) {
    if (
      !/<groupId>\s*org\.projectlombok\s*<\/groupId>/.test(pluginBlock) ||
      !/<artifactId>\s*lombok-maven-plugin\s*<\/artifactId>/.test(pluginBlock)
    ) {
      continue;
    }

    foundLombokPlugin = true;
    const executionBlocks = pluginBlock.match(executionBlockRegex) ?? [];
    let updatedPluginBlock = pluginBlock;

    for (const executionBlock of executionBlocks) {
      if (!/<goal>\s*delombok\s*<\/goal>/.test(executionBlock)) {
        continue;
      }

      foundDelombokExecution = true;
      const phaseMatch = executionBlock.match(phaseRegex);
      if (!phaseMatch) {
        advisories.push(
          "lombok-maven-plugin delombok execution has no explicit <phase>; recipe leaves config unchanged"
        );
        continue;
      }

      const currentPhase = phaseMatch[1].trim();
      if (currentPhase === TARGET_PHASE || currentPhase === "package") {
        advisories.push(
          `lombok-maven-plugin delombok phase (${currentPhase}) already avoids compile/test path`
        );
        continue;
      }

      if (!EARLY_PHASES.has(currentPhase)) {
        advisories.push(
          `lombok-maven-plugin delombok phase (${currentPhase}) not rewritten by conservative rule`
        );
        continue;
      }

      edits.push({
        filePath: "pom.xml",
        recipeId,
        description: `Move lombok delombok phase from ${currentPhase} to ${TARGET_PHASE}`,
        lineDelta: 2,
        changeType: "update",
        before: `<phase>${currentPhase}</phase>`,
        after: `<phase>${TARGET_PHASE}</phase>`
      });

      advisories.push(
        `Moved lombok-maven-plugin delombok execution from ${currentPhase} to ${TARGET_PHASE}`
      );

      const updatedExecutionBlock = executionBlock.replace(
        phaseRegex,
        `<phase>${TARGET_PHASE}</phase>`
      );
      updatedPluginBlock = updatedPluginBlock.replace(executionBlock, updatedExecutionBlock);
    }

    updated = updated.replace(pluginBlock, updatedPluginBlock);
  }

  if (!foundLombokPlugin) {
    advisories.push("lombok-maven-plugin not configured; no-op");
  } else if (!foundDelombokExecution) {
    advisories.push("lombok-maven-plugin configured without delombok goal; no-op");
  }

  return { updated, edits, advisories };
}

export class MavenLombokDelombokPreparePackageRecipe implements Recipe {
  readonly id = "java.maven.lombok-delombok-prepare-package";

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

    const result = updateDelombokPhase(pom, this.id);
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

    const result = updateDelombokPhase(pom, this.id);
    if (result.updated === pom) {
      return {
        files,
        changes: [
          {
            filePath: "pom.xml",
            recipeId: this.id,
            description: "No lombok delombok phase shift required",
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
      description: `Moved lombok delombok execution to ${TARGET_PHASE}`,
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
    return "Move an existing lombok-maven-plugin delombok execution out of the compile/test path by rebinding it to prepare-package. This preserves package-time source and javadoc workflows while avoiding early Java 17 plugin failures.";
  }
}
