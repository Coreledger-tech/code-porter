import { redactUnknown } from "./redact.js";

export type LogLevel = "info" | "warn" | "error";

export interface LogContext {
  runId?: string;
  campaignId?: string;
  projectId?: string;
  workerId?: string;
  failureKind?: string;
  durationMs?: number;
}

function writeLog(level: LogLevel, event: string, message: string, context?: LogContext, payload?: Record<string, unknown>): void {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    message,
    ...(context ?? {}),
    ...(payload ? { payload: redactUnknown(payload) } : {})
  };

  const serialized = JSON.stringify(record);
  if (level === "error") {
    // eslint-disable-next-line no-console
    console.error(serialized);
  } else {
    // eslint-disable-next-line no-console
    console.log(serialized);
  }
}

export function logInfo(event: string, message: string, context?: LogContext, payload?: Record<string, unknown>): void {
  writeLog("info", event, message, context, payload);
}

export function logWarn(event: string, message: string, context?: LogContext, payload?: Record<string, unknown>): void {
  writeLog("warn", event, message, context, payload);
}

export function logError(event: string, message: string, context?: LogContext, payload?: Record<string, unknown>): void {
  writeLog("error", event, message, context, payload);
}
