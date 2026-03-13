import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildPilotRecommendations,
  normalizePilotConfig,
  runPilot,
  type NormalizedPilotRunConfig
} from "./pilot-run.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function buildBaseConfig(): NormalizedPilotRunConfig {
  return normalizePilotConfig({
    apiBaseUrl: "http://pilot-api.local",
    policyId: "pilot-stage3",
    recipePack: "java-maven-lombok-delombok-compat-pack",
    targetSelector: "main",
    window: "30d",
    pollIntervalMs: 1,
    applyStartBackoffMs: 1,
    maxApplyStartRetries: 2,
    repos: [
      { name: "repo-1", owner: "org", repo: "service-1" },
      { name: "repo-2", owner: "org", repo: "service-2" },
      { name: "repo-3", owner: "org", repo: "service-3" },
      { name: "repo-4", owner: "org", repo: "service-4" },
      { name: "repo-5", owner: "org", repo: "service-5" }
    ]
  });
}

function createMockPilotApi() {
  let projectCounter = 0;
  let campaignCounter = 0;
  const campaignOrder: string[] = [];
  const campaignBodies: Array<Record<string, unknown>> = [];
  const planStartAttempts = new Map<string, number>();
  const applyStartAttempts = new Map<string, number>();
  const planStartSequence: string[] = [];
  const applyStartSequence: string[] = [];
  const runs = new Map<string, Record<string, unknown>>();
  const events = new Map<string, Array<Record<string, unknown>>>();

  const reportPayload = {
    window: "30d",
    cohort: "all",
    cohortCounts: {
      totalApplyRuns: 10,
      cohortApplyRuns: 10,
      excludedApplyRuns: 0
    },
    generatedAt: "2026-02-26T08:00:00.000Z",
    totalsByStatus: {
      completed: 3,
      blocked: 1,
      needs_review: 1
    },
    topFailureKinds: [
      { failureKind: "artifact_resolution", count: 4 },
      { failureKind: "code_compile_failure", count: 2 },
      { failureKind: "tool_missing", count: 1 }
    ],
    blockedByFailureKind: [{ failureKind: "artifact_resolution", count: 1 }],
    prOutcomes: {
      opened: 5,
      merged: 3,
      closedUnmerged: 1,
      open: 1,
      mergeRate: 0.6
    },
    timeToGreen: {
      sampleSize: 4,
      p50Hours: 5,
      p90Hours: 18
    },
    retryRate: {
      retriedRuns: 1,
      totalRuns: 10,
      rate: 0.1
    },
    keeperOutcomes: {
      keeperChosen: 2,
      keeperMerged: 1,
      mergeReady: 2,
      supersededClosedCount: 1
    },
    coverageEntries: [
      {
        projectId: "project-5",
        projectName: "service-5",
        repo: "service-5",
        runId: "apply-campaign-5",
        selectedBuildSystem: "gradle",
        buildSystemDisposition: "unsupported_subtype",
        gradleProjectType: "android",
        coverageOutcome: "excluded",
        unsupportedReason: "unsupported_subtype_android_unguarded",
        recommendedNextLane: "android_guarded_baseline",
        failureKind: "unsupported_build_system",
        blockedReason: "Android is outside the current lane",
        prUrl: "https://github.com/org/repo/pull/5"
      }
    ],
    coverageSummary: {
      byOutcome: {
        excluded: 1
      },
      byReason: {
        unsupported_subtype_android_unguarded: 1
      },
      byRecommendation: {
        android_guarded_baseline: 1
      }
    },
    worstOffendersByProject: []
  };

  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;

    if (method === "POST" && path === "/projects/github") {
      projectCounter += 1;
      return jsonResponse({ id: `project-${projectCounter}` }, 201);
    }

    if (method === "POST" && path === "/campaigns") {
      campaignCounter += 1;
      const campaignId = `campaign-${campaignCounter}`;
      campaignOrder.push(campaignId);
      if (init?.body && typeof init.body === "string") {
        campaignBodies.push(JSON.parse(init.body));
      }
      return jsonResponse({ id: campaignId }, 201);
    }

    const runPathMatch = path.match(/^\/campaigns\/([^/]+)\/(plan|apply)$/);
    if (method === "POST" && runPathMatch) {
      const campaignId = runPathMatch[1];
      const mode = runPathMatch[2];

      if (mode === "plan") {
        const attempts = (planStartAttempts.get(campaignId) ?? 0) + 1;
        planStartAttempts.set(campaignId, attempts);
        planStartSequence.push(campaignId);
        if (campaignId === "campaign-3" && attempts === 1) {
          return jsonResponse({ error: "run start throttled by policy" }, 429);
        }
      }

      if (mode === "apply") {
        const attempts = (applyStartAttempts.get(campaignId) ?? 0) + 1;
        applyStartAttempts.set(campaignId, attempts);
        applyStartSequence.push(campaignId);
        if (campaignId === "campaign-2" && attempts === 1) {
          return jsonResponse({ error: "run start throttled by policy" }, 429);
        }
      }

      const runId = `${mode}-${campaignId}`;
      const campaignNumber = Number(campaignId.split("-")[1] ?? "0");
      if (mode === "plan") {
        runs.set(runId, {
          id: runId,
          campaignId,
          status: "completed",
          queueStatus: "completed",
          attemptCount: 1,
          maxAttempts: 3,
          summary: {
            status: "completed"
          }
        });
        events.set(runId, []);
      } else {
        const stageByCampaign: Record<number, Record<string, unknown>> = {
          1: {
            status: "completed",
            failureKind: null,
            blockedReason: null,
            attemptCount: 1
          },
          2: {
            status: "blocked",
            failureKind: "budget_guardrail",
            blockedReason: "maxVerifyMinutesPerRun exceeded",
            attemptCount: 2
          },
          3: {
            status: "needs_review",
            failureKind: "code_compile_failure",
            blockedReason: null,
            attemptCount: 1
          },
          4: {
            status: "blocked",
            failureKind: "artifact_resolution",
            blockedReason: "Artifact resolution failed",
            attemptCount: 1
          },
          5: {
            status: "completed",
            failureKind: null,
            blockedReason: null,
            attemptCount: 1
          }
        };
        const stage = stageByCampaign[campaignNumber];
        runs.set(runId, {
          id: runId,
          campaignId,
          status: stage.status,
          queueStatus: "completed",
          attemptCount: stage.attemptCount,
          maxAttempts: 3,
          prUrl: `https://github.com/org/repo/pull/${campaignNumber}`,
          prNumber: campaignNumber,
          prState: campaignNumber === 5 ? "merged" : "open",
          summary: {
            status: stage.status,
            failureKind: stage.failureKind,
            blockedReason: stage.blockedReason,
            scan: {
              selectedBuildSystem: campaignNumber === 5 ? "gradle" : "maven",
              buildSystemDisposition:
                campaignNumber === 5 ? "unsupported_subtype" : "supported",
              gradleProjectType: campaignNumber === 5 ? "android" : null
            },
            applySummary: {
              remediation:
                campaignNumber === 3
                  ? {
                      rulesApplied: ["ensure_lombok_annotation_processor_path"]
                    }
                  : {
                      rulesApplied: []
                    }
            }
          }
        });
        const runEvents: Array<Record<string, unknown>> = [];
        if (campaignNumber === 2) {
          runEvents.push({
            id: 1,
            runId,
            level: "warn",
            eventType: "warning",
            step: "verify",
            message: "Budget guardrail triggered during verification",
            payload: {
              budgetKey: "maxVerifyMinutesPerRun",
              limit: 15,
              observed: 16,
              actionTaken: "blocked"
            },
            createdAt: "2026-02-26T08:00:00.000Z"
          });
        }
        events.set(runId, runEvents);
      }

      return jsonResponse({ runId, status: "queued" }, 202);
    }

    const runEventsMatch = path.match(/^\/runs\/([^/]+)\/events$/);
    if (method === "GET" && runEventsMatch) {
      const runId = runEventsMatch[1];
      const afterId = Number(url.searchParams.get("afterId") ?? "0");
      const all = events.get(runId) ?? [];
      const filtered = all.filter((event) => Number(event.id) > afterId);
      const last = filtered.length > 0 ? Number(filtered[filtered.length - 1].id) : afterId;
      return jsonResponse({
        runId,
        events: filtered,
        nextAfterId: last
      });
    }

    const runMatch = path.match(/^\/runs\/([^/]+)$/);
    if (method === "GET" && runMatch) {
      const runId = runMatch[1];
      const run = runs.get(runId);
      if (!run) {
        return jsonResponse({ error: "run not found" }, 404);
      }
      return jsonResponse(run);
    }

    if (method === "GET" && path === "/reports/pilot") {
      const cohort = url.searchParams.get("cohort") ?? "all";
      if (cohort === "actionable_maven") {
        return jsonResponse({
          ...reportPayload,
          cohort: "actionable_maven",
          cohortCounts: {
            totalApplyRuns: 10,
            cohortApplyRuns: 6,
            excludedApplyRuns: 4
          }
        });
      }
      if (cohort === "coverage") {
        return jsonResponse({
          ...reportPayload,
          cohort: "coverage",
          cohortCounts: {
            totalApplyRuns: 10,
            cohortApplyRuns: 4,
            excludedApplyRuns: 6
          }
        });
      }
      return jsonResponse(reportPayload);
    }

    return jsonResponse({ error: `Unhandled route ${method} ${path}` }, 404);
  }) as typeof fetch;

  return {
    fetchImpl,
    planStartAttempts,
    applyStartAttempts,
    planStartSequence,
    applyStartSequence,
    campaignOrder,
    campaignBodies
  };
}

