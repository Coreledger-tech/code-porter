import { access, mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSafeCleanupRoot,
  cleanupEntriesOlderThan,
  ttlDaysFromEnv
} from "./cleanup.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("cleanup operations", () => {
  it("rejects unsafe cleanup root", () => {
    expect(() => assertSafeCleanupRoot("/")).toThrow(/unsafe root path/i);
  });

  it("deletes only stale entries older than ttl", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-porter-cleanup-"));
    const staleDir = join(root, "stale");
    const freshDir = join(root, "fresh");

    await mkdir(staleDir, { recursive: true });
    await mkdir(freshDir, { recursive: true });
    await writeFile(join(staleDir, "file.txt"), "stale", "utf8");
    await writeFile(join(freshDir, "file.txt"), "fresh", "utf8");

    const now = Date.now();
    const staleTime = new Date(now - 10 * 24 * 60 * 60 * 1000);
    const freshTime = new Date(now - 1 * 24 * 60 * 60 * 1000);

    await utimes(staleDir, staleTime, staleTime);
    await utimes(freshDir, freshTime, freshTime);

    const result = await cleanupEntriesOlderThan({
      root,
      ttlDays: 7,
      now
    });

    expect(result.deleted).toContain(staleDir);
    expect(result.kept).toContain(freshDir);
    expect(await exists(staleDir)).toBe(false);
    expect(await exists(freshDir)).toBe(true);
  });

  it("returns no-op summary when cleanup root does not exist", async () => {
    const result = await cleanupEntriesOlderThan({
      root: "/tmp/code-porter-missing-root-xyz-1234",
      ttlDays: 7
    });

    expect(result.deleted).toHaveLength(0);
    expect(result.skipped.some((entry) => entry.includes("missing root"))).toBe(true);
  });

  it("parses ttl from env with safe fallback", () => {
    expect(ttlDaysFromEnv("14", 7)).toBe(14);
    expect(ttlDaysFromEnv("-2", 7)).toBe(7);
    expect(ttlDaysFromEnv(undefined, 7)).toBe(7);
  });
});
