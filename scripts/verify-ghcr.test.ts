import { afterAll, describe, expect, it, vi } from "vitest";

const { execFileMock, logMock, errorMock } = vi.hoisted(() => {
  return {
    execFileMock: vi.fn(),
    logMock: vi.fn(),
    errorMock: vi.fn()
  };
});

vi.mock("node:child_process", () => {
  return {
    execFile: execFileMock
  };
});

const originalConsoleLog = console.log;
const originalConsoleError = console.error;
console.log = logMock as any;
console.error = errorMock as any;

import { parseArgs, verifyGhcrImage } from "./verify-ghcr.js";

describe("verify-ghcr", () => {
  it("fails when --tag is missing", () => {
    expect(() => parseArgs([])).toThrow(/--tag/);
  });

  it("succeeds on public image pull", async () => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback?.(null, "pulled", "");
    });

    await expect(verifyGhcrImage("v1.0.0-rc.2")).resolves.toBeUndefined();
    expect(logMock).toHaveBeenCalledWith(
      "[verify:ghcr] Pulled ghcr.io/coreledger-tech/code-porter:v1.0.0-rc.2"
    );
  });

  it("prints private-pull fallback when docker pull is unauthorized", async () => {
    execFileMock.mockReset();
    errorMock.mockReset();
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback?.(new Error("unauthorized: authentication required"));
    });

    await expect(verifyGhcrImage("v1.0.0-rc.2")).rejects.toThrow();
    expect(errorMock).toHaveBeenCalledWith(
      expect.stringContaining("Private package fallback")
    );
    expect(errorMock).toHaveBeenCalledWith(
      'echo "$GITHUB_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin'
    );
  });
});

afterAll(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
});
