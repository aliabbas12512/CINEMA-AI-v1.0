# Environment variables

All variables are parsed and validated in `src/server/env.ts`; the app refuses to start with an
invalid configuration. Copy `.env.example` to `.env`. **Never commit `.env`.**

Next.js loads `.env` automatically; the worker and scripts load it with Node's
`--env-file-if-exists` (see `package.json`). In containers, pass variables through the
orchestrator's secret store instead.

## Core

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `production` enables Secure cookies |
| `APP_URL` | prod | `http://localhost:3000` | Public origin; used for CSRF origin checks |
| `LOG_LEVEL` | no | `info` | pino level |
| `DATABASE_URL` | **yes** | — | Postgres connection string (Supabase supported) |
| `DATABASE_SSL` | no | `false` | `true` for managed Postgres (verifies certificates) |
| `REDIS_URL` | no | `redis://127.0.0.1:6379` | BullMQ + rate limiting |
| `SESSION_SECRET` | **yes** | — | ≥ 32 chars; HMAC key for session token hashes |
| `ALLOW_SIGNUP` | no | `true` | Set `false` for a private studio |

## Storage

| Variable | Default | Description |
|---|---|---|
| `STORAGE_DRIVER` | `local` | `local` or `s3` |
| `STORAGE_LOCAL_DIR` | `./storage` | Local driver root (shared by web + worker) |
| `S3_ENDPOINT` | — | Custom endpoint (Supabase Storage S3, R2, MinIO); empty for AWS |
| `S3_REGION` | `us-east-1` | Bucket region |
| `S3_BUCKET` | — | Private bucket name (required for `s3`) |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | — | Server-side credentials (required for `s3`) |
| `S3_FORCE_PATH_STYLE` | `true` | Path-style addressing (needed by Supabase/MinIO) |
| `SIGNED_URL_TTL_SEC` | `3600` | Presigned download URL lifetime |

## FFmpeg

| Variable | Default | Description |
|---|---|---|
| `WORK_DIR` | `./tmp/work` | Scratch space for rendering (several GB per 10-minute project) |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Binaries |

## Providers

| Variable | Values | Description |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` \| `none` | Script analysis + planning |
| `ANTHROPIC_API_KEY` | secret | Anthropic API key |
| `ANTHROPIC_MODEL` | default `claude-opus-5-5` | Model id |
| `IMAGE_PROVIDER` | `runway` \| `none` | References + keyframes |
| `IMAGE_PROVIDER_API_KEY` | secret | Runway API secret |
| `IMAGE_MODEL` | `gen4_image` \| `gen4_image_turbo` | |
| `VIDEO_PROVIDER` | `runway` \| `none` | Image-to-video |
| `VIDEO_PROVIDER_API_KEY` | secret | Runway API secret (also used by the video fallback) |
| `VIDEO_MODEL` | `gen4.5` \| `veo3.1` \| `veo3.1_fast` | |
| `VIDEO_FALLBACK_PROVIDER` | `runway` \| `none` | Optional fallback |
| `VIDEO_FALLBACK_MODEL` | as `VIDEO_MODEL` | Required when a fallback is set |
| `VOICE_PROVIDER` | `azure` \| `elevenlabs` \| `none` | Urdu voice |
| `VOICE_PROVIDER_API_KEY` | secret | Azure Speech key or ElevenLabs key |
| `VOICE_FALLBACK_PROVIDER` / `VOICE_FALLBACK_API_KEY` | as above | Optional fallback voice provider |
| `AZURE_SPEECH_REGION` | e.g. `eastus` | Required for Azure |
| `ELEVENLABS_TTS_MODEL` | default `eleven_v3` | Must list Urdu in `models.list()` (checked by validate) |
| `ELEVENLABS_NARRATOR_VOICE_ID` | id | Required for ElevenLabs voice |
| `ELEVENLABS_MALE_VOICE_IDS` / `ELEVENLABS_FEMALE_VOICE_IDS` | comma-separated ids | Character voice pools |
| `MUSIC_PROVIDER` / `MUSIC_PROVIDER_API_KEY` | `elevenlabs` \| `none` | Optional |
| `SFX_PROVIDER` / `SFX_PROVIDER_API_KEY` | `elevenlabs` \| `none` | Optional |
| `LIPSYNC_PROVIDER` / `LIPSYNC_PROVIDER_API_KEY` | `sync` \| `none` | Optional |
| `LIPSYNC_MODEL` | `lipsync-2` (also `lipsync-2-pro`, `sync-3`, …) | |

Required for a complete film: LLM, image, video and voice. Music, SFX and lip sync are optional
and shown as "provider not configured" when absent.

## Pipeline tuning

| Variable | Default | Description |
|---|---|---|
| `MAX_RETRIES` | `3` | Retries per unit for transient errors / QC failures |
| `RETRY_BASE_DELAY_MS` | `2000` | Backoff base (exponential with jitter, honours Retry-After) |
| `PROVIDER_POLL_INTERVAL_MS` | `5000` | Async task polling interval (Runway asks for ≥ 5 s) |
| `PROVIDER_TASK_TIMEOUT_SEC` | `1800` | Per-task timeout; task is cancelled and retried |
| `IMAGE_CONCURRENCY` / `VIDEO_CONCURRENCY` / `VOICE_CONCURRENCY` / `AUDIO_CONCURRENCY` | 3 / 3 / 4 / 3 | Parallel provider requests per project (respect your plan's rate limits) |
| `WORKER_CONCURRENCY` | `2` | Projects processed in parallel per worker |

## Limits

| Variable | Default | Description |
|---|---|---|
| `MAX_SCRIPT_CHARS` | `60000` | Script length cap |
| `RATE_LIMIT_GENERATIONS_PER_HOUR` | `10` | Start/resume/retry calls per user per hour |
| `RATE_LIMIT_AUTH_PER_15MIN` | `20` | Login/sign-up attempts per IP per 15 minutes |
