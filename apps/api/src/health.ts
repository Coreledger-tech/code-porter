import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { query } from "./db/client.js";

const execFileAsync = promisify(execFile);

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function getJavaVersion(): Promise<string | null> {
  try {
    const { stderr } = await execFileAsync("java", ["-version"]);
    const firstLine = stderr.split("\n")[0]?.trim();
    return firstLine || null;
  } catch {
    return null;
  }
}

async function probeMavenCentral(): Promise<{
  ok: boolean;
  status?: number;
  reason?: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 3000);

  try {
    const response = await fetch("https://repo.maven.apache.org/maven2/", {
      method: "HEAD",
      signal: controller.signal
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "network_probe_failed"
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function buildHealthResponse(input: {
  probeNetwork: boolean;
}): Promise<Record<string, unknown>> {
  const [gitAvailable, mvnAvailable, javaAvailable, javaVersion] = await Promise.all([
    commandExists("git"),
    commandExists("mvn"),
    commandExists("java"),
    getJavaVersion()
  ]);

  let dbOk = false;
  try {
    await query("select 1");
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const response: Record<string, unknown> = {
    ok: dbOk,
    db: { ok: dbOk },
    tools: {
      git: gitAvailable,
      mvn: mvnAvailable,
      java: javaAvailable
    },
    javaVersion
  };

  if (input.probeNetwork) {
    response.network = {
      mavenCentral: await probeMavenCentral()
    };
  }

  return response;
}
