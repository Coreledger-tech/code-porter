import type {
  SemanticRetrievalHit,
  SemanticRetrievalProvider,
  SemanticRetrievalResult
} from "@code-porter/core/src/workflow-runner.js";

type CoreModule = Record<string, unknown>;

const RETRIEVAL_REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /ghp_[A-Za-z0-9]{20,}/g, replacement: "ghp_[REDACTED]" },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: "github_pat_[REDACTED]" },
  { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "AKIA[REDACTED]" }
];

function sanitizeText(value: string): string {
  let sanitized = value;
  for (const { pattern, replacement } of RETRIEVAL_REDACTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

function clampTopK(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 5;
  }
  return Math.max(1, Math.min(Math.floor(value), 50));
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 2);
}

function scorePath(path: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) {
    return 0;
  }
  const lowerPath = path.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (lowerPath.includes(token)) {
      score += 1;
    }
  }
  return score / queryTokens.length;
}

function buildLexicalHits(
  filePaths: string[],
  query: string,
  topK: number,
  reason: string
): SemanticRetrievalHit[] {
  const tokens = tokenize(query);
  return filePaths
    .map((filePath) => ({
      filePath,
      score: scorePath(filePath, tokens)
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.filePath.localeCompare(right.filePath);
    })
    .slice(0, topK)
    .map((item) => ({
      filePath: item.filePath,
      score: Number(item.score.toFixed(6)),
      reason
    }));
}

function asHits(value: unknown): SemanticRetrievalHit[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const hits: SemanticRetrievalHit[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const typed = item as Record<string, unknown>;
    const filePath =
      (typeof typed.filePath === "string" && typed.filePath) ||
      (typeof typed.path === "string" && typed.path) ||
      null;
    const scoreValue = typed.score;
    const score =
      typeof scoreValue === "number" && Number.isFinite(scoreValue)
        ? scoreValue
        : Number(typeof scoreValue === "string" ? scoreValue : NaN);
    if (!filePath || !Number.isFinite(score)) {
      continue;
    }
    const reason = typeof typed.reason === "string" ? typed.reason : undefined;
    if (reason) {
      hits.push({
        filePath: sanitizeText(filePath),
        score,
        reason: sanitizeText(reason)
      });
    } else {
      hits.push({ filePath: sanitizeText(filePath), score });
    }
  }
  return hits;
}

function coerceResult(value: unknown): SemanticRetrievalHit[] {
  if (Array.isArray(value)) {
    return asHits(value);
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const typed = value as Record<string, unknown>;
  if (Array.isArray(typed.hits)) {
    return asHits(typed.hits);
  }
  if (Array.isArray(typed.results)) {
    return asHits(typed.results);
  }
  return [];
}

function extractFailureQuery(input: {
  verify: {
    compile: { status: string; failureKind?: string; reason?: string; output?: string };
    tests: { status: string; failureKind?: string; reason?: string; output?: string };
    staticChecks: { status: string; failureKind?: string; reason?: string; output?: string };
  };
}): string {
  const checks = [
    { name: "compile", value: input.verify.compile },
    { name: "tests", value: input.verify.tests },
    { name: "static", value: input.verify.staticChecks }
  ];

  const segments = checks
    .filter((entry) => entry.value.status !== "passed")
    .map((entry) => {
      return [
        `[${entry.name}]`,
        `failureKind=${entry.value.failureKind ?? "unknown"}`,
        entry.value.reason ?? "",
        (entry.value.output ?? "").slice(0, 1200)
      ]
        .filter((part) => part.length > 0)
        .join("\n");
    });

  return segments.join("\n\n").slice(0, 4000);
}

export class NoopSemanticRetrievalProvider implements SemanticRetrievalProvider {
  readonly enabled = false;

  async retrieve(
    input: Parameters<SemanticRetrievalProvider["retrieve"]>[0]
  ): Promise<SemanticRetrievalResult> {
    return {
      provider: "noop",
      topK: clampTopK(input.topK),
      query: sanitizeText(extractFailureQuery({ verify: input.verify })),
      hits: []
    };
  }
}

export class ClaudeContextSemanticRetrievalProvider implements SemanticRetrievalProvider {
  readonly enabled = true;

  constructor(
    private readonly options: {
      topK?: number;
      coreLoader?: () => Promise<CoreModule>;
    } = {}
  ) {}

  private async loadCore(): Promise<CoreModule> {
    if (this.options.coreLoader) {
      return this.options.coreLoader();
    }
    const moduleName = "@zilliz/claude-context-core";
    return import(moduleName);
  }

  async retrieve(
    input: Parameters<SemanticRetrievalProvider["retrieve"]>[0]
  ): Promise<SemanticRetrievalResult> {
    const topK = clampTopK(this.options.topK ?? input.topK);
    const query = sanitizeText(extractFailureQuery({ verify: input.verify }));
    const core = await this.loadCore();

    const retrieveFn = [
      core.retrieveTopK,
      core.searchTopK,
      core.search,
      core.retrieve
    ].find((candidate) => typeof candidate === "function") as
      | ((payload: Record<string, unknown>) => Promise<unknown>)
      | undefined;

    if (!retrieveFn) {
      const hits = buildLexicalHits(
        input.filePaths,
        query,
        topK,
        "lexical fallback (claude-context function unavailable)"
      );
      return {
        provider: "claude_context",
        topK,
        query,
        hits,
        metadata: {
          fallback: true,
          reason: "no_supported_core_function"
        }
      };
    }

    const raw = await retrieveFn({
      repoPath: input.repoPath,
      query,
      topK,
      filePaths: input.filePaths
    });
    const hits = coerceResult(raw);

    if (hits.length === 0) {
      return {
        provider: "claude_context",
        topK,
        query,
        hits: buildLexicalHits(
          input.filePaths,
          query,
          topK,
          "lexical fallback (empty core result)"
        ),
        metadata: {
          fallback: true,
          reason: "empty_core_result"
        }
      };
    }

    return {
      provider: "claude_context",
      topK,
      query,
      hits: hits.slice(0, topK).map((hit) => ({
        filePath: sanitizeText(hit.filePath),
        score: hit.score,
        ...(hit.reason ? { reason: sanitizeText(hit.reason) } : {})
      }))
    };
  }
}

export function createSemanticRetrievalProviderFromEnv(): SemanticRetrievalProvider {
  const enabled = String(process.env.SEMANTIC_RETRIEVAL_ENABLED ?? "false").toLowerCase() === "true";
  if (!enabled) {
    return new NoopSemanticRetrievalProvider();
  }

  const provider = String(process.env.SEMANTIC_RETRIEVAL_PROVIDER ?? "claude_context")
    .trim()
    .toLowerCase();
  const topKValue = Number(process.env.SEMANTIC_RETRIEVAL_TOP_K ?? "5");
  if (provider !== "claude_context") {
    return new NoopSemanticRetrievalProvider();
  }

  return new ClaudeContextSemanticRetrievalProvider({
    topK: topKValue
  });
}
