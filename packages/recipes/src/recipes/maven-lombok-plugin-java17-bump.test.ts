import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MavenLombokPluginJava17BumpRecipe } from "./maven-lombok-plugin-java17-bump.js";

const recipe = new MavenLombokPluginJava17BumpRecipe();

describe("MavenLombokPluginJava17BumpRecipe", () => {
  it("bumps legacy lombok plugin versions without touching dependency versions", async () => {
    const pom = await readFile(
      resolve(process.cwd(), "fixtures/recipes/maven-lombok-plugin-legacy-pom.xml"),
      "utf8"
    );

    const planned = recipe.plan({ "pom.xml": pom });
    expect(planned.edits).toHaveLength(1);
    expect(planned.edits[0]?.description).toContain("1.18.20.0");

    const applied = recipe.apply({ "pom.xml": pom });
    expect(applied.files["pom.xml"]).toContain("<version>1.18.20.0</version>");
    expect(applied.files["pom.xml"]).toContain("<lombok.version>1.18.24</lombok.version>");
    expect(applied.files["pom.xml"]).toMatch(
      /<artifactId>\s*maven-compiler-plugin\s*<\/artifactId>[\s\S]*?<version>\s*3\.8\.1\s*<\/version>/
    );
    expect(applied.changes.some((change) => change.changed)).toBe(true);
  });

  it("keeps already-modern plugin versions unchanged", () => {
    const pom = [
      "<project>",
      "  <build>",
      "    <plugins>",
      "      <plugin>",
      "        <groupId>org.projectlombok</groupId>",
      "        <artifactId>lombok-maven-plugin</artifactId>",
      "        <version>1.18.20.0</version>",
      "      </plugin>",
      "    </plugins>",
      "  </build>",
      "</project>"
    ].join("\n");

    const applied = recipe.apply({ "pom.xml": pom });
    expect(applied.files["pom.xml"]).toBe(pom);
    expect(applied.changes[0]?.changed).toBe(false);
  });

  it("keeps plugin-absent poms as deterministic no-op", () => {
    const pom = "<project><build><plugins></plugins></build></project>";
    const planned = recipe.plan({ "pom.xml": pom });
    expect(planned.edits).toHaveLength(0);
    expect(planned.advisories).toContain("lombok-maven-plugin not configured; no-op");
  });

  it("keeps versionless plugin declarations unchanged with an advisory", () => {
    const pom = [
      "<project>",
      "  <build>",
      "    <plugins>",
      "      <plugin>",
      "        <groupId>org.projectlombok</groupId>",
      "        <artifactId>lombok-maven-plugin</artifactId>",
      "      </plugin>",
      "    </plugins>",
      "  </build>",
      "</project>"
    ].join("\n");

    const planned = recipe.plan({ "pom.xml": pom });
    expect(planned.edits).toHaveLength(0);
    expect(planned.advisories).toContain(
      "lombok-maven-plugin exists without <version>; recipe leaves config unchanged"
    );
  });
});