describe("pilot-run script", () => {
  it("runs 5-repo pilot flow with sequential apply and bounded 429 retry", async () => {
    const config = buildBaseConfig();
    const mockApi = createMockPilotApi();
    const outputRoot = await mkdtemp(join(tmpdir(), "code-porter-pilot-run-"));
    const sleepMock = vi.fn(async () => {
      return Promise.resolve();
    });

    const result = await runPilot(config, {
      fetchImpl: mockApi.fetchImpl,
      sleep: sleepMock,
      outputRoot,
      now: () => new Date("2026-02-26T08:00:00.000Z"),
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {}
      }
    });

    expect(result.repos).toHaveLength(5);
    expect(mockApi.planStartAttempts.get("campaign-3")).toBe(2);
    expect(mockApi.applyStartAttempts.get("campaign-2")).toBe(2);
    expect(mockApi.planStartSequence).toEqual([
      "campaign-1",
      "campaign-2",
      "campaign-3",
      "campaign-3",
      "campaign-4",
      "campaign-5"
    ]);
    expect(mockApi.applyStartSequence).toEqual([
      "campaign-1",
      "campaign-2",
      "campaign-2",
      "campaign-3",
      "campaign-4",
      "campaign-5"
    ]);

    expect(result.repos[1].apply.retries).toBe(1);
    expect(result.repos[1].apply.budgetTriggers).toEqual([
      {
        budgetKey: "maxVerifyMinutesPerRun",
        limit: 15,
        observed: 16,
        step: "verify"
      }
    ]);
    expect(result.recommendations.nextRecipePackCandidates.map((item) => item.id)).toEqual([
      "java-maven-repository-resilience-pack",
      "java-junit5-transition-pack"
    ]);
    expect(result.repos[2].apply.remediationApplied).toBe(true);
    expect(result.repos[2].apply.remediationRules).toEqual([
      "ensure_lombok_annotation_processor_path"
    ]);
    expect(result.repos[4].apply.selectedBuildSystem).toBe("gradle");
    expect(result.repos[4].apply.buildSystemDisposition).toBe("unsupported_subtype");
    expect(result.repos[4].apply.gradleProjectType).toBe("android");
    expect(result.ghcrVerificationMode).toBe("public");
    expect(result.reportSnapshots.actionableMaven.cohort).toBe("actionable_maven");
    expect(result.reportSnapshots.coverage.cohort).toBe("coverage");
    expect(result.reportSnapshot.cohort).toBe("all");
    expect(result.coverageSummaryPath).toContain("coverage-summary.json");
    expect(mockApi.campaignBodies[0]?.targetSelector).toBe("main");
    expect(mockApi.campaignBodies[1]?.targetSelector).toBe("main");

    const summaryJson = JSON.parse(await readFile(result.outputPath, "utf8"));
    expect(summaryJson.repos).toHaveLength(5);
    expect(summaryJson.retryTotals.totalRetries).toBeGreaterThanOrEqual(1);
    expect(summaryJson.coverageSummaryPath).toBe(result.coverageSummaryPath);

    const coverageJson = JSON.parse(await readFile(result.coverageSummaryPath, "utf8"));
    expect(coverageJson.totals).toEqual({
      totalCoverageRepos: 1,
      excludedCount: 1,
      guardedAppliedCount: 0,
      guardedNoopCount: 0,
      guardedBlockedCount: 0
    });
    expect(coverageJson.byRecommendation).toEqual({
      android_guarded_baseline: 1
    });
  });

  it("uses repo defaultBranch as the campaign target selector when provided", async () => {
    const config = buildBaseConfig();
    config.repos[2] = {
      name: "repo-3",
      owner: "org",
      repo: "service-3",
      defaultBranch: "master"
    };
    const mockApi = createMockPilotApi();
    const outputRoot = await mkdtemp(join(tmpdir(), "code-porter-pilot-run-"));

    await runPilot(config, {
      fetchImpl: mockApi.fetchImpl,
      sleep: async () => Promise.resolve(),
      outputRoot,
      now: () => new Date("2026-02-26T08:00:00.000Z"),
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {}
      }
    });

    expect(mockApi.campaignBodies[2]?.targetSelector).toBe("master");
  });

  it("uses repo-level policy and recipe pack overrides when provided", async () => {
    const config = buildBaseConfig();
    config.repos[4] = {
      ...config.repos[4],
      defaultBranch: "master",
      policyId: "pilot-stage3",
      recipePack: "java-gradle-java17-baseline-pack"
    };
    const mockApi = createMockPilotApi();
    const outputRoot = await mkdtemp(join(tmpdir(), "code-porter-pilot-run-"));

    await runPilot(config, {
      fetchImpl: mockApi.fetchImpl,
      sleep: async () => Promise.resolve(),
      outputRoot,
      now: () => new Date("2026-02-26T08:00:00.000Z"),
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {}
      }
    });

    expect(mockApi.campaignBodies[4]?.policyId).toBe("pilot-stage3");
    expect(mockApi.campaignBodies[4]?.recipePack).toBe("java-gradle-java17-baseline-pack");
    expect(mockApi.campaignBodies[4]?.targetSelector).toBe("master");
  });

  it("validates that pilot config contains exactly five repos", () => {
    expect(() =>
      normalizePilotConfig({
        apiBaseUrl: "http://localhost:3000",
        repos: [{ name: "repo-1", owner: "org", repo: "service-1" }]
      })
    ).toThrowError("exactly 5 repos");
  });

  it("maps report failure kinds into deterministic recommendations", () => {
    const recommendations = buildPilotRecommendations({
      report: {
        window: "30d",
        cohort: "all",
        cohortCounts: {
          totalApplyRuns: 10,
          cohortApplyRuns: 10,
          excludedApplyRuns: 0
        },
        generatedAt: "2026-02-26T08:00:00.000Z",
        totalsByStatus: {},
        topFailureKinds: [
          { failureKind: "artifact_resolution", count: 5 },
          { failureKind: "code_compile_failure", count: 3 },
          { failureKind: "tool_missing", count: 2 }
        ],
        blockedByFailureKind: [],
        prOutcomes: {
          opened: 5,
          merged: 3,
          closedUnmerged: 1,
          open: 1,
          mergeRate: 0.6
        },
        timeToGreen: {
          sampleSize: 4,
          p50Hours: 4,
          p90Hours: 12
        },
        retryRate: {
          retriedRuns: 1,
          totalRuns: 10,
          rate: 0.1
        }
      },
      repoResults: []
    });

    expect(recommendations.top3FailureKinds.map((item) => item.failureKind)).toEqual([
      "artifact_resolution",
      "code_compile_failure",
      "tool_missing"
    ]);
    expect(
      recommendations.top3MissingRecipesOrRemediations.map((item) => item.id)
    ).toContain("toolchain-readiness-preflight");
    expect(recommendations.nextRecipePackCandidates.map((item) => item.id)).toEqual([
      "java-maven-repository-resilience-pack",
      "java-junit5-transition-pack"
    ]);
  });
});
