import type {
  PreparedWorkspace,
  RepoProviderPort,
  WorkspaceManagerPort
} from "@code-porter/core/src/workflow-runner.js";
import type {
  Project,
  RunFailureKind,
  RunMode
} from "@code-porter/core/src/models.js";

export class RepoOperationError extends Error {
  readonly failureKind: RunFailureKind;
  readonly blocked: boolean;

  constructor(message: string, failureKind: RunFailureKind, blocked = true) {
    super(message);
    this.name = "RepoOperationError";
    this.failureKind = failureKind;
    this.blocked = blocked;
  }
}

export interface RepoPrepareInput {
  project: Project;
  runId: string;
  campaignId: string;
  mode: RunMode;
  baseRefHint?: string;
}

export abstract class BaseRepoProvider implements RepoProviderPort {
  constructor(protected readonly workspaceManager: WorkspaceManagerPort) {}

  abstract prepareWorkspace(input: RepoPrepareInput): Promise<PreparedWorkspace>;
}
