import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

function base64UrlEncode(input: Buffer | string): string {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return data
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function createJwt(input: {
  appId: string;
  privateKeyPem: string;
  nowSeconds?: number;
}): string {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT"
  };

  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: input.appId
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();

  const signature = signer.sign(input.privateKeyPem);
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

export interface GitHubAuthProvider {
  getToken(): Promise<string>;
}

export class PatAuthProvider implements GitHubAuthProvider {
  constructor(private readonly token: string) {}

  async getToken(): Promise<string> {
    if (!this.token) {
      throw new Error("GitHub authentication token is missing (set GITHUB_TOKEN)");
    }
    return this.token;
  }
}

export class GitHubAppAuthProvider implements GitHubAuthProvider {
  private cachedToken: string | null = null;
  private cachedExpiryEpochMs = 0;

  constructor(private readonly config: {
    appId: string;
    installationId: string;
    privateKeyPath: string;
    apiUrl: string;
  }) {}

  private isTokenFresh(nowMs: number): boolean {
    // refresh 60 seconds before expiry
    return (
      this.cachedToken !== null &&
      this.cachedExpiryEpochMs - 60_000 > nowMs
    );
  }

  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.isTokenFresh(now) && this.cachedToken) {
      return this.cachedToken;
    }

    const pem = await readFile(this.config.privateKeyPath, "utf8");
    const jwt = createJwt({
      appId: this.config.appId,
      privateKeyPem: pem
    });

    const response = await fetch(
      `${this.config.apiUrl.replace(/\/+$/, "")}/app/installations/${this.config.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "code-porter"
        }
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub App token exchange failed (status ${response.status})`);
    }

    const payload = (await response.json()) as {
      token?: string;
      expires_at?: string;
    };

    if (!payload.token || !payload.expires_at) {
      throw new Error("GitHub App token response missing token or expires_at");
    }

    this.cachedToken = payload.token;
    this.cachedExpiryEpochMs = new Date(payload.expires_at).getTime();
    return payload.token;
  }
}

export function createGitHubAuthProvider(
  env: NodeJS.ProcessEnv = process.env
): GitHubAuthProvider {
  const mode = (env.GITHUB_AUTH_MODE ?? "pat").toLowerCase();

  if (mode === "app") {
    const appId = env.GITHUB_APP_ID?.trim();
    const installationId = env.GITHUB_APP_INSTALLATION_ID?.trim();
    const privateKeyPath = env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();
    const apiUrl = env.GITHUB_API_URL?.trim() || "https://api.github.com";

    if (!appId || !installationId || !privateKeyPath) {
      throw new Error(
        "GitHub App authentication is not fully configured (GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY_PATH)"
      );
    }

    return new GitHubAppAuthProvider({
      appId,
      installationId,
      privateKeyPath,
      apiUrl
    });
  }

  return new PatAuthProvider(env.GITHUB_TOKEN ?? "");
}

export { createJwt as __createJwtForTests };
