import { pino, type Logger } from "pino";

const REDACT_PATHS = [
  "config.WALLET_SECRET_KEY",
  "*.WALLET_SECRET_KEY",
  "*.secretKey",
  "*.privateKey",
  "*.secret",
];

export function createLogger(level: string): Logger {
  const dev = process.env.NODE_ENV === "development";
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    ...(dev ? { transport: { target: "pino-pretty" } } : {}),
  });
}

export type { Logger };
