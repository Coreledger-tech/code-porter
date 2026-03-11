import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type {
  CheckResult,
  PlanMetrics,
  PolicyConfig,
  PolicyDecision,
  VerifyFailureKind,
  VerifySummary
} from "./models.js";
import type { PolicyEngine } from "./workflow-runner.js";

const ALL_FAILURE_KINDS: VerifyFailureKind[] = [
  "code_compile_failure",
  "code_test_failure",
  "code_failure",
  "tool_missing",
  "artifact_resolution",
  "repo_unreachable",
  "budget_exceeded",
  "java17_plugin_incompat",
  "unknown"
];

const DEFAULT_POLICY: PolicyConfig = {
  maxChangeLines: 300,
  maxFilesChanged: 10,
  requireTestsIfPresent: true,
  maxInflightRunsPerProject: 2,
  maxInflightRunsGlobal: 10,
  maxVerifyMinutesPerRun: 20,
  maxVerifyRetries: 2,
  maxEvidenceZipBytes: 50 * 1024 * 1024,
  defaultRecipePack: "java-maven-plugin-modernize",
  allowedBuildSystems: ["maven", "gradle", "node"],
  verifyFailureMode: "deny",
  verify: {
    blockingFailureKinds: [
      "code_compile_failure",
      "code_test_failure",
      "code_failure",
      "java17_plugin_incompat"
    ],
    nonBlockingFailureKinds: [
      "tool_missing",
      "artifact_resolution",
      "repo_unreachable",
      "budget_exceeded"
    ],
    retryOnCachedResolution: true,
    maven: {
      forceUpdate: true,
      prefetchPlugins: true,
      purgeLocalCache: false
    }
  },
  gradle: {
    allowAndroidBaselineApply: false
  },
  remediation: {
    mavenCompile: {
      enabled: false,
      maxIterations: 2,
      maxFilesChangedPerIteration: 1,
      maxLinesChangedPerIteration: 25,
      maxFilesChangedTotal: 2,
      maxLinesChangedTotal: 40,
      allowedFixes: [
        "ensure_maven_compiler_plugin_for_lombok",
        "ensure_lombok_annotation_processor_path",
        "remove_proc_none"
      ]
    }
  },
  confidenceThresholds: {
    pass: 70,
    needsReview: 55
  }
};

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

