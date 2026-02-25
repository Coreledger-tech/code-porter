import type { ScanResult } from "@code-porter/core/src/models.js";
import type { FileMap, RecipeApplyResult, RecipeEnginePort, RecipePlanResult } from "@code-porter/core/src/workflow-runner.js";
import type { Recipe } from "./types.js";

export class DefaultRecipeEngine implements RecipeEnginePort {
  constructor(private readonly recipes: Recipe[]) {}

  listRecipeIds(): string[] {
    return this.recipes.map((recipe) => recipe.id);
  }

  plan(scan: ScanResult, files: FileMap): RecipePlanResult {
    const applicable = this.recipes.filter((recipe) => recipe.appliesTo(scan));

    const plans = applicable.map((recipe) => recipe.plan(files));

    return {
      recipes: plans,
      plannedEdits: plans.flatMap((plan) => plan.edits),
      advisories: plans.flatMap((plan) => plan.advisories)
    };
  }

  apply(scan: ScanResult, files: FileMap): RecipeApplyResult {
    const applicable = this.recipes.filter((recipe) => recipe.appliesTo(scan));
    let currentFiles: FileMap = { ...files };

    const allChanges = [];
    const advisories: string[] = [];
    const recipesApplied: string[] = [];

    for (const recipe of applicable) {
      const result = recipe.apply(currentFiles);
      currentFiles = result.files;
      allChanges.push(...result.changes);
      advisories.push(...result.advisories);
      if (result.changes.some((change) => change.changed)) {
        recipesApplied.push(recipe.id);
      }
    }

    return {
      files: currentFiles,
      recipesApplied,
      changes: allChanges,
      advisories
    };
  }
}
