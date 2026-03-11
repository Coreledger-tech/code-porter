import { describe, expect, it } from "vitest";
import { MavenNashornCoreTestDependencyRecipe } from "./maven-nashorn-core-test-dependency.js";

const recipe = new MavenNashornCoreTestDependencyRecipe();

describe("MavenNashornCoreTestDependencyRecipe", () => {
  it("adds nashorn-core test dependency when org.openjdk.nashorn test references exist", () => {
    const pom = [
      "<project>",
      "  <dependencies>",
      "    <dependency>",
      "      <groupId>junit</groupId>",
      "      <artifactId>junit</artifactId>",
      "      <version>4.13.2</version>",
      "      <scope>test</scope>",
      "    </dependency>",
      "  </dependencies>",
      "</project>"
    ].join("\n");
    const testJava = [
      "package com.example;",
      "import org.openjdk.nashorn.internal.ir.annotations.Ignore;",
      "public class SampleTest {}"
    ].join("\n");

    const applied = recipe.apply({
      "pom.xml": pom,
      "src/test/java/com/example/SampleTest.java": testJava
    });

    expect(applied.files["pom.xml"]).toContain("<groupId>org.openjdk.nashorn</groupId>");
    expect(applied.files["pom.xml"]).toContain("<artifactId>nashorn-core</artifactId>");
    expect(applied.files["pom.xml"]).toContain("<version>15.4</version>");
  });

  it("does not duplicate nashorn-core dependency", () => {
    const pom = [
      "<project>",
      "  <dependencies>",
      "    <dependency>",
      "      <groupId>org.openjdk.nashorn</groupId>",
      "      <artifactId>nashorn-core</artifactId>",
      "      <version>15.4</version>",
      "      <scope>test</scope>",
      "    </dependency>",
      "  </dependencies>",
      "</project>"
    ].join("\n");
    const testJava = [
      "package com.example;",
      "import org.openjdk.nashorn.internal.ir.annotations.Ignore;",
      "public class SampleTest {}"
    ].join("\n");

    const applied = recipe.apply({
      "pom.xml": pom,
      "src/test/java/com/example/SampleTest.java": testJava
    });

    const occurrences = (applied.files["pom.xml"].match(/<artifactId>\s*nashorn-core\s*<\/artifactId>/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(applied.changes.every((change) => !change.changed)).toBe(true);
  });

  it("no-ops when no org.openjdk.nashorn test references are detected", () => {
    const planned = recipe.plan({
      "pom.xml": "<project><dependencies></dependencies></project>",
      "src/test/java/com/example/SampleTest.java": "class SampleTest {}"
    });

    expect(planned.edits).toHaveLength(0);
    expect(planned.advisories).toContain(
      "No org.openjdk.nashorn test references detected; dependency recipe no-op"
    );
  });
});