function asPositiveInt(value: unknown, fallback: number): number {
  const parsed = asNumber(value, fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

function asString(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  return fallback;
}

function asVerifyFailureMode(
  value: unknown,
  fallback: PolicyConfig["verifyFailureMode"]
): PolicyConfig["verifyFailureMode"] {
  if (value === "deny" || value === "warn") {
    return value;
  }
  return fallback;
}

function asFailureKindArray(
  value: unknown,
  fallback: VerifyFailureKind[]
): VerifyFailureKind[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const filtered = value.filter(
    (item): item is VerifyFailureKind =>
      typeof item === "string" &&
      ALL_FAILURE_KINDS.includes(item as VerifyFailureKind)
  );

  return filtered.length > 0 ? filtered : fallback;
}

function deriveLegacyVerifyConfig(
  mode: PolicyConfig["verifyFailureMode"]
): PolicyConfig["verify"] {
  if (mode === "warn") {
    return {
      blockingFailureKinds: [
        "code_compile_failure",
        "code_test_failure",
        "code_failure",
        "java17_plugin_incompat"
      ],
      nonBlockingFailureKinds: [
        "tool_missing",
        "artifact_resolution",
        "repo_unreachable",
        "budget_exceeded",
        "unknown"
      ],
      retryOnCachedResolution: true,
      maven: {
        forceUpdate: true,
        prefetchPlugins: true,
        purgeLocalCache: false
      }
    };
  }

  return {
    blockingFailureKinds: [...ALL_FAILURE_KINDS],
    nonBlockingFailureKinds: [],
    retryOnCachedResolution: true,
    maven: {
      forceUpdate: true,
      prefetchPlugins: true,
      purgeLocalCache: false
    }
  };
}

function normalizePolicy(raw: unknown): PolicyConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  const thresholds = (config.confidenceThresholds ?? {}) as Record<string, unknown>;
  const verify = (config.verify ?? null) as Record<string, unknown> | null;
  const remediation = (config.remediation ?? null) as Record<string, unknown> | null;
  const gradle = (config.gradle ?? null) as Record<string, unknown> | null;

  const verifyFailureMode = asVerifyFailureMode(
    config.verifyFailureMode,
    DEFAULT_POLICY.verifyFailureMode
  );

  const legacyVerifyDefaults = deriveLegacyVerifyConfig(verifyFailureMode);
  const verifyDefaults = verify ?? null ? DEFAULT_POLICY.verify : legacyVerifyDefaults;

  const normalizedVerify: PolicyConfig["verify"] = {
    blockingFailureKinds: asFailureKindArray(
      verify?.blockingFailureKinds,
      verifyDefaults.blockingFailureKinds
    ),
    nonBlockingFailureKinds: asFailureKindArray(
      verify?.nonBlockingFailureKinds,
      verifyDefaults.nonBlockingFailureKinds
    ),
    retryOnCachedResolution: asBoolean(
      verify?.retryOnCachedResolution,
      verifyDefaults.retryOnCachedResolution
    ),
    maven: {
      forceUpdate: asBoolean(
        (verify?.maven as Record<string, unknown> | undefined)?.forceUpdate,
        verifyDefaults.maven.forceUpdate
      ),
      prefetchPlugins: asBoolean(
        (verify?.maven as Record<string, unknown> | undefined)?.prefetchPlugins,
        verifyDefaults.maven.prefetchPlugins
      ),
      purgeLocalCache: asBoolean(
        (verify?.maven as Record<string, unknown> | undefined)?.purgeLocalCache,
        verifyDefaults.maven.purgeLocalCache
      )
    }
  };

  const rawMavenCompileRemediation =
    (remediation?.mavenCompile as Record<string, unknown> | undefined) ?? undefined;
  const defaultMavenCompileRemediation = DEFAULT_POLICY.remediation?.mavenCompile;
  const normalizedMavenCompileRemediation =
    rawMavenCompileRemediation || defaultMavenCompileRemediation
      ? {
          enabled: asBoolean(
            rawMavenCompileRemediation?.enabled,
            defaultMavenCompileRemediation?.enabled ?? false
          ),
          maxIterations: asPositiveInt(
            rawMavenCompileRemediation?.maxIterations,
            defaultMavenCompileRemediation?.maxIterations ?? 2
          ),
          maxFilesChangedPerIteration: asPositiveInt(
            rawMavenCompileRemediation?.maxFilesChangedPerIteration,
            defaultMavenCompileRemediation?.maxFilesChangedPerIteration ?? 1
          ),
          maxLinesChangedPerIteration: asPositiveInt(
            rawMavenCompileRemediation?.maxLinesChangedPerIteration,
            defaultMavenCompileRemediation?.maxLinesChangedPerIteration ?? 25
          ),
          maxFilesChangedTotal: asPositiveInt(
            rawMavenCompileRemediation?.maxFilesChangedTotal,
            defaultMavenCompileRemediation?.maxFilesChangedTotal ?? 2
          ),
          maxLinesChangedTotal: asPositiveInt(
            rawMavenCompileRemediation?.maxLinesChangedTotal,
            defaultMavenCompileRemediation?.maxLinesChangedTotal ?? 40
          ),
          allowedFixes: asStringArray(
            rawMavenCompileRemediation?.allowedFixes,
            defaultMavenCompileRemediation?.allowedFixes ?? []
          ).filter(
            (
              item
            ): item is NonNullable<
              NonNullable<PolicyConfig["remediation"]>["mavenCompile"]
            >["allowedFixes"][number] => {
              return [
                "ensure_maven_compiler_plugin_for_lombok",
                "ensure_lombok_annotation_processor_path",
                "remove_proc_none"
              ].includes(item);
            }
          )
        }
      : undefined;

  return {
    maxChangeLines: asNumber(config.maxChangeLines, DEFAULT_POLICY.maxChangeLines),
    maxFilesChanged: asNumber(config.maxFilesChanged, DEFAULT_POLICY.maxFilesChanged),
    requireTestsIfPresent: asBoolean(
      config.requireTestsIfPresent,
      DEFAULT_POLICY.requireTestsIfPresent
    ),
    maxInflightRunsPerProject: asPositiveInt(
      config.maxInflightRunsPerProject,
      DEFAULT_POLICY.maxInflightRunsPerProject
    ),
    maxInflightRunsGlobal: asPositiveInt(
      config.maxInflightRunsGlobal,
      DEFAULT_POLICY.maxInflightRunsGlobal
    ),
    maxVerifyMinutesPerRun: asPositiveInt(
      config.maxVerifyMinutesPerRun,
      DEFAULT_POLICY.maxVerifyMinutesPerRun
    ),
    maxVerifyRetries: asPositiveInt(
      config.maxVerifyRetries,
      DEFAULT_POLICY.maxVerifyRetries
    ),
    maxEvidenceZipBytes: asPositiveInt(
      config.maxEvidenceZipBytes,
      DEFAULT_POLICY.maxEvidenceZipBytes
    ),
    defaultRecipePack: asString(
      config.defaultRecipePack,
      DEFAULT_POLICY.defaultRecipePack
    ),
    allowedBuildSystems: asStringArray(
      config.allowedBuildSystems,
      DEFAULT_POLICY.allowedBuildSystems
    ).filter((item): item is PolicyConfig["allowedBuildSystems"][number] => {
      return ["maven", "gradle", "node", "python", "go", "unknown"].includes(item);
    }),
    verifyFailureMode,
    verify: normalizedVerify,
    gradle: {
      allowAndroidBaselineApply: asBoolean(
        gradle?.allowAndroidBaselineApply,
        DEFAULT_POLICY.gradle?.allowAndroidBaselineApply ?? false
      )
    },
    remediation:
      normalizedMavenCompileRemediation
        ? {
            mavenCompile: normalizedMavenCompileRemediation
          }
        : undefined,
    confidenceThresholds: {
      pass: asNumber(thresholds.pass, DEFAULT_POLICY.confidenceThresholds.pass),
      needsReview: asNumber(
        thresholds.needsReview,
        DEFAULT_POLICY.confidenceThresholds.needsReview
      )
    }
  };
}

function toVerifyFailureKind(
  check: CheckResult,
  fallback: VerifyFailureKind = "unknown"
): VerifyFailureKind {
  return check.failureKind ?? fallback;
}

function mapFailureToDecision(
  input: {
    id: string;
    check: CheckResult;
    defaultReason: string;
  },
  policy: PolicyConfig,
  hasTests: boolean
): PolicyDecision {
  const failureKind = toVerifyFailureKind(input.check);
  const blockedId = input.id.startsWith("compile")
    ? `compile_blocked(${failureKind})`
    : input.id.startsWith("tests")
      ? `tests_blocked(${failureKind})`
      : `${input.id}_blocked(${failureKind})`;
  const failureId = `${input.id}(${failureKind})`;

  if (policy.verify.nonBlockingFailureKinds.includes(failureKind)) {
    return {
      id: blockedId,
      stage: "verify",
      status: "warn",
      reason: `${input.defaultReason} (${failureKind})`,
      blocking: false
    };
  }

  if (policy.verify.blockingFailureKinds.includes(failureKind)) {
    return {
      id: failureId,
      stage: "verify",
      status: "deny",
      reason: `${input.defaultReason} (${failureKind})`,
      blocking: true
    };
  }

  const shouldWarnLegacy = policy.verifyFailureMode === "warn";
  return {
    id: failureId,
    stage: "verify",
    status: shouldWarnLegacy ? "warn" : "deny",
    reason: `${input.defaultReason} (${failureKind})`,
    blocking: !shouldWarnLegacy && hasTests
  };
}

export class YamlPolicyEngine implements PolicyEngine {
  async load(path: string): Promise<PolicyConfig> {
    const file = await readFile(path, "utf8");
    const parsed = parse(file);
    return normalizePolicy(parsed);
  }

  evaluatePlan(input: PlanMetrics, policy: PolicyConfig): PolicyDecision[] {
    const decisions: PolicyDecision[] = [];
    const selectedManifestPath = input.selectedManifestPath ?? "none";
    const selectedBuildRoot = input.selectedBuildRoot ?? ".";
    const buildSystemReason =
      input.buildSystemReason ?? `Build system '${input.buildSystem}' was detected`;

    const allowAndroidBaselineSubtype =
      input.buildSystemDisposition === "unsupported_subtype" &&
      input.buildSystem === "gradle" &&
      input.gradleProjectType === "android" &&
      policy.gradle?.allowAndroidBaselineApply === true;

    if (
      (!allowAndroidBaselineSubtype && input.buildSystemDisposition === "unsupported_subtype") ||
      input.buildSystemDisposition === "no_supported_manifest" ||
      !policy.allowedBuildSystems.includes(input.buildSystem)
    ) {
      const reason =
        input.buildSystemDisposition === "no_supported_manifest"
          ? buildSystemReason
          : input.buildSystemDisposition === "unsupported_subtype" && !allowAndroidBaselineSubtype
            ? buildSystemReason
          : `Build system '${input.buildSystem}' is not allowed by policy (manifest: '${selectedManifestPath}', build root: '${selectedBuildRoot}')`;
      decisions.push({
        id: "allowed_build_system",
        stage: "scan",
        status: "deny",
        reason,
        blocking: true
      });
    } else {
      decisions.push({
        id: "allowed_build_system",
        stage: "scan",
        status: "allow",
        reason: allowAndroidBaselineSubtype
          ? "Gradle Android baseline apply mode is enabled; allowing deterministic plan/apply while guarded verify remains out of scope"
          : `Build system '${input.buildSystem}' is allowed (manifest: '${selectedManifestPath}', build root: '${selectedBuildRoot}')`,
        blocking: false
      });
    }

    if (input.filesChanged > policy.maxFilesChanged) {
      decisions.push({
        id: "max_files_changed",
        stage: "plan",
        status: "deny",
        reason: `Planned file changes (${input.filesChanged}) exceed maxFilesChanged (${policy.maxFilesChanged})`,
        blocking: true
      });
    } else {
      decisions.push({
        id: "max_files_changed",
        stage: "plan",
        status: "allow",
        reason: `Planned file changes (${input.filesChanged}) are within limit`,
        blocking: false
      });
    }

    if (input.linesChanged > policy.maxChangeLines) {
      decisions.push({
        id: "max_change_lines",
        stage: "plan",
        status: "deny",
        reason: `Planned line changes (${input.linesChanged}) exceed maxChangeLines (${policy.maxChangeLines})`,
        blocking: true
      });
    } else {
      decisions.push({
        id: "max_change_lines",
        stage: "plan",
        status: "allow",
        reason: `Planned line changes (${input.linesChanged}) are within limit`,
        blocking: false
      });
    }

    return decisions;
  }

  evaluateVerify(input: VerifySummary, policy: PolicyConfig): PolicyDecision[] {
    const decisions: PolicyDecision[] = [];

    if (input.compile.status !== "passed") {
      decisions.push(
        mapFailureToDecision(
          {
            id: "compile_must_pass",
            check: input.compile,
            defaultReason: "Compile/build check did not pass"
          },
          policy,
          true
        )
      );
    } else {
      decisions.push({
        id: "compile_must_pass",
        stage: "verify",
        status: "allow",
        reason: "Compile/build check passed",
        blocking: false
      });
    }

    if (policy.requireTestsIfPresent && input.hasTests && input.tests.status !== "passed") {
      decisions.push(
        mapFailureToDecision(
          {
            id: "tests_required_if_present",
            check: input.tests,
            defaultReason: "Tests are present and required but did not pass"
          },
          policy,
          true
        )
      );
    } else {
      decisions.push({
        id: "tests_required_if_present",
        stage: "verify",
        status: "allow",
        reason: input.hasTests
          ? "Tests requirement satisfied"
          : "No tests detected; requirement not applicable",
        blocking: false
      });
    }

    if (input.staticChecks.status === "failed") {
      decisions.push({
        id: "static_checks",
        stage: "verify",
        status: "deny",
        reason: "Static checks failed",
        blocking: true
      });
    } else if (input.staticChecks.status === "not_run") {
      decisions.push({
        id: "static_checks",
        stage: "verify",
        status: "warn",
        reason: "Static checks were not run",
        blocking: false
      });
    } else {
      decisions.push({
        id: "static_checks",
        stage: "verify",
        status: "allow",
        reason: "Static checks passed",
        blocking: false
      });
    }

    return decisions;
  }
}

export function countPolicyViolations(decisions: PolicyDecision[]): number {
  return decisions.filter((decision) => decision.status === "deny").length;
}

export function hasBlockingDecision(decisions: PolicyDecision[]): boolean {
  return decisions.some((decision) => decision.blocking);
}
