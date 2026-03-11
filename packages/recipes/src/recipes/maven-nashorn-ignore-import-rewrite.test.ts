import { describe, expect, it } from "vitest";
import { MavenNashornIgnoreImportRewriteRecipe } from "./maven-nashorn-ignore-import-rewrite.js";

const recipe = new MavenNashornIgnoreImportRewriteRecipe();

describe("MavenNashornIgnoreImportRewriteRecipe", () => {
  it("rewrites Nashorn Ignore imports only in src/test/java", () => {
    const testJava = [
      "package com.example;",
      "import jdk.nashorn.internal.ir.annotations.Ignore;",
      "public class SampleTest {",
      "  @Ignore",
      "  void skips() {}",
      "}"
    ].join("\n");
    const mainJava = [
      "package com.example;",
      "import jdk.nashorn.internal.ir.annotations.Ignore;",
      "public class App {}"
    ].join("\n");

    const applied = recipe.apply({
      "src/test/java/com/example/SampleTest.java": testJava,
      "src/main/java/com/example/App.java": mainJava
    });

    expect(applied.files["src/test/java/com/example/SampleTest.java"]).toContain(
      "import org.junit.Ignore;"
    );
    expect(applied.files["src/main/java/com/example/App.java"]).toBe(mainJava);
    expect(applied.changes.some((change) => change.changed)).toBe(true);
  });

  it("returns deterministic no-op when no Nashorn imports exist in tests", () => {
    const testJava = [
      "package com.example;",
      "import org.junit.Ignore;",
      "public class SampleTest {}"
    ].join("\n");

    const planned = recipe.plan({
      "src/test/java/com/example/SampleTest.java": testJava
    });
    expect(planned.edits).toHaveLength(0);
    expect(planned.advisories).toContain(
      "No Nashorn Ignore imports found in src/test/java; recipe no-op"
    );
  });
});
