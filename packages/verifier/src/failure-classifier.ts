import type { CheckResult, VerifyFailureKind } from "@code-porter/core/src/models.js";

const TOOL_MISSING_PATTERNS = [
  /\benoent\b/i,
  /command\s+not\s+found/i,
  /command '.+' not available/i,
  /spawn\s+\S+\s+enoent/i
];

const NETWORK_PATTERNS = [
  /unknown host/i,
  /name or service not known/i,
  /temporary failure in name resolution/i,
  /connection timed out/i,
  /connect timed out/i,
  /connection refused/i,
  /connection reset/i,
  /pkix/i,
  /ssl/i,
  /proxy/i,
  /unable to tunnel through proxy/i
];

const ARTIFACT_PATTERNS = [
  /pluginresolutionexception/i,
  /could not find artifact/i,
  /could not transfer artifact/i,
  /resolution is not reattempted/i,
  /was not found in .* during a previous attempt/i,
  /failed to read artifact descriptor/i,
  /non-resolvable parent pom/i,
  /dependency resolution/i,
  /\.(lastupdated|lastUpdated)/i
];

const JAVA17_PLUGIN_INCOMPAT_PATTERNS = [
  /illegalaccesserror/i,
  /nosuchfielderror/i,
  /unable to delombok/i,
  /\bjcimport\b/i,
  /\bqualid\b/i
];

const JAVA17_MODULE_ACCESS_PATTERNS = [
  /sun\.nio\.ch\.filechannelimpl/i,
  /module\s+java\.base\s+does\s+not\s+export\s+sun\.nio\.ch/i,
  /java\.base\/sun\.nio\.ch/i
];

const CHRONICLE_JAVA17_REFLECTIVE_ACCESS_PATTERNS = [
  /nosuchfieldexception:\s*address/i,
  /net\.openhft\.chronicle/i
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function combinedText(check: CheckResult): string {
  return `${check.reason ?? ""}\n${check.output ?? ""}`;
}

export function classifyVerifyFailure(
  check: CheckResult,
  context: {
    command?: string;
    buildSystem: "maven" | "gradle" | "node" | "python" | "go" | "unknown";
    phase: "compile" | "tests" | "static";
  }
): VerifyFailureKind | undefined {
  if (check.status === "passed") {
    return undefined;
  }

  const text = combinedText(check);

  if (matchesAny(text, TOOL_MISSING_PATTERNS)) {
    return "tool_missing";
  }

  if (matchesAny(text, NETWORK_PATTERNS)) {
    return "repo_unreachable";
  }

  if (matchesAny(text, ARTIFACT_PATTERNS)) {
    return "artifact_resolution";
  }

  if (
    /lombok-maven-plugin/i.test(text) &&
    matchesAny(text, JAVA17_PLUGIN_INCOMPAT_PATTERNS)
  ) {
    return "java17_plugin_incompat";
  }

  if (
    context.phase === "tests" &&
    ((/illegalaccesserror/i.test(text) && matchesAny(text, JAVA17_MODULE_ACCESS_PATTERNS)) ||
      CHRONICLE_JAVA17_REFLECTIVE_ACCESS_PATTERNS.every((pattern) => pattern.test(text)))
  ) {
    return "java17_module_access_test_failure";
  }

  if (
    check.status === "failed" &&
    (context.buildSystem === "maven" ||
      context.buildSystem === "gradle" ||
      context.buildSystem === "node")
  ) {
    return context.phase === "tests" ? "code_test_failure" : "code_compile_failure";
  }

  return "unknown";
}

export function isCachedResolutionFailure(check: CheckResult): boolean {
  const text = combinedText(check);
  return /resolution is not reattempted|was not found in .* during a previous attempt|cached/i.test(
    text
  );
}

export function suggestRemediations(check: CheckResult): string[] {
  const failureKind = check.failureKind;
  if (failureKind === "tool_missing") {
    return ["Install required build tools and ensure they are available on PATH."];
  }

  if (failureKind === "repo_unreachable") {
    return [
      "Verify network connectivity and proxy settings for artifact repositories.",
      "Retry when Maven Central or configured proxy is reachable."
    ];
  }

  if (failureKind === "artifact_resolution") {
    return [
      "Retry with Maven force-update (-U).",
      "Resolve repository/mirror configuration issues if artifacts cannot be fetched."
    ];
  }

  if (failureKind === "budget_exceeded") {
    return [
      "Review run budget limits in policy (verify minutes, retries, evidence size).",
      "Reduce recipe scope or split campaign into smaller runs."
    ];
  }

  if (failureKind === "java17_plugin_incompat") {
    return [
      "Shift delombok execution out of compile/test path (prepare-package recommended).",
      "Keep Lombok dependency version unchanged unless a separate compile failure proves otherwise.",
      "Re-run verify after plugin lifecycle update."
    ];
  }

  if (failureKind === "java17_module_access_test_failure") {
    return [
      "Add only the required module open to test JVM args: --add-opens=java.base/sun.nio.ch=ALL-UNNAMED.",
      "For Chronicle NoSuchFieldException(address) failures, add --add-opens=java.base/java.nio=ALL-UNNAMED.",
      "Apply the change in existing surefire/failsafe plugin argLine blocks and rerun tests."
    ];
  }

  return [];
}
