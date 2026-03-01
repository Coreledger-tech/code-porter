import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PilotWindow = "7d" | "30d";
type RunTerminalStatus = "completed" | "needs_review" | "blocked" | "failed" | "cancelled";

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

interface PilotRepoConfig {
  name: string;
  owner: string;
  repo: string;
  cloneUrl?: string;
  defaultBranch?: string;
}

interface PilotRunConfig {
  apiBaseUrl: string;
  policyId?: string;
  recipePack?: string;
  targetSelector?: string;
  window?: PilotWindow;
  pollIntervalMs?: number;
  applyStartBackoffMs?: number;
  maxApplyStartRetries?: number;
  repos: PilotRepoConfig[];
}

interface NormalizedPilotRunConfig {
  apiBaseUrl: string;
  policyId: string;
  recipePack: string;
  targetSelector: string;
  window: PilotWindow;
  pollIntervalMs: number;
  applyStartBackoffMs: number;
  maxApplyStartRetries: number;
  repos: PilotRepoConfig[];
}

interface RunEventRecord {
  id: number;
  runId: string;
  level: "info" | "warn" | "error";
  eventType: "step_start" | "step_end" | "warning" | "error" | "lifecycle";
  step: string | null;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface RunsEventsResponse {
  runId: string;
  events: RunEventRecord[];
  nextAfterId: number;
}

interface RunResponse {
  id: string;
  campaignId: string;
  status: string;
  queueStatus?: string;
  attemptCount?: number | null;
  maxAttempts?: number | null;
  prUrl?: string | null;
  prNumber?: number | null;
  prState?: string | null;
  summary?: Record<string, unknown>;
}

interface PilotStageSummary {
  runId: string;
  status: string;
  queueStatus: string | null;
  attemptCount: number | null;
  maxAttempts: number | null;
  retries: number | null;
  failureKind: string | null;
  blockedReason: string | null;
  budgetTriggers: BudgetTrigger[];
  prUrl: string | null;
  prNumber: number | null;
  prState: string | null;
}

interface PilotRepoResult {
  repo: PilotRepoConfig;
  projectId: string;
  campaignId: string;
  plan: PilotStageSummary;
  apply: PilotStageSummary;
}

interface PilotReportResponse {
  window: PilotWindow;
  generatedAt: string;
  topFailureKinds: Array<{ failureKind: string; count: number }>;
  blockedByFailureKind: Array<{ failureKind: string; count: number }>;
  retryRate: {
    retriedRuns: number;
    totalRuns: number;
    rate: number;
  };
  prOutcomes: {
    opened: number;
    merged: number;
    closedUnmerged: number;
    open: number;
    mergeRate: number;
  };
  totalsByStatus: Record<string, number>;
  timeToGreen: {
    sampleSize: number;
    p50Hours: number | null;
    p90Hours: number | null;
  };
}

interface BudgetTrigger {
  budgetKey: string;
  limit: number | null;
  observed: number | null;
  step: string | null;
}

interface RecommendationItem {
  id: string;
  type: "recipe_pack" | "operational";
  triggerFailureKinds: string[];
  rationale: string;
  expectedImpact: string;
}

interface PilotRecommendationOutput {
  top3FailureKinds: Array<{ failureKind: string; count: number }>;
  top3MissingRecipesOrRemediations: RecommendationItem[];
  nextRecipePackCandidates: RecommendationItem[];
}

interface PilotRunResult {
  generatedAt: string;
  config: NormalizedPilotRunConfig;
  repos: PilotRepoResult[];
  statuses: Record<string, number>;
  failureKinds: Record<string, number>;
  budgetsTriggered: Record<string, number>;
  retryTotals: {
    runsWithRetries: number;
    totalRetries: number;
  };
  prStates: Record<string, number>;
  reportWindow: PilotWindow;
  reportSnapshot: PilotReportResponse;
  recommendations: PilotRecommendationOutput;
  outputPath: string;
}

interface PilotRunDependencies {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  outputRoot?: string;
  logger?: Logger;
}

class ApiRequestError extends Error {
  readonly status: number;
  readonly payload: unknown;
  readonly url: string;

