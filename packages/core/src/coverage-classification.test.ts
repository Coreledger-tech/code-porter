import { describe, expect, it } from "vitest";
import { deriveCoverageClassification } from "./coverage-classification.js";

describe("deriveCoverageClassification", () => {
  it("maps excluded go repos to the go readiness lane", () => {
    expect(
      deriveCoverageClassification({
        buildSystem: "go",
        buildSystemDisposition: "excluded_by_policy",
        failureKind: "unsupported_build_system",
        status: "needs_review"
      })
    ).toEqual({
      unsupportedReason: "unsupported_build_system_go",
      recommendedNextLane: "go_readiness_lane",
      coverageOutcome: "excluded"
    });
  });

  it("maps excluded node repos to the node readiness lane", () => {
    expect(
      deriveCoverageClassification({
        buildSystem: "node",
        buildSystemDisposition: "excluded_by_policy",
        failureKind: "unsupported_build_system",
        status: "needs_review"
      })
    ).toEqual({
      unsupportedReason: "unsupported_build_system_node",
      recommendedNextLane: "node_readiness_lane",
      coverageOutcome: "excluded"
    });
  });

  it("maps excluded python repos to the python readiness lane", () => {
    expect(
      deriveCoverageClassification({
        buildSystem: "python",
        buildSystemDisposition: "excluded_by_policy",
        failureKind: "unsupported_build_system",
        status: "needs_review"
      })
    ).toEqual({
      unsupportedReason: "unsupported_build_system_python",
      recommendedNextLane: "python_readiness_lane",
      coverageOutcome: "excluded"
    });
  });

  it("maps gradle JVM repos without wrapper to the wrapper lane", () => {
    expect(
      deriveCoverageClassification({
        buildSystem: "gradle",
        buildSystemDisposition: "supported",
        gradleProjectType: "jvm",
        gradleWrapperPath: null,
        failureKind: "tool_missing",
        status: "blocked"
      })
    ).toEqual({
      unsupportedReason: "unsupported_subtype_gradle_no_wrapper",
      recommendedNextLane: "gradle_jvm_wrapper_lane",
      coverageOutcome: "excluded"
    });
  });

  it("maps Android repos without guarded support to guarded-baseline recommendation", () => {
    expect(
      deriveCoverageClassification({
        buildSystem: "gradle",
        buildSystemDisposition: "unsupported_subtype",
        gradleProjectType: "android",
        gradleWrapperPath: "gradlew",
        failureKind: "unsupported_build_system",
        status: "needs_review"
      })
    ).toEqual({
      unsupportedReason: "unsupported_subtype_android_unguarded",
      recommendedNextLane: "android_guarded_baseline",
      coverageOutcome: "excluded"
    });
  });

  it("maps missing manifests to manifest follow-up", () => {
    expect(
      deriveCoverageClassification({
        buildSystem: "unknown",
        buildSystemDisposition: "no_supported_manifest",
        status: "needs_review"
      })
    ).toEqual({
      unsupportedReason: "no_supported_manifest",
      recommendedNextLane: "manifest_follow_up",
      coverageOutcome: "excluded"
    });
  });

  it("keeps guarded Android applied/noop outcomes out of unsupported buckets", () => {
    expect(
      deriveCoverageClassification({
        buildSystem: "gradle",
        buildSystemDisposition: "supported",
        gradleProjectType: "android",
        gradleWrapperPath: "gradlew",
        failureKind: "guarded_baseline_applied",
        status: "needs_review"
      })
    ).toEqual({
      unsupportedReason: null,
      recommendedNextLane: null,
      coverageOutcome: "guarded_applied"
    });

    expect(
      deriveCoverageClassification({
        buildSystem: "gradle",
        buildSystemDisposition: "supported",
        gradleProjectType: "android",
        gradleWrapperPath: "gradlew",
        failureKind: "guarded_baseline_noop",
        status: "needs_review"
      })
    ).toEqual({
      unsupportedReason: null,
      recommendedNextLane: null,
      coverageOutcome: "guarded_noop"
    });
  });

  it("marks supported Android runs that do not finish as guarded no-op or applied as guarded_blocked", () => {
    expect(
      deriveCoverageClassification({
        buildSystem: "gradle",
        buildSystemDisposition: "supported",
        gradleProjectType: "android",
        gradleWrapperPath: "gradlew",
        failureKind: "manual_review_required",
        status: "needs_review"
      })
    ).toEqual({
      unsupportedReason: null,
      recommendedNextLane: null,
      coverageOutcome: "guarded_blocked"
    });
  });
});
