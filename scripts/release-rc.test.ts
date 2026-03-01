import { describe, expect, it } from "vitest";
import { parseReleaseRcArgs, validateRcTag } from "./release-rc.js";

describe("release:rc helpers", () => {
  it("rejects missing --tag", () => {
    expect(() => parseReleaseRcArgs([])).toThrow(/Missing required --tag argument/);
  });

  it("rejects malformed tags", () => {
    expect(() => validateRcTag("rc.2")).toThrow(/Invalid RC tag/);
    expect(() => parseReleaseRcArgs(["--tag", "v1.0.0"])).toThrow(/Invalid RC tag/);
  });

  it("accepts semver rc tags", () => {
    expect(parseReleaseRcArgs(["--tag", "v1.0.0-rc.2"])).toEqual({
      tag: "v1.0.0-rc.2"
    });
    expect(parseReleaseRcArgs(["--tag=v2.4.1-rc.7"])).toEqual({
      tag: "v2.4.1-rc.7"
    });
  });
});
