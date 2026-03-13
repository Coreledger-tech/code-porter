import type {
  BuildSystem,
  BuildSystemDisposition,
  CoverageNextLane,
  CoverageOutcome,
  GradleProjectType,
  RunStatus,
  UnsupportedCoverageReason
} from "./models.js";

export interface CoverageClassificationInput {
  buildSystem: BuildSystem;
  buildSystemDisposition?: BuildSystemDisposition | null;
  gradleProjectType?: GradleProjectType | null;
  gradleWrapperPath?: string | null;
  failureKind?: string | null;
  status?: RunStatus | null;
}

export interface CoverageClassification {
  unsupportedReason: UnsupportedCoverageReason | null;
  recommendedNextLane: CoverageNextLane | null;
  coverageOutcome: CoverageOutcome | null;
}

export function deriveCoverageClassification(
  input: CoverageClassificationInput
): CoverageClassification {
  const buildSystemDisposition = input.buildSystemDisposition ?? null;
  const gradleProjectType = input.gradleProjectType ?? null;
  const gradleWrapperPath = input.gradleWrapperPath ?? null;
  const failureKind = input.failureKind ?? null;
  const status = input.status ?? null;

  if (failureKind === "guarded_baseline_applied") {
    return {
      unsupportedReason: null,
      recommendedNextLane: null,
      coverageOutcome: "guarded_applied"
    };
  }

  if (failureKind === "guarded_baseline_noop") {
    return {
      unsupportedReason: null,
      recommendedNextLane: null,
      coverageOutcome: "guarded_noop"
    };
  }

  if (
    input.buildSystem === "gradle" &&
    gradleProjectType === "android" &&
    buildSystemDisposition === "supported" &&
    status !== "completed"
  ) {
    return {
      unsupportedReason: null,
      recommendedNextLane: null,
      coverageOutcome: "guarded_blocked"
    };
  }

  if (buildSystemDisposition === "no_supported_manifest") {
    return {
      unsupportedReason: "no_supported_manifest",
      recommendedNextLane: "manifest_follow_up",
      coverageOutcome: "excluded"
    };
  }

  if (
    input.buildSystem === "gradle" &&
    gradleProjectType === "jvm" &&
    !gradleWrapperPath
  ) {
    return {
      unsupportedReason: "unsupported_subtype_gradle_no_wrapper",
      recommendedNextLane: "gradle_jvm_wrapper_lane",
      coverageOutcome: "excluded"
    };
  }

  if (
    input.buildSystem === "gradle" &&
    gradleProjectType === "android" &&
    buildSystemDisposition === "unsupported_subtype"
  ) {
    return {
      unsupportedReason: "unsupported_subtype_android_unguarded",
      recommendedNextLane: "android_guarded_baseline",
      coverageOutcome: "excluded"
    };
  }

  if (
    input.buildSystem === "gradle" &&
    gradleProjectType === "unknown" &&
    status !== "completed"
  ) {
    return {
      unsupportedReason: "unsupported_subtype_gradle_unknown",
      recommendedNextLane: "manual_triage",
      coverageOutcome: "excluded"
    };
  }

  if (
    input.buildSystem === "go" &&
    (buildSystemDisposition === "excluded_by_policy" || failureKind === "unsupported_build_system")
  ) {
    return {
      unsupportedReason: "unsupported_build_system_go",
      recommendedNextLane: "go_readiness_lane",
      coverageOutcome: "excluded"
    };
  }

  if (
    input.buildSystem === "node" &&
    (buildSystemDisposition === "excluded_by_policy" || failureKind === "unsupported_build_system")
  ) {
    return {
      unsupportedReason: "unsupported_build_system_node",
      recommendedNextLane: "node_readiness_lane",
      coverageOutcome: "excluded"
    };
  }

  if (
    input.buildSystem === "python" &&
    (buildSystemDisposition === "excluded_by_policy" || failureKind === "unsupported_build_system")
  ) {
    return {
      unsupportedReason: "unsupported_build_system_python",
      recommendedNextLane: "python_readiness_lane",
      coverageOutcome: "excluded"
    };
  }

  if (buildSystemDisposition === "excluded_by_policy") {
    return {
      unsupportedReason: "excluded_by_policy",
      recommendedNextLane: "enable_build_system_in_policy",
      coverageOutcome: "excluded"
    };
  }

  if (
    buildSystemDisposition === "unsupported_subtype" ||
    failureKind === "unsupported_build_system"
  ) {
    return {
      unsupportedReason: "unsupported_build_system_unknown",
      recommendedNextLane: "manual_triage",
      coverageOutcome: "excluded"
    };
  }

  return {
    unsupportedReason: null,
    recommendedNextLane: null,
    coverageOutcome: null
  };
}
