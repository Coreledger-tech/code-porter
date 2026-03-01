import { describe, expect, it } from "vitest";
import { GradleJava17BaselineRecipe } from "./gradle-java17-baseline.js";

const recipe = new GradleJava17BaselineRecipe();

describe("GradleJava17BaselineRecipe", () => {
  it("updates Groovy DSL sourceCompatibility and targetCompatibility to Java 17", () => {
    const build = [
      "plugins { id 'java' }",
      "sourceCompatibility = JavaVersion.VERSION_1_8",
      "targetCompatibility = 11"
    ].join("\n");

    const applied = recipe.apply({ "build.gradle": build });
    expect(applied.files["build.gradle"]).toContain("sourceCompatibility = JavaVersion.VERSION_17");
    expect(applied.files["build.gradle"]).toContain("targetCompatibility = JavaVersion.VERSION_17");
  });

  it("updates Groovy DSL toolchain declarations to Java 17", () => {
    const build = [
      "plugins { id 'java' }",
      "java {",
      "  toolchain {",
      "    languageVersion = JavaLanguageVersion.of(8)",
      "  }",
      "}"
    ].join("\n");

    const applied = recipe.apply({ "build.gradle": build });
    expect(applied.files["build.gradle"]).toContain("languageVersion = JavaLanguageVersion.of(17)");
  });

  it("updates Kotlin DSL toolchain declarations to Java 17", () => {
    const build = [
      "plugins { java }",
      "java {",
      "  toolchain {",
      "    languageVersion.set(JavaLanguageVersion.of(11))",
      "  }",
      "}"
    ].join("\n");

    const applied = recipe.apply({ "build.gradle.kts": build });
    expect(applied.files["build.gradle.kts"]).toContain(
      "languageVersion.set(JavaLanguageVersion.of(17))"
    );
  });

  it("keeps files unchanged when declarations are absent", () => {
    const build = "plugins { id 'java' }\nrepositories { mavenCentral() }\n";
    const planned = recipe.plan({ "build.gradle": build });
    expect(planned.edits).toHaveLength(0);
    expect(planned.advisories).toContain("No existing Gradle Java baseline declarations required updates");
  });

  it("does not rewrite Android DSL content", () => {
    const build = [
      "plugins { id 'com.android.application' }",
      "android {",
      "  compileSdk 34",
      "}"
    ].join("\n");

    const applied = recipe.apply({ "build.gradle": build });
    expect(applied.files["build.gradle"]).toBe(build);
  });
});
