import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Router } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => {
  return { queryMock: vi.fn() };
});

vi.mock("../db/client.js", () => {
  return { query: queryMock };
});

import { projectsRouter } from "./projects.js";

type MockRes = {
  statusCode: number;
  body?: unknown;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
};

function createMockRes(): MockRes {
  return {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    }
  };
}

function findRouteHandler(router: Router, method: "post" | "get", path: string) {
  const layer = (router as any).stack.find((item: any) => {
    return item.route?.path === path && item.route?.methods?.[method];
  });

  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }

  return layer.route.stack[0].handle as (req: any, res: any) => Promise<unknown>;
}

describe("projectsRouter", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("rejects missing required fields", async () => {
    const handler = findRouteHandler(projectsRouter(), "post", "/projects");
    const res = createMockRes();

    await handler({ body: {} }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "name and localPath are required" });
  });

  it("creates a project for a valid absolute local path", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const tempDir = await mkdtemp(join(tmpdir(), "code-porter-project-test-"));
    const handler = findRouteHandler(projectsRouter(), "post", "/projects");
    const res = createMockRes();

    await handler(
      {
        body: {
          name: "demo",
          localPath: tempDir
        }
      },
      res
    );

    expect(res.statusCode).toBe(201);
    expect((res.body as any).name).toBe("demo");
    expect((res.body as any).type).toBe("local");
    expect((res.body as any).localPath).toBe(tempDir);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("creates a github project", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const handler = findRouteHandler(projectsRouter(), "post", "/projects/github");
    const res = createMockRes();

    await handler(
      {
        body: {
          name: "gh-demo",
          owner: "Coreledger-tech",
          repo: "code-porter",
          defaultBranch: "main"
        }
      },
      res
    );

    expect(res.statusCode).toBe(201);
    expect((res.body as any).type).toBe("github");
    expect((res.body as any).owner).toBe("Coreledger-tech");
    expect((res.body as any).repo).toBe("code-porter");
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