  constructor(url: string, status: number, payload: unknown) {
    super(`HTTP ${status} for ${url}`);
    this.name = "ApiRequestError";
    this.url = url;
    this.status = status;
    this.payload = payload;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function ensurePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  if (value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid or missing '${field}'`);
  }
  return value.trim();
}

export function normalizePilotConfig(raw: unknown): NormalizedPilotRunConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("Pilot config must be a JSON object");
  }

  const input = raw as PilotRunConfig;
  const apiBaseUrl = requireString(input.apiBaseUrl, "apiBaseUrl").replace(/\/+$/, "");
  const policyId = typeof input.policyId === "string" && input.policyId.trim().length > 0
    ? input.policyId.trim()
    : "pilot-conservative";
  const recipePack =
    typeof input.recipePack === "string" && input.recipePack.trim().length > 0
      ? input.recipePack.trim()
      : "java-maven-plugin-modernize";
  const targetSelector =
    typeof input.targetSelector === "string" && input.targetSelector.trim().length > 0
      ? input.targetSelector.trim()
      : "main";
  const window = input.window === "7d" ? "7d" : "30d";
  const pollIntervalMs = ensurePositiveInt(input.pollIntervalMs, 2000);
  const applyStartBackoffMs = ensurePositiveInt(input.applyStartBackoffMs, 5000);
  const maxApplyStartRetries = ensurePositiveInt(input.maxApplyStartRetries, 12);

  if (!Array.isArray(input.repos)) {
    throw new Error("Pilot config 'repos' must be an array");
  }
  if (input.repos.length !== 5) {
    throw new Error("Pilot config must define exactly 5 repos");
  }

  const repos = input.repos.map((repo, index) => {
    if (!repo || typeof repo !== "object") {
      throw new Error(`repos[${index}] must be an object`);
    }
    const normalizedRepo: PilotRepoConfig = {
      name: requireString(repo.name, `repos[${index}].name`),
      owner: requireString(repo.owner, `repos[${index}].owner`),
      repo: requireString(repo.repo, `repos[${index}].repo`)
    };
    if (typeof repo.cloneUrl === "string" && repo.cloneUrl.trim().length > 0) {
      normalizedRepo.cloneUrl = repo.cloneUrl.trim();
    }
    if (typeof repo.defaultBranch === "string" && repo.defaultBranch.trim().length > 0) {
      normalizedRepo.defaultBranch = repo.defaultBranch.trim();
    }
    return normalizedRepo;
  });

  return {
    apiBaseUrl,
    policyId,
    recipePack,
    targetSelector,
    window,
    pollIntervalMs,
    applyStartBackoffMs,
    maxApplyStartRetries,
    repos
  };
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetchImpl(url, options);
  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    throw new ApiRequestError(url, response.status, payload);
  }
  return payload as T;
}

function isRunTerminal(status: string | undefined): status is RunTerminalStatus {
  return (
    status === "completed" ||
    status === "needs_review" ||
    status === "blocked" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function isQueueTerminal(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === undefined;
}

function extractBudgetTriggers(events: RunEventRecord[]): BudgetTrigger[] {
  const triggers: BudgetTrigger[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    const payload = event.payload ?? {};
    const rawKey = payload.budgetKey;
    const key = typeof rawKey === "string" ? rawKey : null;
    if (!key) {
      continue;
    }

    const limit = typeof payload.limit === "number" ? payload.limit : null;
    const observed = typeof payload.observed === "number" ? payload.observed : null;
    const dedupeKey = `${key}|${limit ?? "null"}|${observed ?? "null"}|${event.step ?? "none"}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    triggers.push({
      budgetKey: key,
      limit,
      observed,
      step: event.step
    });
  }

  return triggers;
}

function stageSummaryFromRun(
  run: RunResponse,
  budgetTriggers: BudgetTrigger[]
): PilotStageSummary {
  const summary = run.summary ?? {};
  const attemptCount =
    typeof run.attemptCount === "number" && Number.isFinite(run.attemptCount)
      ? Math.max(0, Math.floor(run.attemptCount))
      : null;
  const maxAttempts =
    typeof run.maxAttempts === "number" && Number.isFinite(run.maxAttempts)
      ? Math.max(0, Math.floor(run.maxAttempts))
      : null;

  return {
    runId: run.id,
    status: run.status,
    queueStatus: run.queueStatus ?? null,
    attemptCount,
    maxAttempts,
    retries: attemptCount === null ? null : Math.max(0, attemptCount - 1),
    failureKind:
      typeof summary.failureKind === "string" ? summary.failureKind : null,
    blockedReason:
      typeof summary.blockedReason === "string" ? summary.blockedReason : null,
    budgetTriggers,
    prUrl: typeof run.prUrl === "string" ? run.prUrl : null,
    prNumber: typeof run.prNumber === "number" ? run.prNumber : null,
    prState: typeof run.prState === "string" ? run.prState : null
  };
}

async function pollRunToTerminal(input: {
  apiBaseUrl: string;
  runId: string;
  pollIntervalMs: number;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  logger: Logger;
  timeoutMs?: number;
}): Promise<PilotStageSummary> {
  let afterId = 0;
  const budgetTriggers: BudgetTrigger[] = [];
  const deadline = Date.now() + (input.timeoutMs ?? 20 * 60 * 1000);

  while (Date.now() < deadline) {
    const events = await requestJson<RunsEventsResponse>(
      input.fetchImpl,
      `${input.apiBaseUrl}/runs/${input.runId}/events?afterId=${afterId}&limit=100`
    );
    if (events.events.length > 0) {
      afterId = events.nextAfterId;
      const newTriggers = extractBudgetTriggers(events.events);
      for (const trigger of newTriggers) {
        const exists = budgetTriggers.some((existing) => {
          return (
            existing.budgetKey === trigger.budgetKey &&
            existing.limit === trigger.limit &&
            existing.observed === trigger.observed &&
            existing.step === trigger.step
          );
        });
        if (!exists) {
          budgetTriggers.push(trigger);
        }
      }
      for (const event of events.events) {
        input.logger.info(
          `[run:${input.runId}] ${event.eventType}${event.step ? `/${event.step}` : ""} ${event.message}`
        );
      }
    }

    const run = await requestJson<RunResponse>(
      input.fetchImpl,
      `${input.apiBaseUrl}/runs/${input.runId}`
    );

    if (isRunTerminal(run.status) && isQueueTerminal(run.queueStatus)) {
      return stageSummaryFromRun(run, budgetTriggers);
    }

    await input.sleep(input.pollIntervalMs);
  }

  throw new Error(`Timed out waiting for run ${input.runId} to reach terminal state`);
}

async function startRunWithRetry(input: {
  apiBaseUrl: string;
  campaignId: string;
  mode: "plan" | "apply";
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  backoffMs: number;
  maxRetries: number;
  logger: Logger;
}): Promise<string> {
  let attempt = 0;
  while (attempt <= input.maxRetries) {
    try {
      const response = await requestJson<{ runId: string; status: string }>(
        input.fetchImpl,
        `${input.apiBaseUrl}/campaigns/${input.campaignId}/${input.mode}`,
        { method: "POST" }
      );
      return response.runId;
    } catch (error) {
      if (!(error instanceof ApiRequestError) || error.status !== 429) {
        throw error;
      }
      if (attempt === input.maxRetries) {
        throw new Error(
          `${input.mode} enqueue throttled after ${input.maxRetries + 1} attempts for campaign ${input.campaignId}`
        );
      }
      input.logger.warn(
        `${input.mode} enqueue throttled for campaign ${input.campaignId}, retrying (${attempt + 1}/${input.maxRetries})`
      );
      await input.sleep(input.backoffMs);
      attempt += 1;
    }
  }

  throw new Error(`Failed to enqueue ${input.mode} run for campaign ${input.campaignId}`);
}

function recommendationFromFailureKind(
  failureKind: string
): RecommendationItem | null {
  if (failureKind === "artifact_resolution" || failureKind === "repo_unreachable") {
    return {
      id: "java-maven-repository-resilience-pack",
      type: "recipe_pack",
      triggerFailureKinds: [failureKind],
      rationale: "Pilot failures indicate dependency/plugin retrieval instability in Maven lanes.",
      expectedImpact: "Reduce blocked runs caused by repository and plugin resolution issues."
    };
  }

  if (failureKind === "code_failure") {
    return {
      id: "java-junit5-transition-pack",
      type: "recipe_pack",
      triggerFailureKinds: [failureKind],
      rationale: "Code-level verifier failures commonly come from test framework drift during upgrades.",
      expectedImpact: "Increase pass@1 by reducing deterministic test migration regressions."
    };
  }

  if (failureKind === "tool_missing") {
    return {
      id: "toolchain-readiness-preflight",
      type: "operational",
      triggerFailureKinds: [failureKind],
      rationale: "Pilot observed missing build toolchain prerequisites.",
      expectedImpact: "Fail fast before campaign enqueue and reduce non-actionable blocked runs."
    };
  }

  if (failureKind === "budget_guardrail") {
    return {
      id: "budget-tuning-and-campaign-segmentation",
      type: "operational",
      triggerFailureKinds: [failureKind],
      rationale: "Budget guardrails are stopping campaigns before verification completion.",
      expectedImpact: "Improve throughput without reducing safety by tuning limits and repo segmentation."
    };
  }

  return null;
}

export function buildPilotRecommendations(input: {
  report: PilotReportResponse;
  repoResults: PilotRepoResult[];
}): PilotRecommendationOutput {
  const top3FailureKinds = input.report.topFailureKinds.slice(0, 3);
  const recommendationMap = new Map<string, RecommendationItem>();

  for (const entry of top3FailureKinds) {
    const recommendation = recommendationFromFailureKind(entry.failureKind);
    if (!recommendation) {
      continue;
    }
    if (recommendationMap.has(recommendation.id)) {
      const existing = recommendationMap.get(recommendation.id)!;
      existing.triggerFailureKinds = [...new Set([...existing.triggerFailureKinds, entry.failureKind])];
      continue;
    }
    recommendationMap.set(recommendation.id, recommendation);
  }

  const top3MissingRecipesOrRemediations = Array.from(recommendationMap.values()).slice(0, 3);
  const nextRecipePackCandidates = top3MissingRecipesOrRemediations
    .filter((item) => item.type === "recipe_pack")
    .slice(0, 2);

  for (const fallbackPack of [
    "java-maven-repository-resilience-pack",
    "java-junit5-transition-pack"
  ]) {
    if (nextRecipePackCandidates.length >= 2) {
      break;
    }
    if (nextRecipePackCandidates.some((candidate) => candidate.id === fallbackPack)) {
      continue;
    }
    const fallback =
      recommendationFromFailureKind(
        fallbackPack === "java-maven-repository-resilience-pack"
          ? "artifact_resolution"
          : "code_failure"
      );
    if (fallback) {
      nextRecipePackCandidates.push(fallback);
    }
  }

  return {
    top3FailureKinds,
    top3MissingRecipesOrRemediations,
    nextRecipePackCandidates
  };
}

function computePilotCounters(results: PilotRepoResult[]): {
  statuses: Record<string, number>;
  failureKinds: Record<string, number>;
  budgetsTriggered: Record<string, number>;
  retryTotals: {
    runsWithRetries: number;
    totalRetries: number;
  };
  prStates: Record<string, number>;
} {
  const statuses: Record<string, number> = {};
  const failureKinds: Record<string, number> = {};
  const budgetsTriggered: Record<string, number> = {};
  const prStates: Record<string, number> = {};

  let runsWithRetries = 0;
  let totalRetries = 0;

  for (const repo of results) {
    for (const stage of [repo.plan, repo.apply]) {
      statuses[stage.status] = (statuses[stage.status] ?? 0) + 1;
      if (stage.failureKind) {
        failureKinds[stage.failureKind] = (failureKinds[stage.failureKind] ?? 0) + 1;
      }
      for (const trigger of stage.budgetTriggers) {
        budgetsTriggered[trigger.budgetKey] = (budgetsTriggered[trigger.budgetKey] ?? 0) + 1;
      }
      if (typeof stage.retries === "number" && stage.retries > 0) {
        runsWithRetries += 1;
        totalRetries += stage.retries;
      }
      if (stage.prState) {
        prStates[stage.prState] = (prStates[stage.prState] ?? 0) + 1;
      }
    }
  }

  return {
    statuses,
    failureKinds,
    budgetsTriggered,
    retryTotals: {
      runsWithRetries,
      totalRetries
    },
    prStates
  };
}

function printSummary(result: PilotRunResult, logger: Logger): void {
  logger.info("");
  logger.info("Pilot run summary:");
  for (const repo of result.repos) {
    logger.info(
      `- ${repo.repo.owner}/${repo.repo.repo} plan=${repo.plan.status} apply=${repo.apply.status} retries=${repo.apply.retries ?? 0}`
    );
  }
  logger.info("");
  logger.info(`Output: ${result.outputPath}`);
  logger.info(`Top failure kinds: ${result.recommendations.top3FailureKinds.map((entry) => entry.failureKind).join(", ") || "none"}`);
  logger.info(
    `Next recipe pack candidates: ${result.recommendations.nextRecipePackCandidates.map((entry) => entry.id).join(", ") || "none"}`
  );
}

export async function runPilot(
  config: NormalizedPilotRunConfig,
  deps: PilotRunDependencies = {}
): Promise<PilotRunResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? console;
  const outputRoot = resolve(
    deps.outputRoot ?? resolve(process.cwd(), "evidence", "pilot")
  );

