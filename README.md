# AI Fantasy Studio

Paste **one story or script** (English, Urdu or Roman Urdu) and generate an approximately
10-minute **cinematic fantasy film** with **professional Pakistani Urdu narration and dialogue**,
original music, sound effects, subtitles and an FFmpeg-rendered, quality-checked MP4.

```
Script → Story Bible → Character & World Bible → Scenes → Shots
       → Urdu voice (real durations) → Character/location references → Keyframes
       → Image-to-video (+ lip sync) → Music & SFX → FFmpeg assembly → QC → Download
```

## What is real (and what is not)

| Area | Status |
|---|---|
| Pipeline, job queue, persistence, resume, retry, pause/cancel | Implemented and tested end-to-end (real Postgres, Redis, FFmpeg, storage) |
| FFmpeg assembly, audio ducking, loudness normalization, subtitles, QC | Implemented and tested with real FFmpeg |
| Provider adapters (Anthropic, Runway, Azure Speech, ElevenLabs, sync.) | Implemented against the **official SDKs / official docs**; **not yet exercised with live API keys** in this repository's CI — run `npm run providers:check` with your keys first |
| Lip sync | Only when a lip-sync provider is configured; otherwise shown as *unavailable* |
| Music / SFX | Only when configured; otherwise shown as *provider not configured* (no silent fakes) |
| 4K | FFmpeg upscale of provider clips (labelled as such in the UI) |

There are **no placeholder videos, simulated progress or fake provider responses** in the
application. Test doubles live only in `tests/mocks/` and are injected by the test suite.
If a provider is missing, the project stops at that stage with a message such as
*"Video generation provider is not configured."* — work already done is kept for resume.

## Quick start

```bash
cp .env.example .env              # fill in DATABASE_URL, REDIS_URL, SESSION_SECRET, provider keys
docker compose up -d postgres redis
npm ci
npm run db:migrate
npm run providers:check           # validates every configured provider against its live API
npm run dev                       # web app on http://localhost:3000
npm run worker                    # generation worker (separate terminal; needs FFmpeg)
```

## Documentation

- [SETUP.md](SETUP.md) — installation, local development, production & worker deployment
- [ENVIRONMENT.md](ENVIRONMENT.md) — every environment variable
- [ARCHITECTURE.md](ARCHITECTURE.md) — components, data model, security
- [PROVIDERS.md](PROVIDERS.md) — provider adapters, verified API surface, limitations
- [GENERATION_PIPELINE.md](GENERATION_PIPELINE.md) — stages, timing/sync, retries, resume, QC
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` / `npm run build && npm start` | Web app |
| `npm run worker` | BullMQ generation worker |
| `npm run db:migrate` | Apply SQL migrations in `drizzle/` |
| `npm run providers:check` | Show configured providers and validate them live |
| `npm run typecheck` / `npm run lint` | Static checks |
| `npm test` | Unit + integration tests (needs Postgres, Redis, FFmpeg) |
| `npm run test:e2e` | Playwright UI tests against a running app + worker |
