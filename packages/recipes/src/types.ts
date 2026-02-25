import type { ScanResult } from "@code-porter/core/src/models.js";
import type {
  AppliedChange,
  FileMap,
  PlannedEdit,
  RecipeApplyResult,
  RecipeEnginePort,
  RecipePlanItem,
  RecipePlanResult
} from "@code-porter/core/src/workflow-runner.js";

export type { AppliedChange, FileMap, PlannedEdit, RecipeApplyResult, RecipePlanItem, RecipePlanResult };

export interface RecipeApplyOutput {
  files: FileMap;
  changes: AppliedChange[];
  advisories: string[];
}

export interface Recipe {
  id: string;
  appliesTo(scan: ScanResult): boolean;
  plan(files: FileMap): RecipePlanItem;
  apply(files: FileMap): RecipeApplyOutput;
  explain(): string;
}

export type RecipeEngine = RecipeEnginePort;
