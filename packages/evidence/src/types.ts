import type { EvidenceManifestArtifact, RunContext } from "@code-porter/core/src/workflow-runner.js";

export interface EvidenceManifest {
  runId: string;
  artifacts: EvidenceManifestArtifact[];
}

export type { RunContext, EvidenceManifestArtifact };
