import pino, { type Logger } from "pino";
import type { Config } from "./config";

/** Secrets must not reach the log even if someone logs a whole object by accident. */
const REDACTED_PATHS = [
  "password",
  "currentPassword",
  "newPassword",
  "secret",
  "token",
  "authorization",
  "cookie",
  "*.password",
  "*.currentPassword",
  "*.newPassword",
  "*.secret",
  "*.token",
  "*.authorization",
  "*.cookie",
];

export function createLogger(config: Pick<Config, "logLevel">): Logger {
  return pino({ level: config.logLevel, redact: { paths: REDACTED_PATHS, censor: "[redacted]" } });
}
