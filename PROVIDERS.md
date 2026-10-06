# Providers

All AI vendors sit behind interfaces in `src/server/providers/types.ts`. The pipeline never
imports a vendor SDK directly; `src/server/providers/registry.ts` builds the provider set from
environment variables. Unconfigured capabilities are `null` and the pipeline reports
`"<Capability> generation provider is not configured."` — it never substitutes fake output.

## Contracts

| Interface | Methods | Used for |
|---|---|---|
| `LlmProvider` | `generateStructured(schema, system, prompt)`, `validate()` | Story bible, scene outline + Urdu dialogue, shot lists |
| `ImageProvider` (async) | `submit` → `getStatus` → `download`, `cancel`, `validate` | Character/location references, shot keyframes |
| `VideoProvider` (async) | same + `capabilities` (durations, prompt length, native size) | Image-to-video per shot |
| `LipSyncProvider` (async) | same | Lip-sync of on-camera dialogue shots |
| `VoiceProvider` | `assignVoice(profile)`, `generate()`, `validate()` | Urdu narration/dialogue |
| `MusicProvider` / `SfxProvider` | `generate()`, `validate()` | Scene score, per-shot SFX/ambience |
| `StorageProvider` | `put/get/getStream/stat/delete/signedUrl` | Local FS or S3-compatible |

Async tasks persist their external task id in `provider_jobs` **before** polling, so an
interrupted worker resumes the same task instead of paying for a new one.

## How the APIs were verified

The outbound network for this build blocked vendor documentation websites, so every adapter
was written against **vendor-published sources only**:

| Provider | Verified against |
|---|---|
| Anthropic | Official `@anthropic-ai/sdk` (TypeScript) + Anthropic API reference bundled with Claude Code |
| Runway | Official `@runwayml/sdk` 4.x generated type definitions (`textToImage`, `imageToVideo`, `tasks`, `organization`) |
| Azure AI Speech | Microsoft's official docs source (`MicrosoftDocs/azure-ai-docs`: `rest-text-to-speech.md`, TTS language-support table) |
| ElevenLabs | Official `@elevenlabs/elevenlabs-js` 2.x generated request/response types |
| sync. | Official `@sync.so/sdk` generated types |
| Supabase Storage | Supabase docs ("S3 Authentication") via the Supabase docs search API |

**None of the adapters has been exercised with live API keys in this repository** (no keys were
available). Before production, run `npm run providers:check` (or *Providers → Validate* in the UI),
then generate a short (1-minute) project and review the output.

## Video without Runway — evaluation (October 2026)

Runway's API requires buying credits before the first call. Alternatives checked:

