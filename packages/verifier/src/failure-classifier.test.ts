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
        command: "mvn",
        phase: "compile"
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
        command: "mvn",
        phase: "compile"
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
        command: "mvn",
        phase: "compile"
      }
    );

    expect(kind).toBe("repo_unreachable");
  });

  it("classifies remaining build failures as compile failures", () => {
    const kind = classifyVerifyFailure(
      {
        status: "failed",
        output: "[ERROR] COMPILATION ERROR: cannot find symbol"
      },
      {
        buildSystem: "maven",
        command: "mvn",
        phase: "compile"
      }
    );

    expect(kind).toBe("code_compile_failure");
  });

  it("classifies test failures separately", () => {
    const kind = classifyVerifyFailure(
      {
        status: "failed",
        output: "[ERROR] Tests run: 1, Failures: 1"
      },
      {
        buildSystem: "maven",
        command: "mvn",
        phase: "tests"
      }
    );

    expect(kind).toBe("code_test_failure");
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
        command: "mvn",
        phase: "compile"
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
        command: "mvn",
        phase: "compile"
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
        command: "mvn",
        phase: "compile"
      }
    );

    expect(kind).toBe("code_compile_failure");
  });

  it("classifies Java 17 module-access test runtime failures", () => {
    const kind = classifyVerifyFailure(
      {
        status: "failed",
        output:
          "java.lang.IllegalAccessError: class org.apache.lucene.store.MMapDirectory cannot access class sun.nio.ch.FileChannelImpl because module java.base does not export sun.nio.ch"
      },
      {
        buildSystem: "maven",
        command: "mvn",
        phase: "tests"
      }
    );

    expect(kind).toBe("java17_module_access_test_failure");
  });

  it("does not classify generic IllegalAccessError test failures as module access", () => {
    const kind = classifyVerifyFailure(
      {
        status: "failed",
        output:
          "java.lang.IllegalAccessError: class com.example.A cannot access class com.example.internal.B"
      },
      {
        buildSystem: "maven",
        command: "mvn",
        phase: "tests"
      }
    );

    expect(kind).toBe("code_test_failure");
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
