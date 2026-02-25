import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultVerifier } from "./index.js";

describe("DefaultVerifier", () => {
  it("degrades gracefully when build tools are unavailable", async () => {
    const repo = await mkdtemp(join(tmpdir(), "code-porter-verifier-"));
    await writeFile(join(repo, "pom.xml"), "<project></project>", "utf8");
    await mkdir(join(repo, "src/test"), { recursive: true });

    const verifier = new DefaultVerifier();
    const result = await verifier.run(
      {
        buildSystem: "maven",
        hasTests: true,
        metadata: {
          gitBranch: "main",
          toolAvailability: {
            mvn: false,
            gradle: false,
            npm: false,
            node: true
          },
          detectedFiles: ["pom.xml"]
        }
      },
      repo,
      {
        maxChangeLines: 100,
        maxFilesChanged: 10,
        requireTestsIfPresent: true,
        allowedBuildSystems: ["maven"],
        confidenceThresholds: {
          pass: 70,
          needsReview: 55
        }
      }
    );

    expect(result.compile.status).toBe("not_run");
    expect(result.tests.status).toBe("not_run");
    expect(result.staticChecks.status).toBe("passed");
  });
});
