import { describe, expect, it } from "vitest";
import { runCommand } from "./commands.js";

describe("runCommand", () => {
  it("times out a hung command and returns partial output", async () => {
    const result = await runCommand(
      {
        command: "node",
        args: [
          "-e",
          "process.stdout.write('verify-start\\n'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
        ]
      },
      process.cwd(),
      { timeoutMs: 200 }
    );

    expect(result.status).toBe("failed");
    expect(result.failureKind).toBe("verify_timeout");
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain("verify-start");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(200);
  });

  it("aborts a hung command when the signal is cancelled", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort("operator cancellation"), 150);

    const result = await runCommand(
      {
        command: "node",
        args: [
          "-e",
          "process.stdout.write('verify-abort\\n'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
        ]
      },
      process.cwd(),
      { timeoutMs: 5_000, signal: controller.signal }
    );

    expect(result.status).toBe("failed");
    expect(result.failureKind).toBe("verifier_infrastructure_failure");
    expect(result.aborted).toBe(true);
    expect(result.reason).toContain("operator cancellation");
    if (typeof result.stdout === "string" && result.stdout.length > 0) {
      expect(result.stdout).toContain("verify-abort");
    }
  });
});
