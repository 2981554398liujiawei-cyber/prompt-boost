/**
 * 轻量日志。所有输出经 redact() 脱敏。
 */
import { redact } from "./security/redact.js";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export function createLogger(verbose = false): Logger {
  const emit = (level: "info" | "warn" | "error" | "debug", message: string): void => {
    const line = `[prompt-boost:${level}] ${redact(message)}`;
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  };

  return {
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
    debug: (m) => {
      if (verbose) emit("debug", m);
    },
  };
}
