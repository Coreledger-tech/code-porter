import { readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

export interface CleanupSummary {
  root: string;
  deleted: string[];
  kept: string[];
  skipped: string[];
}

function normalizeDays(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

export function ttlDaysFromEnv(raw: string | undefined, fallback = 7): number {
  if (!raw) {
    return fallback;
  }
  return normalizeDays(Number(raw), fallback);
}

export function assertSafeCleanupRoot(path: string): string {
  const resolved = resolve(path);
  if (!resolved || resolved === "/") {
    throw new Error(`Refusing cleanup for unsafe root path '${path}'`);
  }
  return resolved;
}

export async function cleanupEntriesOlderThan(input: {
  root: string;
  ttlDays: number;
  now?: number;
}): Promise<CleanupSummary> {
  const safeRoot = assertSafeCleanupRoot(input.root);
  const ttlDays = normalizeDays(input.ttlDays, 7);
  const cutoff = (input.now ?? Date.now()) - ttlDays * 24 * 60 * 60 * 1000;

  const summary: CleanupSummary = {
    root: safeRoot,
    deleted: [],
    kept: [],
    skipped: []
  };

  let entries;
  try {
    entries = await readdir(safeRoot, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      summary.skipped.push(`missing root: ${safeRoot}`);
      return summary;
    }
    throw error;
  }

  for (const entry of entries) {
    const fullPath = resolve(safeRoot, String(entry.name));
    let details;
    try {
      details = await stat(fullPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        summary.skipped.push(`missing entry: ${fullPath}`);
        continue;
      }
      throw error;
    }

    if (details.mtimeMs < cutoff) {
      await rm(fullPath, { recursive: true, force: true });
      summary.deleted.push(fullPath);
    } else {
      summary.kept.push(fullPath);
    }
  }

  return summary;
}