| Option | Free path? | Source | Decision |
|---|---|---|---|
| Google Veo via Gemini API | No — Veo is not on the Gemini API free tier ($0.05–$0.60 per second) | [ai.google.dev pricing](https://ai.google.dev/gemini-api/docs/pricing) | Not free |
| fal.ai (Kling, LTX, …) | $10 credit **only after adding a payment method** | [fal.ai pricing](https://fal.ai/pricing) | Needs a card |
| Replicate | No standing free credits for video | [replicate.com](https://replicate.com/collections/try-for-free) | Not free |
| Hugging Face Inference Providers | $0.10/month free credit | third-party summaries | Too small for video |
| Luma / Hailuo / Kling web apps | Consumer web credits, not a verified free API | third-party summaries | Not an API path |
| **Local FFmpeg camera motion** | **Yes — no account** | this repository | **Default (`ffmpeg_motion`)** |

Result: no hosted generative-video API was verified as usable without payment, so the app
ships with `ffmpeg_motion` and keeps the provider interface open (`VideoProvider`) for Runway,
Veo, fal or any other API later.

## ffmpeg_motion (default video) — `VIDEO_PROVIDER=ffmpeg_motion`

- Renders each shot from its AI keyframe with FFmpeg `zoompan` (2× supersampled for smooth
  sub-pixel motion), H.264 1920×1080 (or 1080×1920), 24 fps, any whole duration 2–12 s.
- The move is chosen from the planner's camera language: establishing/aerial/wide → pull-out;
  dolly/close-up/low-angle → push-in; tracking/POV/OTS → pan; crane/high-angle → crane-up;
  orbit → orbit; anything else → gentle drift. Smoothstep easing.
- Output passes the same shot QC as any provider (decodable, duration, resolution, black
  frames, frozen frames). Cost recorded as 0 USD.
- Limitation: no character animation and no lip movement (lip sync providers can still be
  applied on top).

## Cloudflare Workers AI (images) — `IMAGE_PROVIDER=cloudflare`

Verified against Cloudflare's official docs source (`cloudflare/cloudflare-docs`):

- `POST https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/run/{model}`
  with `Authorization: Bearer {CLOUDFLARE_API_TOKEN}`; token needs *Workers AI - Read* and
  *Workers AI - Edit*. Response `{ result: { image: <base64> }, success, errors }`.
- `@cf/black-forest-labs/flux-1-schnell` (default): input `prompt` (≤ 2048 chars), `steps` (≤ 8,
  default 4). `@cf/leonardo/lucid-origin`: adds `width`, `height`, `seed`.
- Pricing: **10,000 Neurons per day free on every account**; flux-1-schnell costs 4.80 neurons
  per 512×512 tile + 9.60 per step (≈ 58 neurons per 1024² image at 4 steps → ≈ 170 images/day
  free). The pipeline records neurons per image from the real output size.
- `validate()` calls `GET /client/v4/user/tokens/verify`.
- Limitation: no reference-image input. Consistency comes from repeating the stored
  Character/World Bible description (face, hair, eyes, skin, wardrobe, location look) in every
  keyframe prompt instead of image conditioning (Runway's tagged references remain available).
- Network note: `api.cloudflare.com` was not reachable from the build sandbox, so this adapter
  is verified against the documented contract but **not yet with a live token**.

## Anthropic (LLM) — `LLM_PROVIDER=anthropic`

- Model: `ANTHROPIC_MODEL` (default `claude-opus-5-5`), adaptive thinking, streaming.
- Structured output via `output_config.format` (JSON schema from Zod) **and** re-validation
  with Zod plus semantic checks (`src/server/domain/schemas.ts`).
- Server-side refusal fallback enabled (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`);
  cost is computed for the model that actually served the request.
- Cost: token usage × Anthropic list price (table in `anthropic-llm.ts`, sourced from the API
  reference; unknown models → *cost unavailable*).
- `validate()`: `models.retrieve(model)`.

## Runway (optional, paid) — `IMAGE_PROVIDER=runway`, `VIDEO_PROVIDER=runway`

- Base `https://api.dev.runwayml.com`, `X-Runway-Version` handled by the SDK.
- Images: `textToImage.create` with `gen4_image` (default) or `gen4_image_turbo`; up to three
  `referenceImages` with tags (`@place`, `@char1`, `@char2`) — this is how recurring characters
  and locations stay visually consistent. Inputs are sent as data URIs (≤ 5 MB; larger
  images are re-encoded to JPEG with FFmpeg).
- Video: `imageToVideo.create` with the keyframe as first frame.

  | `VIDEO_MODEL` | Durations (s) | 16:9 output | Negative prompt |
  |---|---|---|---|
  | `gen4.5` (default) | 2–10 (integer) | 1280×720 | no |
  | `veo3.1` | 4, 6, 8 | 1920×1080 | yes (`audio:false` is sent) |
  | `veo3.1_fast` | 4, 6, 8 | 1920×1080 | yes |

  Output is upscaled/cropped by FFmpeg to the project resolution.
- Status mapping: `PENDING/THROTTLED → pending`, `RUNNING(progress) → running`,
  `SUCCEEDED(output[]) → succeeded`, `FAILED(failure, failureCode)`, `CANCELLED`.
  Failure codes starting with `SAFETY`/`INPUT` are treated as permanent (no blind retries).
- Output URLs expire (24–48 h); they are downloaded immediately through an SSRF-guarded fetch.
- Cost: credits (`estimatedCost.credits`, final `cost.credits`).
- Fallback: `VIDEO_FALLBACK_PROVIDER=runway` + `VIDEO_FALLBACK_MODEL` (e.g. `veo3.1` primary,
  `gen4.5` fallback). Every clip records which provider/model produced it, flagged `(fallback)`.
- `validate()`: `organization.retrieve()` (credit balance).

## Azure AI Speech (Urdu voice) — `SPEECH_KEY` + `SPEECH_REGION`

Setting `SPEECH_KEY` selects Azure automatically (or `VOICE_PROVIDER=azure` with
`VOICE_PROVIDER_API_KEY` / `AZURE_SPEECH_REGION`). Network note: `*.tts.speech.microsoft.com`
is blocked in the build sandbox, so Azure could not be called live there.


- `POST https://{AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
  headers `Ocp-Apim-Subscription-Key`, `Content-Type: application/ssml+xml`,
  `X-Microsoft-OutputFormat: riff-48khz-16bit-mono-pcm`, `User-Agent`.
- Pakistani Urdu neural voices: **`ur-PK-AsadNeural` (male)**, **`ur-PK-UzmaNeural` (female)**.
- Limitation: only two ur-PK voices exist. Additional characters are differentiated by SSML
  `<prosody>` pitch/rate offsets assigned **once per speaker** and stored in `voices`, so every
  character keeps the same voice for the whole film. For a larger, more distinct cast use
  ElevenLabs with your own voice library.
- All script text is XML-escaped; voice names and prosody values are whitelisted.
- `validate()`: `GET …/cognitiveservices/voices/list` and checks both ur-PK voices exist in the region.
- Cost: Azure returns no price per request → *Cost unavailable* (characters are recorded).

## ElevenLabs (voice, music, SFX) — `VOICE_PROVIDER=elevenlabs`, `MUSIC_PROVIDER=elevenlabs`, `SFX_PROVIDER=elevenlabs`

- Voice: `textToSpeech.convert(voiceId, { text, modelId: ELEVENLABS_TTS_MODEL, languageCode: "ur",
  previousText, nextText, voiceSettings })`. Voice IDs are **never invented**: set
  `ELEVENLABS_NARRATOR_VOICE_ID`, `ELEVENLABS_MALE_VOICE_IDS`, `ELEVENLABS_FEMALE_VOICE_IDS`
  from your own library (choose/clone voices with a natural Pakistani Urdu delivery).
  `validate()` calls `models.list()` and **fails unless the selected model lists Urdu**.
- Music: `music.compose({ prompt, musicLengthMs (3 000–600 000), forceInstrumental: true })` — one
  original cue per scene, length = real scene duration.
- SFX: `textToSoundEffects.convert({ text, durationSeconds (0.5–30), modelId: "eleven_text_to_sound_v2" })` —
  one ambience/SFX bed per shot from the shot plan.
- Output format `mp3_44100_128` (available on all tiers).
- Cost: not returned by the API → *Cost unavailable* (characters / seconds recorded).

## sync. (lip sync) — `LIPSYNC_PROVIDER=sync`

- `generations.createWithFiles(video, audio, { model: LIPSYNC_MODEL, options: { sync_mode: "cut_off" } })`,
  then `generations.get(id)` until `COMPLETED` (`outputUrl`) or `FAILED/REJECTED`.
- Media is uploaded multipart, so private storage never needs public URLs.
- Input is the exact shot clip trimmed to its timeline length plus the exact slice of the scene's
  voice track that plays under it, so the result is in sync with the final mix.
- Only shots where the planner marked a **character speaking on camera** are lip-synced; narration never is.
- The SDK exposes no cancel endpoint; `cancel()` is a documented no-op.
- Lip-sync failure is non-blocking: the un-synced clip is used and the shot shows `lip-sync failed`.

## Adding a provider

1. Implement the relevant interface in `src/server/providers/adapters/<vendor>.ts` using the
   vendor's official SDK or documented REST API; map errors with `toProviderError` (retryable
   for 408/409/425/429/5xx/network).
2. Add it to the env enum + `registry.ts`.
3. Implement `validate()` against a cheap real endpoint.
4. Add tests with a test double in `tests/mocks/` (never in `src/`).
