import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runScanStep } from "./scan-step.js";

describe("runScanStep", () => {
  it("selects a nested Maven module as the primary build root", async () => {
    const result = await runScanStep(
      resolve(process.cwd(), "fixtures/detection/nested-maven-app")
    );

    expect(result.buildSystem).toBe("maven");
    expect(result.metadata.selectedBuildRoot).toBe("my-app");
    expect(result.metadata.selectedManifestPath).toBe("my-app/pom.xml");
    expect(result.metadata.detectedBuildSystems).toEqual(["maven"]);
  });

  it("detects go repos with nested web assets without collapsing them to unknown", async () => {
    const result = await runScanStep(resolve(process.cwd(), "fixtures/detection/go-with-web"));

    expect(result.buildSystem).toBe("go");
    expect(result.metadata.detectedBuildSystems).toEqual(["go", "node"]);
    expect(result.metadata.selectedBuildRoot).toBe(".");
    expect(result.metadata.selectedManifestPath).toBe("go.mod");
  });

  it("detects gradle roots explicitly", async () => {
    const result = await runScanStep(resolve(process.cwd(), "fixtures/detection/gradle-root"));

    expect(result.buildSystem).toBe("gradle");
    expect(result.metadata.selectedManifestPath).toBe("build.gradle");
  });

  it("detects python roots explicitly", async () => {
    const result = await runScanStep(resolve(process.cwd(), "fixtures/detection/python-root"));

    expect(result.buildSystem).toBe("python");
    expect(result.metadata.selectedManifestPath).toBe("pyproject.toml");
  });

  it("reports no supported manifest with explicit disposition", async () => {
    const result = await runScanStep(resolve(process.cwd(), "fixtures/detection/no-manifest"));

    expect(result.buildSystem).toBe("unknown");
    expect(result.metadata.buildSystemDisposition).toBe("no_supported_manifest");
    expect(result.metadata.buildSystemReason).toContain("No supported build manifest found");
    expect(result.metadata.selectedBuildRoot).toBeNull();
    expect(result.metadata.selectedManifestPath).toBeNull();
  });
});
