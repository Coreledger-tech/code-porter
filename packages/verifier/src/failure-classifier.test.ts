import { describe, expect, it } from "vitest";
import {
  classifyVerifyFailure,
  isCachedResolutionFailure
} from "./failure-classifier.js";

describe("failure classifier", () => {
  it("classifies missing tools", () => {
    const kind = classifyVerifyFailure(
      {
        status: "failed",
        reason: "spawn mvn ENOENT"
      },
      {
        buildSystem: "maven",
        command: "mvn"
      }
    );

    expect(kind).toBe("tool_missing");
  });

  it("classifies artifact resolution failures", () => {
    const kind = classifyVerifyFailure(
      {
        status: "failed",
        output:
          "PluginResolutionException: resolution is not reattempted until update interval"
      },
      {
        buildSystem: "maven",
        command: "mvn"
      }
    );

    expect(kind).toBe("artifact_resolution");
  });

  it("classifies network failures", () => {
    const kind = classifyVerifyFailure(
      {
        status: "failed",
        output: "Unknown host repo.maven.apache.org"
      },
      {
        buildSystem: "maven",
        command: "mvn"
      }
    );

    expect(kind).toBe("repo_unreachable");
  });

  it("classifies remaining build failures as code failures", () => {
    const kind = classifyVerifyFailure(
      {
        status: "failed",
        output: "[ERROR] COMPILATION ERROR: cannot find symbol"
      },
      {
        buildSystem: "maven",
        command: "mvn"
      }
    );

    expect(kind).toBe("code_failure");
  });

  it("classifies lombok IllegalAccessError as java17 plugin incompatibility", () => {
    const kind = classifyVerifyFailure(
      {
        status: "failed",
        output:
          "[ERROR] Failed to execute goal org.projectlombok:lombok-maven-plugin:1.18.12.0:delombok: IllegalAccessError"
      },
      {
        buildSystem: "maven",
        command: "mvn"
      }
    );

    expect(kind).toBe("java17_plugin_incompat");
  });

  it("classifies lombok NoSuchFieldError delombok crashes as java17 plugin incompatibility", () => {
    const kind = classifyVerifyFailure(
      {
        status: "failed",
        output:
          "[ERROR] lombok-maven-plugin: Unable to delombok: java.lang.NoSuchFieldError: JCImport qualid"
      },
      {
        buildSystem: "maven",
        command: "mvn"
      }
    );

    expect(kind).toBe("java17_plugin_incompat");
  });

  it("does not over-classify unrelated NoSuchFieldError as plugin incompatibility", () => {
    const kind = classifyVerifyFailure(
      {
        status: "failed",
        output: "[ERROR] java.lang.NoSuchFieldError: unrelated class field"
      },
      {
        buildSystem: "maven",
        command: "mvn"
      }
    );

    expect(kind).toBe("code_failure");
  });

  it("detects cached resolution signal", () => {
    expect(
      isCachedResolutionFailure({
        status: "failed",
        output:
          "artifact was not found in https://repo.maven.apache.org/maven2 during a previous attempt"
      })
    ).toBe(true);
  });
});
