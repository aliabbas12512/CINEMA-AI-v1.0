# AI Fantasy Studio

Paste **one story or script** (English, Urdu or Roman Urdu) and generate a **cinematic fantasy
film** with **Pakistani Urdu narration and dialogue**, subtitles and an FFmpeg-rendered,
quality-checked MP4.

```
Script → Story Bible → Character & World Bible → Scenes → Shots
       → Urdu voice (real durations) → Character/location references → Keyframes
       → Video clips → (Music & SFX) → FFmpeg assembly → QC → Download
```

**Runway is not required.** The default video provider (`ffmpeg_motion`) renders real
cinematic camera motion over the AI keyframes locally — no account, no payment. Runway (or
any future generative video API) can be switched on later with one variable.

## Providers used by default

| Capability | Provider | Cost to start | Required env |
|---|---|---|---|
| Story analysis, scenes, Urdu dialogue | Anthropic Claude | Paid API usage | `ANTHROPIC_API_KEY` |
| Urdu voice (`ur-PK-AsadNeural`, `ur-PK-UzmaNeural`) | Azure AI Speech | Azure account | `SPEECH_KEY`, `SPEECH_REGION` |
| Character / location / keyframe images | Cloudflare Workers AI (`flux-1-schnell`) | **10,000 free Neurons/day** (~170 images/day) | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` |
| Video clips | `ffmpeg_motion` (local camera motion) | **Free, no account** | `VIDEO_PROVIDER=ffmpeg_motion` (default) |
| Music, SFX, lip sync | ElevenLabs, sync. | Optional | see `.env.example` |
| Generative video (future) | Runway | Paid, optional | `VIDEO_PROVIDER=runway`, `VIDEO_PROVIDER_API_KEY` |

`ffmpeg_motion` moves the **camera** (push-in, pull-out, pan, crane, orbit, chosen from the
shot plan); characters inside the frame do not move. It is labelled as such in the UI and
on every shot. See [PROVIDERS.md](PROVIDERS.md) for the alternatives that were evaluated.

## Exact commands

```bash
# 1. Infrastructure (or use your own Postgres + Redis)
docker compose up -d postgres redis

# 2. Install + configure
npm ci
cp .env.example .env
#   fill: SESSION_SECRET (openssl rand -base64 48), ANTHROPIC_API_KEY,
#         SPEECH_KEY, SPEECH_REGION, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
npm run db:migrate
npm run providers:check          # validates each configured provider against its live API

# 3. Start the app (two terminals)
npm run build && npm start       # web UI on http://localhost:3000   (dev: npm run dev)
npm run worker                   # generation worker (needs FFmpeg)

# 4. Run the complete video pipeline from the CLI (same providers as the UI)
npm run pipeline:run -- --script examples/sample-story.txt --duration 60 --email you@example.com

# 5. Tests
npm run lint && npm run typecheck
npm test                         # unit + integration (needs Postgres, Redis, FFmpeg)
E2E_BASE_URL=http://localhost:3000 npm run test:e2e   # Playwright, app + worker running
```

`npm run verify:offline` runs the whole pipeline with **real** video/FFmpeg/DB/storage while
the three keyed services (Anthropic, Azure, Cloudflare) are replaced by the test doubles in
`tests/mocks/`. The project title says so. It exists to verify the machinery when keys are
not available; it is not a substitute for a real generation.

## Honesty rules in the code

No placeholder videos, simulated progress or fake provider responses exist in `src/`. Test
doubles live only in `tests/`. A missing provider stops the project at that stage with e.g.
*"Script analysis (LLM) generation provider is not configured."*; finished work is kept for resume.

## Documentation

[SETUP.md](SETUP.md) · [ENVIRONMENT.md](ENVIRONMENT.md) · [ARCHITECTURE.md](ARCHITECTURE.md) ·
[PROVIDERS.md](PROVIDERS.md) · [GENERATION_PIPELINE.md](GENERATION_PIPELINE.md) ·
[TROUBLESHOOTING.md](TROUBLESHOOTING.md)
