import { describe, expect, it } from "vitest";
import { redactSecrets, redactUnknown } from "./redact.js";

describe("redact", () => {
  it("redacts token patterns from strings", () => {
    const input =
      "https://x-access-token:abc123@github.com/org/repo.git Authorization: Bearer ghp_secret123";
    const redacted = redactSecrets(input);
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("ghp_secret123");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts secret-like object keys recursively", () => {
    const payload = {
      token: "abc",
      nested: {
        authorization: "Bearer 123",
        keep: "value"
      }
    };
    const redacted = redactUnknown(payload) as {
      token: string;
      nested: { authorization: string; keep: string };
    };
    expect(redacted.token).toBe("[REDACTED]");
    expect(redacted.nested.authorization).toBe("[REDACTED]");
    expect(redacted.nested.keep).toBe("value");
  });
});
