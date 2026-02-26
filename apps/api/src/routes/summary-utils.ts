import { createGitHubAuthProvider } from "@code-porter/workspace/src/index.js";

export type MergeState = "open" | "merged" | "closed" | "unknown";

interface PullReference {
  owner: string;
  repo: string;
  pullNumber: string;
}

let cachedAuthProvider: ReturnType<typeof createGitHubAuthProvider> | undefined;

function parsePullReference(prUrl: string): PullReference | null {
  const match = prUrl.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/i
  );
  if (!match) {
    return null;
  }
  return {
    owner: match[1],
    repo: match[2],
    pullNumber: match[3]
  };
}

async function getGitHubTokenOptional(): Promise<string | null> {
  try {
    cachedAuthProvider ??= createGitHubAuthProvider();
    return await cachedAuthProvider.getToken();
  } catch {
    return null;
  }
}

export async function resolveMergeState(prUrl: string | null): Promise<MergeState> {
  if (!prUrl) {
    return "unknown";
  }

  const reference = parsePullReference(prUrl);
  if (!reference) {
    return "unknown";
  }

  const apiUrl = process.env.GITHUB_API_URL?.trim() || "https://api.github.com";
  const timeoutMs = Number(process.env.SUMMARY_GITHUB_LOOKUP_TIMEOUT_MS ?? 1500);

  const token = await getGitHubTokenOptional();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `${apiUrl.replace(/\/+$/, "")}/repos/${reference.owner}/${reference.repo}/pulls/${reference.pullNumber}`,
      {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          Accept: "application/vnd.github+json",
          "User-Agent": "code-porter"
        },
        signal: controller.signal
      }
    );

    if (!response.ok) {
      return "unknown";
    }

    const payload = (await response.json()) as {
      state?: string;
      merged_at?: string | null;
    };

    if (payload.merged_at) {
      return "merged";
    }
    if (payload.state === "open") {
      return "open";
    }
    if (payload.state === "closed") {
      return "closed";
    }

    return "unknown";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timeout);
  }
}

export function parseSummaryWindow(input: {
  days?: string | string[];
  recentLimit?: string | string[];
}): { days: number; recentLimit: number } {
  const parseBounded = (value: string | string[] | undefined, fallback: number, min: number, max: number): number => {
    const source = Array.isArray(value) ? value[0] : value;
    const parsed = Number(source ?? fallback);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(parsed)));
  };

  return {
    days: parseBounded(input.days, 30, 1, 365),
    recentLimit: parseBounded(input.recentLimit, 20, 1, 100)
  };
}
