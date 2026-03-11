import { describe, expect, it } from "vitest";
import { detectRuntimeProcessConflicts, parseReleaseRcArgs, validateRcTag } from "./release-rc.js";

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

  it("detects running worker/pr-poller conflicts", () => {
    const mockExec = ((command: string, args: string[]) => {
      if (command !== "pgrep") {
        throw new Error("unexpected command");
      }
      if (args[1] === "apps/api/src/worker.ts") {
        return {
          status: 0,
          stdout: "123 node apps/api/src/worker.ts\n",
          stderr: ""
        } as any;
      }
      return {
        status: 1,
        stdout: "",
        stderr: ""
      } as any;
    }) as any;

    const conflicts = detectRuntimeProcessConflicts(mockExec);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain("worker:");
  });

  it("returns no conflicts when worker/pr-poller are not running", () => {
    const mockExec = (() => {
      return {
        status: 1,
        stdout: "",
        stderr: ""
      } as any;
    }) as any;

    expect(detectRuntimeProcessConflicts(mockExec)).toEqual([]);
  });
});
