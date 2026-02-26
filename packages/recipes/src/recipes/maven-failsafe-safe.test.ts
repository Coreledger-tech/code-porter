import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MavenFailsafeSafeRecipe } from "./maven-failsafe-safe.js";

const recipe = new MavenFailsafeSafeRecipe();

describe("MavenFailsafeSafeRecipe", () => {
  it("bumps legacy failsafe plugin versions", async () => {
    const pom = await readFile(
      resolve(process.cwd(), "fixtures/recipes/maven-failsafe-legacy-pom.xml"),
      "utf8"
    );

    const planned = recipe.plan({ "pom.xml": pom });
    expect(planned.edits).toHaveLength(1);
    expect(planned.edits[0]?.description).toContain("3.2.5");

    const applied = recipe.apply({ "pom.xml": pom });
    expect(applied.files["pom.xml"]).toContain("<version>3.2.5</version>");
    expect(applied.changes.some((change) => change.changed)).toBe(true);
  });

  it("keeps plugin-absent poms as deterministic no-op", () => {
    const pom = "<project><build><plugins></plugins></build></project>";
    const planned = recipe.plan({ "pom.xml": pom });
    expect(planned.edits).toHaveLength(0);
    expect(planned.advisories).toContain(
      "maven-failsafe-plugin not configured; safe no-op applied"
    );
  });

  it("keeps modern failsafe versions unchanged", () => {
    const pom = [
      "<project>",
      "  <build>",
      "    <plugins>",
      "      <plugin>",
      "        <groupId>org.apache.maven.plugins</groupId>",
      "        <artifactId>maven-failsafe-plugin</artifactId>",
      "        <version>3.2.5</version>",
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

