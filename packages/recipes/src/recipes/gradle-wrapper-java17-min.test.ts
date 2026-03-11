import { describe, expect, it } from "vitest";
import { GradleWrapperJava17MinRecipe } from "./gradle-wrapper-java17-min.js";

const recipe = new GradleWrapperJava17MinRecipe();

describe("GradleWrapperJava17MinRecipe", () => {
  it("bumps wrapper distribution when below Java 17 compatible minimum", () => {
    const wrapper = [
      "distributionBase=GRADLE_USER_HOME",
      "distributionPath=wrapper/dists",
      "distributionUrl=https\\://services.gradle.org/distributions/gradle-6.9.4-bin.zip",
      "zipStoreBase=GRADLE_USER_HOME",
      "zipStorePath=wrapper/dists"
    ].join("\n");

    const applied = recipe.apply({
      "gradle/wrapper/gradle-wrapper.properties": wrapper
    });
    expect(applied.files["gradle/wrapper/gradle-wrapper.properties"]).toContain(
      "gradle-7.6.4-bin.zip"
    );
    expect(applied.changes[0]?.changed).toBe(true);
  });

  it("keeps compatible wrapper versions unchanged", () => {
    const wrapper =
      "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.7-bin.zip\n";
    const applied = recipe.apply({
      "gradle/wrapper/gradle-wrapper.properties": wrapper
    });
    expect(applied.files["gradle/wrapper/gradle-wrapper.properties"]).toBe(wrapper);
    expect(applied.changes[0]?.changed).toBe(false);
  });

  it("no-ops when wrapper properties file is absent", () => {
    const planned = recipe.plan({
      "build.gradle": "plugins { id 'java' }"
    });
    expect(planned.edits).toHaveLength(0);
    expect(planned.advisories).toContain("gradle-wrapper.properties not found; recipe skipped");
  });
});
