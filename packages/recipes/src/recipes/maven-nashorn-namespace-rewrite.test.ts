import { describe, expect, it } from "vitest";
import { MavenNashornNamespaceRewriteRecipe } from "./maven-nashorn-namespace-rewrite.js";

const recipe = new MavenNashornNamespaceRewriteRecipe();

describe("MavenNashornNamespaceRewriteRecipe", () => {
  it("rewrites jdk.nashorn namespace only in src/test/java files", () => {
    const testJava = [
      "package com.example;",
      "import jdk.nashorn.internal.ir.annotations.Ignore;",
      "import jdk.nashorn.api.scripting.ScriptObjectMirror;",
      "public class SampleTest {}"
    ].join("\n");
    const mainJava = [
      "package com.example;",
      "import jdk.nashorn.api.scripting.ScriptObjectMirror;",
      "public class App {}"
    ].join("\n");

    const applied = recipe.apply({
      "src/test/java/com/example/SampleTest.java": testJava,
      "src/main/java/com/example/App.java": mainJava
    });

    expect(applied.files["src/test/java/com/example/SampleTest.java"]).toContain(
      "org.openjdk.nashorn.internal.ir.annotations.Ignore"
    );
    expect(applied.files["src/test/java/com/example/SampleTest.java"]).toContain(
      "org.openjdk.nashorn.api.scripting.ScriptObjectMirror"
    );
    expect(applied.files["src/main/java/com/example/App.java"]).toBe(mainJava);
  });

  it("is idempotent on second apply", () => {
    const testJava = [
      "package com.example;",
      "import jdk.nashorn.internal.ir.annotations.Ignore;",
      "public class SampleTest {}"
    ].join("\n");

    const first = recipe.apply({
      "src/test/java/com/example/SampleTest.java": testJava
    });
    const second = recipe.apply(first.files);

    expect(second.files["src/test/java/com/example/SampleTest.java"]).toBe(
      first.files["src/test/java/com/example/SampleTest.java"]
    );
    expect(second.changes.every((change) => !change.changed)).toBe(true);
  });
});
