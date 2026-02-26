import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ScanResult } from "@code-porter/core/src/models.js";
import { DefaultRecipeEngine } from "./engine.js";
import { MavenCompilerPluginBumpRecipe } from "./recipes/maven-compiler-plugin-bump.js";
import { MavenCompilerTarget17Recipe } from "./recipes/maven-compiler-target17.js";
import { MavenSurefireSafeRecipe } from "./recipes/maven-surefire-safe.js";

const scanResult: ScanResult = {
  buildSystem: "maven",
  hasTests: true,
  metadata: {
    gitBranch: "main",
    toolAvailability: {
      mvn: true,
      gradle: false,
      npm: false,
      node: true
    },
    detectedFiles: ["pom.xml"]
  }
};

describe("DefaultRecipeEngine", () => {
  it("plans and applies deterministic Maven upgrades", async () => {
    const fixturePomPath = resolve(process.cwd(), "fixtures/java-maven-simple/pom.xml");
    const pom = await readFile(fixturePomPath, "utf8");

    const engine = new DefaultRecipeEngine([
      new MavenCompilerTarget17Recipe(),
      new MavenCompilerPluginBumpRecipe(),
      new MavenSurefireSafeRecipe()
    ]);

    const plan = engine.plan(scanResult, { "pom.xml": pom });

    expect(plan.plannedEdits.length).toBeGreaterThan(0);
    expect(
      plan.plannedEdits.some((edit) => edit.description.includes("maven.compiler.source"))
    ).toBe(true);
    expect(
      plan.plannedEdits.some((edit) => edit.description.includes("maven-surefire-plugin"))
    ).toBe(true);

    const apply = engine.apply(scanResult, { "pom.xml": pom });
    const updatedPom = apply.files["pom.xml"];

    expect(updatedPom).toContain("<maven.compiler.source>17</maven.compiler.source>");
    expect(updatedPom).toContain("<maven.compiler.target>17</maven.compiler.target>");
    expect(updatedPom).toMatch(
      /<artifactId>\s*maven-compiler-plugin\s*<\/artifactId>[\s\S]*?<version>\s*3\.11\.0\s*<\/version>/
    );
    expect(updatedPom).toMatch(
      /<artifactId>\s*maven-surefire-plugin\s*<\/artifactId>[\s\S]*?<version>\s*3\.2\.5\s*<\/version>/
    );
    expect(apply.changes.some((change) => change.changed)).toBe(true);
  });

  it("keeps surefire recipe as safe no-op when plugin is absent", () => {
    const engine = new DefaultRecipeEngine([new MavenSurefireSafeRecipe()]);
    const pomWithoutSurefire = `<project><build><plugins></plugins></build></project>`;

    const plan = engine.plan(scanResult, { "pom.xml": pomWithoutSurefire });
    expect(plan.plannedEdits).toHaveLength(0);
    expect(plan.advisories.some((advisory) => advisory.includes("safe no-op"))).toBe(true);
  });
});
