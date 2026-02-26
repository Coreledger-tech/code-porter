import { describe, expect, it } from "vitest";
import { MavenCompilerPluginBumpRecipe } from "./maven-compiler-plugin-bump.js";

const recipe = new MavenCompilerPluginBumpRecipe();

describe("MavenCompilerPluginBumpRecipe", () => {
  it("bumps legacy compiler plugin versions to 3.11.0", () => {
    const pom = [
      "<project>",
      "  <build>",
      "    <plugins>",
      "      <plugin>",
      "        <groupId>org.apache.maven.plugins</groupId>",
      "        <artifactId>maven-compiler-plugin</artifactId>",
      "        <version>3.8.1</version>",
      "      </plugin>",
      "    </plugins>",
      "  </build>",
      "</project>"
    ].join("\n");

    const planned = recipe.plan({ "pom.xml": pom });
    expect(planned.edits).toHaveLength(1);
    expect(planned.edits[0]?.description).toContain("3.11.0");

    const applied = recipe.apply({ "pom.xml": pom });
    expect(applied.files["pom.xml"]).toContain("<version>3.11.0</version>");
    expect(applied.changes.some((change) => change.changed)).toBe(true);
  });

  it("keeps plugin absent pom as deterministic no-op", () => {
    const pom = [
      "<project>",
      "  <build>",
      "    <plugins>",
      "    </plugins>",
      "  </build>",
      "</project>"
    ].join("\n");

    const planned = recipe.plan({ "pom.xml": pom });
    expect(planned.edits).toHaveLength(0);
    expect(planned.advisories).toContain("maven-compiler-plugin not configured; no-op");
  });

  it("keeps modern plugin versions unchanged", () => {
    const pom = [
      "<project>",
      "  <build>",
      "    <plugins>",
      "      <plugin>",
      "        <groupId>org.apache.maven.plugins</groupId>",
      "        <artifactId>maven-compiler-plugin</artifactId>",
      "        <version>3.11.0</version>",
      "      </plugin>",
      "    </plugins>",
      "  </build>",
      "</project>"
    ].join("\n");

    const applied = recipe.apply({ "pom.xml": pom });
    expect(applied.files["pom.xml"]).toBe(pom);
    expect(applied.changes[0]?.changed).toBe(false);
  });
});
