import type {
  PolicyConfig,
  ScanResult,
  VerifyFailureKind,
  VerifySummary
} from "@code-porter/core/src/models.js";
import type {
  DeterministicRemediator,
  RemediationAction,
  RemediationResult,
  VerifierPort
} from "@code-porter/core/src/workflow-runner.js";
import { isCachedResolutionFailure } from "./failure-classifier.js";
import { runCommand } from "./commands.js";

function gatherFailureKinds(verify: VerifySummary): VerifyFailureKind[] {
  const kinds: VerifyFailureKind[] = [];
  if (verify.compile.status !== "passed" && verify.compile.failureKind) {
    kinds.push(verify.compile.failureKind);
  }
  if (verify.tests.status !== "passed" && verify.tests.failureKind) {
    kinds.push(verify.tests.failureKind);
  }
  return [...new Set(kinds)];
}

function isInfraBlocked(verify: VerifySummary, policy: PolicyConfig): boolean {
  const kinds = gatherFailureKinds(verify);
  return (
    kinds.length > 0 &&
    kinds.every((kind) => policy.verify.nonBlockingFailureKinds.includes(kind))
  );
}

function hasCachedResolutionSignal(verify: VerifySummary): boolean {
  return (
    isCachedResolutionFailure(verify.compile) || isCachedResolutionFailure(verify.tests)
  );
}

async function runAction(input: {
  action: string;
  command: string;
  args: string[];
  repoPath: string;
  reason?: string;
}): Promise<RemediationAction> {
  const result = await runCommand(
    {
      command: input.command,
      args: input.args
    },
    input.repoPath
  );

  if (result.status === "passed") {
    return {
      action: input.action,
      status: "applied",
      command: input.command,
      args: input.args,
      output: result.output,
      reason: input.reason
    };
  }

  return {
    action: input.action,
    status: "failed",
    command: input.command,
    args: input.args,
    output: result.output,
    reason: result.reason ?? input.reason
  };
}

export class MavenDeterministicRemediator implements DeterministicRemediator {
  appliesTo(input: {
    scan: ScanResult;
    verify: VerifySummary;
    policy: PolicyConfig;
  }): boolean {
    if (input.scan.buildSystem !== "maven") {
      return false;
    }

    return isInfraBlocked(input.verify, input.policy);
  }

  async run(input: {
    scan: ScanResult;
    verify: VerifySummary;
    repoPath: string;
    policy: PolicyConfig;
    verifier: VerifierPort;
  }): Promise<RemediationResult> {
    const actions: RemediationAction[] = [];

    if (!this.appliesTo(input)) {
      return {
        applied: false,
        actions: [
          {
            action: "deterministic_remediation",
            status: "skipped",
            reason: "Remediator is not applicable for this verify result"
          }
        ],
        verifySummary: input.verify,
        reason: "not_applicable"
      };
    }

    if (input.policy.verify.maven.prefetchPlugins) {
      actions.push(
        await runAction({
          action: "prefetch_plugins",
          command: "mvn",
          args: ["-q", "-U", "dependency:resolve-plugins"],
          repoPath: input.repoPath,
          reason: "Prefetch Maven plugins before verification retry"
        })
      );
    }

    if (input.policy.verify.retryOnCachedResolution && input.policy.verify.maven.forceUpdate) {
      if (input.verify.compile.failureKind === "artifact_resolution") {
        actions.push(
          await runAction({
            action: "force_update_compile",
            command: "mvn",
            args: ["-U", "-q", "-DskipTests", "compile"],
            repoPath: input.repoPath,
            reason: "Retry compile with Maven force update"
          })
        );
      }

      if (input.scan.hasTests && input.verify.tests.failureKind === "artifact_resolution") {
        actions.push(
          await runAction({
            action: "force_update_test",
            command: "mvn",
            args: ["-U", "-q", "test"],
            repoPath: input.repoPath,
            reason: "Retry tests with Maven force update"
          })
        );
      }
    }

    let verifySummary = await input.verifier.run(
      input.scan,
      input.repoPath,
      input.policy
    );

    if (
      input.policy.verify.maven.purgeLocalCache &&
      hasCachedResolutionSignal(verifySummary)
    ) {
      actions.push(
        await runAction({
          action: "purge_local_repository",
          command: "mvn",
          args: ["-q", "dependency:purge-local-repository"],
          repoPath: input.repoPath,
          reason: "Purge cached local repository metadata before final retry"
        })
      );

      verifySummary = await input.verifier.run(
        input.scan,
        input.repoPath,
        input.policy
      );
    }

    return {
      applied: actions.some((action) => action.status === "applied"),
      actions,
      verifySummary,
      reason: actions.length > 0 ? "actions_executed" : "no_actions_executed"
    };
  }
}
