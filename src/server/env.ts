import { z } from "zod";

/**
 * Server-only environment configuration.
 *
 * Every secret is read here and nowhere else. This module must never be
 * imported from a client component.
 */

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const intWithDefault = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_SSL: z.enum(["true", "false"]).default("false"),
  REDIS_URL: z.string().min(1).default("redis://127.0.0.1:6379"),

  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  ALLOW_SIGNUP: z.enum(["true", "false"]).default("true"),

  // Storage
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./storage"),
  S3_ENDPOINT: optionalString,
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true"),
  SIGNED_URL_TTL_SEC: intWithDefault(3600, 60, 7 * 24 * 3600),

  // Work dir for FFmpeg scratch files
  WORK_DIR: z.string().default("./tmp/work"),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),

  // Providers (names select the adapter; empty = not configured)
  LLM_PROVIDER: z.enum(["anthropic", "none"]).default("anthropic"),
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),

  IMAGE_PROVIDER: z.enum(["runway", "none"]).default("none"),
  IMAGE_PROVIDER_API_KEY: optionalString,
  IMAGE_MODEL: z.string().default("gen4_image"),

  VIDEO_PROVIDER: z.enum(["runway", "none"]).default("none"),
  VIDEO_PROVIDER_API_KEY: optionalString,
  VIDEO_MODEL: z.string().default("gen4.5"),
  VIDEO_FALLBACK_PROVIDER: z.enum(["runway", "none"]).default("none"),
  VIDEO_FALLBACK_MODEL: optionalString,

  VOICE_PROVIDER: z.enum(["azure", "elevenlabs", "none"]).default("none"),
  VOICE_PROVIDER_API_KEY: optionalString,
  VOICE_FALLBACK_PROVIDER: z.enum(["azure", "elevenlabs", "none"]).default("none"),
  VOICE_FALLBACK_API_KEY: optionalString,
  AZURE_SPEECH_REGION: optionalString,
  ELEVENLABS_TTS_MODEL: z.string().default("eleven_v3"),
  ELEVENLABS_NARRATOR_VOICE_ID: optionalString,
  ELEVENLABS_MALE_VOICE_IDS: optionalString,
  ELEVENLABS_FEMALE_VOICE_IDS: optionalString,

  MUSIC_PROVIDER: z.enum(["elevenlabs", "none"]).default("none"),
  MUSIC_PROVIDER_API_KEY: optionalString,

  SFX_PROVIDER: z.enum(["elevenlabs", "none"]).default("none"),
  SFX_PROVIDER_API_KEY: optionalString,

  LIPSYNC_PROVIDER: z.enum(["sync", "none"]).default("none"),
  LIPSYNC_PROVIDER_API_KEY: optionalString,
  LIPSYNC_MODEL: z.string().default("lipsync-2"),

  // Pipeline tuning
  MAX_RETRIES: intWithDefault(3, 0, 10),
  RETRY_BASE_DELAY_MS: intWithDefault(2000, 10, 120_000),
  PROVIDER_POLL_INTERVAL_MS: intWithDefault(5000, 50, 60_000),
  PROVIDER_TASK_TIMEOUT_SEC: intWithDefault(1800, 10, 4 * 3600),
  MAX_QC_REGENERATIONS: intWithDefault(1, 0, 5),
  IMAGE_CONCURRENCY: intWithDefault(3, 1, 20),
  VIDEO_CONCURRENCY: intWithDefault(3, 1, 20),
  VOICE_CONCURRENCY: intWithDefault(4, 1, 20),
  AUDIO_CONCURRENCY: intWithDefault(3, 1, 20),
  WORKER_CONCURRENCY: intWithDefault(2, 1, 20),

  // Limits
  MAX_SCRIPT_CHARS: intWithDefault(60_000, 1000, 500_000),
  RATE_LIMIT_GENERATIONS_PER_HOUR: intWithDefault(10, 1, 1000),
  RATE_LIMIT_AUTH_PER_15MIN: intWithDefault(20, 1, 1000),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: forget the cached env so tests can mutate process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
