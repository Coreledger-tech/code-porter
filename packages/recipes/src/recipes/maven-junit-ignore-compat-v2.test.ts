import { describe, expect, it } from "vitest";
import { MavenJunitIgnoreCompatV2Recipe } from "./maven-junit-ignore-compat-v2.js";

const recipe = new MavenJunitIgnoreCompatV2Recipe();

describe("MavenJunitIgnoreCompatV2Recipe", () => {
  it("rewrites @Ignore to @Disabled when JUnit5 is present", () => {
    const pom = [
      "<project>",
      "  <dependencies>",
      "    <dependency>",
      "      <groupId>org.junit.jupiter</groupId>",
      "      <artifactId>junit-jupiter</artifactId>",
      "      <version>5.10.0</version>",
      "      <scope>test</scope>",
      "    </dependency>",
      "  </dependencies>",
      "</project>"
    ].join("\n");
    const testJava = [
      "package com.example;",
      "import org.openjdk.nashorn.internal.ir.annotations.Ignore;",
      "public class SampleTest {",
      "  @Ignore",
      "  void skips() {}",
      "}"
    ].join("\n");

    const applied = recipe.apply({
      "pom.xml": pom,
      "src/test/java/com/example/SampleTest.java": testJava
    });

    const updated = applied.files["src/test/java/com/example/SampleTest.java"];
    expect(updated).toContain("import org.junit.jupiter.api.Disabled;");
    expect(updated).toContain("@Disabled");
    expect(updated).not.toContain("@Ignore");
    expect(updated).not.toContain("org.openjdk.nashorn.internal.ir.annotations.Ignore");
  });

  it("keeps @Ignore for JUnit4 lane and normalizes import/dependency", () => {
    const pom = [
      "<project>",
      "  <dependencies>",
      "    <dependency>",
      "      <groupId>org.projectlombok</groupId>",
      "      <artifactId>lombok</artifactId>",
      "      <version>1.18.30</version>",
      "      <scope>provided</scope>",
      "    </dependency>",
      "  </dependencies>",
      "</project>"
    ].join("\n");
    const testJava = [
      "package com.example;",
      "import jdk.nashorn.internal.ir.annotations.Ignore;",
      "public class SampleTest {",
      "  @Ignore",
      "  void skips() {}",
      "}"
    ].join("\n");

    const applied = recipe.apply({
      "pom.xml": pom,
      "src/test/java/com/example/SampleTest.java": testJava
    });

    const updatedTest = applied.files["src/test/java/com/example/SampleTest.java"];
    expect(updatedTest).toContain("import org.junit.Ignore;");
    expect(updatedTest).toContain("@Ignore");
    expect(applied.files["pom.xml"]).toContain("<groupId>junit</groupId>");
    expect(applied.files["pom.xml"]).toContain("<artifactId>junit</artifactId>");
    expect(applied.files["pom.xml"]).toContain("<version>4.13.2</version>");
  });

  it("is no-op when no @Ignore usage exists", () => {
    const planned = recipe.plan({
      "pom.xml": "<project/>",
      "src/test/java/com/example/SampleTest.java": "class SampleTest {}"
    });

    expect(planned.edits).toHaveLength(0);
    expect(planned.advisories).toContain("No @Ignore usage detected in src/test/java; recipe skipped");
  });
});
