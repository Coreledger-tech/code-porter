import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __createJwtForTests,
  createGitHubAuthProvider,
  GitHubAppAuthProvider,
  PatAuthProvider
} from "./auth-provider.js";

let tempPaths: string[] = [];

async function createPrivateKeyFile(): Promise<string> {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048
  });
  const directory = await mkdtemp(join(tmpdir(), "code-porter-auth-"));
  tempPaths.push(directory);
  const path = join(directory, "github-app.pem");
  await writeFile(path, privateKey.export({ type: "pkcs1", format: "pem" }), "utf8");
  return path;
}

describe("auth-provider", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(
      tempPaths.map(async (path) => {
        await rm(path, { recursive: true, force: true });
      })
    );
    tempPaths = [];
  });

  it("creates a valid JWT payload shape for GitHub App auth", async () => {
    const pemPath = await createPrivateKeyFile();
    const privateKeyPem = await readFile(pemPath, "utf8");
    const token = __createJwtForTests({
      appId: "12345",
      privateKeyPem,
      nowSeconds: 1_700_000_000
    });

    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    expect(parts.every((part) => part.length > 0)).toBe(true);
  });

  it("returns PAT provider by default and reads GITHUB_TOKEN", async () => {
    const provider = createGitHubAuthProvider({
      GITHUB_TOKEN: "ghp_test_token"
    } as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(PatAuthProvider);
    await expect(provider.getToken()).resolves.toBe("ghp_test_token");
  });

  it("throws for app mode when required config is missing", () => {
    expect(() =>
      createGitHubAuthProvider({
        GITHUB_AUTH_MODE: "app",
        GITHUB_APP_ID: "1"
      } as NodeJS.ProcessEnv)
    ).toThrow(/not fully configured/i);
  });

  it("exchanges and caches GitHub App installation token", async () => {
    const pemPath = await createPrivateKeyFile();
    const fetchMock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          token: "ghs_install_token",
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
        })
      });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GitHubAppAuthProvider({
      appId: "12345",
      installationId: "67890",
      privateKeyPath: pemPath,
      apiUrl: "https://api.github.com"
    });

    const first = await provider.getToken();
    const second = await provider.getToken();

    expect(first).toBe("ghs_install_token");
    expect(second).toBe("ghs_install_token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