  const repos: Array<{
    repo: PilotRepoConfig;
    projectId: string;
    campaignId: string;
    planRunId: string;
  }> = [];

  for (const repo of config.repos) {
    const project = await requestJson<{ id: string }>(
      fetchImpl,
      `${config.apiBaseUrl}/projects/github`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: repo.name,
          owner: repo.owner,
          repo: repo.repo,
          cloneUrl: repo.cloneUrl,
          defaultBranch: repo.defaultBranch
        })
      }
    );

    const campaign = await requestJson<{ id: string }>(
      fetchImpl,
      `${config.apiBaseUrl}/campaigns`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          policyId: config.policyId,
          recipePack: config.recipePack,
          targetSelector: repo.defaultBranch ?? config.targetSelector
        })
      }
    );

    const planRunId = await startRunWithRetry({
      apiBaseUrl: config.apiBaseUrl,
      campaignId: campaign.id,
      mode: "plan",
      fetchImpl,
      sleep,
      backoffMs: config.applyStartBackoffMs,
      maxRetries: config.maxApplyStartRetries,
      logger
    });

    repos.push({
      repo,
      projectId: project.id,
      campaignId: campaign.id,
      planRunId
    });
  }

  const planSummaries = await Promise.all(
    repos.map(async (entry) => {
      const summary = await pollRunToTerminal({
        apiBaseUrl: config.apiBaseUrl,
        runId: entry.planRunId,
        pollIntervalMs: config.pollIntervalMs,
        fetchImpl,
        sleep,
        logger
      });
      return {
        campaignId: entry.campaignId,
        summary
      };
    })
  );
  const planByCampaign = new Map(planSummaries.map((entry) => [entry.campaignId, entry.summary]));

  const repoResults: PilotRepoResult[] = [];
  for (const entry of repos) {
    const applyRunId = await startRunWithRetry({
      apiBaseUrl: config.apiBaseUrl,
      campaignId: entry.campaignId,
      mode: "apply",
      fetchImpl,
      sleep,
      backoffMs: config.applyStartBackoffMs,
      maxRetries: config.maxApplyStartRetries,
      logger
    });

    const applySummary = await pollRunToTerminal({
      apiBaseUrl: config.apiBaseUrl,
      runId: applyRunId,
      pollIntervalMs: config.pollIntervalMs,
      fetchImpl,
      sleep,
      logger
    });

    repoResults.push({
      repo: entry.repo,
      projectId: entry.projectId,
      campaignId: entry.campaignId,
      plan: planByCampaign.get(entry.campaignId)!,
      apply: applySummary
    });
  }

  const report = await requestJson<PilotReportResponse>(
    fetchImpl,
    `${config.apiBaseUrl}/reports/pilot?window=${config.window}`
  );
  const recommendations = buildPilotRecommendations({
    report,
    repoResults
  });
  const counters = computePilotCounters(repoResults);

  const timestamp = now().toISOString().replace(/[:.]/g, "-");
  const outputDir = resolve(outputRoot, timestamp);
  await mkdir(outputDir, { recursive: true });
  const outputPath = resolve(outputDir, "pilot-summary.json");

  const result: PilotRunResult = {
    generatedAt: now().toISOString(),
    config,
    repos: repoResults,
    statuses: counters.statuses,
    failureKinds: counters.failureKinds,
    budgetsTriggered: counters.budgetsTriggered,
    retryTotals: counters.retryTotals,
    prStates: counters.prStates,
    reportWindow: config.window,
    reportSnapshot: report,
    recommendations,
    outputPath
  };

  await writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
  printSummary(result, logger);
  return result;
}

function parseArgs(argv: string[]): { configPath: string } {
  const configFlagIndex = argv.findIndex((arg) => arg === "--config");
  if (configFlagIndex === -1 || configFlagIndex + 1 >= argv.length) {
    throw new Error("Usage: npm run pilot:run -- --config <path-to-json>");
  }
  const configPath = argv[configFlagIndex + 1];
  return { configPath };
}

async function main(): Promise<void> {
  const { configPath } = parseArgs(process.argv.slice(2));
  const configText = await readFile(resolve(process.cwd(), configPath), "utf8");
  const normalized = normalizePilotConfig(JSON.parse(configText));
  await runPilot(normalized);
}

const isMain = (() => {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    return false;
  }
  return resolve(scriptPath) === resolve(fileURLToPath(import.meta.url));
})();

if (isMain) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(`[pilot:run] ${message}`);
    process.exitCode = 1;
  });
}

export type {
  PilotRepoConfig,
  PilotRunConfig,
  PilotRunResult,
  PilotRecommendationOutput,
  PilotStageSummary,
  NormalizedPilotRunConfig,
  RecommendationItem,
  PilotReportResponse
};
