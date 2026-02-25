import type { EvidenceManifest, EvidenceWriterPort, RunContext } from "../workflow-runner.js";

export async function runEvidenceStep(
  writer: EvidenceWriterPort,
  runContext: RunContext
): Promise<EvidenceManifest> {
  return writer.finalize(runContext);
}
