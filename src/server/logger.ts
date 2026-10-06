import pino from "pino";

/**
 * Structured server-side logger. Child loggers carry project_id / job_id /
 * scene_id / shot_id so every line can be correlated.
 *
 * Redaction strips anything that looks like a credential, defensively, even
 * though code should never pass secrets to the logger in the first place.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: process.env.SERVICE_NAME ?? "ai-fantasy-studio" },
  redact: {
    paths: [
      "apiKey",
      "*.apiKey",
      "authorization",
      "*.authorization",
      "headers.authorization",
      "*.headers.authorization",
      "password",
      "*.password",
      "token",
      "*.token",
      "secret",
      "*.secret",
    ],
    censor: "[REDACTED]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type LogContext = {
  project_id?: string;
  job_id?: string;
  scene_id?: string;
  shot_id?: string;
  stage?: string;
  provider?: string;
};

export function logFor(ctx: LogContext) {
  return logger.child(ctx);
}
