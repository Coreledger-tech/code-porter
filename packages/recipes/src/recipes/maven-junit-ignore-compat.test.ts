import { describe, expect, it } from "vitest";
import { MavenJunitIgnoreCompatRecipe } from "./maven-junit-ignore-compat.js";

const recipe = new MavenJunitIgnoreCompatRecipe();

describe("MavenJunitIgnoreCompatRecipe", () => {
  it("migrates @Ignore to @Disabled when JUnit 5 is present", () => {
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
      "import org.junit.Ignore;",
      "public class SampleTest {",
      "  @Ignore",
      "  void skips() {}",
      "}"
    ].join("\n");

    const applied = recipe.apply({
      "pom.xml": pom,
      "src/test/java/com/example/SampleTest.java": testJava
    });

    expect(applied.files["src/test/java/com/example/SampleTest.java"]).toContain(
      "import org.junit.jupiter.api.Disabled;"
    );
    expect(applied.files["src/test/java/com/example/SampleTest.java"]).toContain("@Disabled");
    expect(applied.files["src/test/java/com/example/SampleTest.java"]).not.toContain("@Ignore");
  });

  it("ensures junit:junit dependency when @Ignore is used and JUnit 5 is absent", () => {
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
      "  <build>",
      "    <plugins>",
      "      <plugin>",
      "        <groupId>org.apache.maven.plugins</groupId>",
      "        <artifactId>maven-surefire-plugin</artifactId>",
      "        <version>3.2.5</version>",
      "      </plugin>",
      "    </plugins>",
      "  </build>",
      "</project>"
    ].join("\n");
    const testJava = [
      "package com.example;",
      "import org.junit.Ignore;",
      "public class SampleTest {",
      "  @Ignore",
      "  void skips() {}",
      "}"
    ].join("\n");

    const applied = recipe.apply({
      "pom.xml": pom,
      "src/test/java/com/example/SampleTest.java": testJava
    });

    expect(applied.files["pom.xml"]).toContain("<groupId>junit</groupId>");
    expect(applied.files["pom.xml"]).toContain("<artifactId>junit</artifactId>");
    expect(applied.files["pom.xml"]).toContain("<version>4.13.2</version>");
    expect(applied.files["pom.xml"]).toContain(
      "<artifactId>maven-surefire-plugin</artifactId>"
    );
  });

  it("no-ops when @Ignore is not used in test sources", () => {
    const testJava = [
      "package com.example;",
      "import org.junit.jupiter.api.Test;",
      "public class SampleTest {",
      "  @Test",
      "  void runs() {}",
      "}"
    ].join("\n");

    const planned = recipe.plan({
      "src/test/java/com/example/SampleTest.java": testJava,
      "pom.xml": "<project/>"
    });

    expect(planned.edits).toHaveLength(0);
    expect(planned.advisories).toContain(
      "No @Ignore usage detected in src/test/java; recipe skipped"
    );
  });
});
