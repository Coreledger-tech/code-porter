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
