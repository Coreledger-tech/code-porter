const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  [/x-access-token:[^@\s]+@/gi, "x-access-token:[REDACTED]@"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]"],
  [/(gh[pousr]_[A-Za-z0-9]+)/g, "[REDACTED_GH_TOKEN]"],
  [/("?(?:token|authorization|password|secret|private_key)"?\s*[:=]\s*")([^"]+)/gi, "$1[REDACTED]"]
];

export function redactSecrets(input: string): string {
  let output = input;
  for (const [pattern, replacement] of TOKEN_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const redacted = entries.map(([key, child]) => {
      if (/token|authorization|password|secret|private[_-]?key/i.test(key)) {
        return [key, "[REDACTED]"] as const;
      }
      return [key, redactUnknown(child)] as const;
    });

    return Object.fromEntries(redacted);
  }

  return value;
}
