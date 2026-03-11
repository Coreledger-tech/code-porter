import { describe, expect, it } from "vitest";
import { GradleGuardedPropertiesBaselineRecipe } from "./gradle-guarded-properties-baseline.js";

const recipe = new GradleGuardedPropertiesBaselineRecipe();

describe("GradleGuardedPropertiesBaselineRecipe", () => {
  it("creates gradle.properties with guarded baseline keys when missing", () => {
    const applied = recipe.apply({
      "build.gradle": "plugins { id 'com.android.application' }\n"
    });

    const gradleProperties = applied.files["gradle.properties"];
    expect(gradleProperties).toContain("org.gradle.java.installations.auto-detect=true");
    expect(gradleProperties).toContain("org.gradle.java.installations.auto-download=true");
    expect(applied.changes[0]?.changed).toBe(true);
  });

  it("normalizes existing values and preserves unrelated properties", () => {
    const existing = [
      "org.gradle.jvmargs=-Xmx2g",
      "org.gradle.java.installations.auto-detect=false",
      "org.gradle.java.installations.auto-download=false"
    ].join("\n");

    const applied = recipe.apply({
      "gradle.properties": existing
    });

    const gradleProperties = applied.files["gradle.properties"];
    expect(gradleProperties).toContain("org.gradle.jvmargs=-Xmx2g");
    expect(gradleProperties).toContain("org.gradle.java.installations.auto-detect=true");
    expect(gradleProperties).toContain("org.gradle.java.installations.auto-download=true");
  });

  it("is idempotent once properties are normalized", () => {
    const normalized = [
      "org.gradle.java.installations.auto-detect=true",
      "org.gradle.java.installations.auto-download=true"
    ].join("\n");

    const first = recipe.apply({
      "gradle.properties": normalized
    });
    const second = recipe.apply(first.files);

    expect(second.files["gradle.properties"]).toBe(normalized);
    expect(second.changes.every((change) => !change.changed)).toBe(true);
  });
});
