import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MavenLombokDelombokPreparePackageRecipe } from "./maven-lombok-delombok-prepare-package.js";

const recipe = new MavenLombokDelombokPreparePackageRecipe();

describe("MavenLombokDelombokPreparePackageRecipe", () => {
  it("moves generate-sources delombok executions to prepare-package without touching dependencies", async () => {
    const pom = await readFile(
      resolve(process.cwd(), "fixtures/recipes/maven-lombok-delombok-phase-pom.xml"),
      "utf8"
    );

    const planned = recipe.plan({ "pom.xml": pom });
    expect(planned.edits).toHaveLength(1);
    expect(planned.edits[0]?.before).toContain("generate-sources");
    expect(planned.edits[0]?.after).toContain("prepare-package");

    const applied = recipe.apply({ "pom.xml": pom });
    expect(applied.files["pom.xml"]).toContain("<phase>prepare-package</phase>");
    expect(applied.files["pom.xml"]).toContain("<version>${lombok.version}</version>");
    expect(applied.files["pom.xml"]).toContain("<artifactId>maven-compiler-plugin</artifactId>");
    expect(applied.changes[0]?.changed).toBe(true);
  });

  it("moves process-sources delombok executions to prepare-package", () => {
    const pom = [
      "<project>",
      "  <build>",
      "    <plugins>",
      "      <plugin>",
      "        <groupId>org.projectlombok</groupId>",
      "        <artifactId>lombok-maven-plugin</artifactId>",
      "        <executions>",
      "          <execution>",
      "            <phase>process-sources</phase>",
      "            <goals><goal>delombok</goal></goals>",
      "          </execution>",
      "        </executions>",
      "      </plugin>",
      "    </plugins>",
      "  </build>",
      "</project>"
    ].join("\n");

    const applied = recipe.apply({ "pom.xml": pom });
    expect(applied.files["pom.xml"]).toContain("<phase>prepare-package</phase>");
  });

  it("keeps already-safe phases unchanged", () => {
    const pom = [
      "<project>",
      "  <build>",
      "    <plugins>",
      "      <plugin>",
      "        <groupId>org.projectlombok</groupId>",
      "        <artifactId>lombok-maven-plugin</artifactId>",
      "        <executions>",
      "          <execution>",
      "            <phase>prepare-package</phase>",
      "            <goals><goal>delombok</goal></goals>",
      "          </execution>",
      "        </executions>",
      "      </plugin>",
      "    </plugins>",
      "  </build>",
      "</project>"
    ].join("\n");

    const planned = recipe.plan({ "pom.xml": pom });
    expect(planned.edits).toHaveLength(0);
    expect(planned.advisories).toContain(
      "lombok-maven-plugin delombok phase (prepare-package) already avoids compile/test path"
    );
  });

  it("keeps phase-less executions unchanged with an advisory", () => {
    const pom = [
      "<project>",
      "  <build>",
      "    <plugins>",
      "      <plugin>",
      "        <groupId>org.projectlombok</groupId>",
      "        <artifactId>lombok-maven-plugin</artifactId>",
      "        <executions>",
      "          <execution>",
      "            <goals><goal>delombok</goal></goals>",
      "          </execution>",
      "        </executions>",
      "      </plugin>",
      "    </plugins>",
      "  </build>",
      "</project>"
    ].join("\n");

    const planned = recipe.plan({ "pom.xml": pom });
    expect(planned.edits).toHaveLength(0);
    expect(planned.advisories).toContain(
      "lombok-maven-plugin delombok execution has no explicit <phase>; recipe leaves config unchanged"
    );
  });

  it("keeps plugin-absent poms as deterministic no-op", () => {
    const pom = "<project><build><plugins></plugins></build></project>";
    const planned = recipe.plan({ "pom.xml": pom });
    expect(planned.edits).toHaveLength(0);
    expect(planned.advisories).toContain("lombok-maven-plugin not configured; no-op");
  });

  it("keeps non-delombok lombok plugin executions unchanged", () => {
    const pom = [
      "<project>",
      "  <build>",
      "    <plugins>",
      "      <plugin>",
      "        <groupId>org.projectlombok</groupId>",
      "        <artifactId>lombok-maven-plugin</artifactId>",
      "        <executions>",
      "          <execution>",
      "            <phase>generate-sources</phase>",
      "            <goals><goal>other-goal</goal></goals>",
      "          </execution>",
      "        </executions>",
      "      </plugin>",
      "    </plugins>",
      "  </build>",
      "</project>"
    ].join("\n");

    const planned = recipe.plan({ "pom.xml": pom });
    expect(planned.edits).toHaveLength(0);
    expect(planned.advisories).toContain(
      "lombok-maven-plugin configured without delombok goal; no-op"
    );
  });
});
