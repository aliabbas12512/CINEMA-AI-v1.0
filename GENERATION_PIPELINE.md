# Generation pipeline

`src/server/pipeline/orchestrator.ts` runs idempotent stages in order. Each stage reads
persisted unit status and only processes units that are not `completed`. **Running the
pipeline again is resume**: successful shots, lines and cues are never regenerated.

| # | Stage (`project.status`) | Units | Provider | Output |
|---|---|---|---|---|
| 1 | `ANALYZING` | 1 | LLM | `world_bibles` (story + world), `characters`, `locations` |
| 2 | `PLANNING` | 1 outline + 1 per scene | LLM | `scenes`, approved `dialogue_lines` (Urdu + English), `shots` |
| 3 | `GENERATING_VOICE` | 1 per line | Voice | WAV/MP3 per line, measured durations, scene timeline |
| 4 | `GENERATING_CHARACTERS` | 1 per character + location | Image | primary reference images |
| 5 | `GENERATING_SCENES` | 1 per shot | Image (+refs) | first-frame keyframes |
| 6 | `GENERATING_VIDEO` | 1 per shot (+ lip sync) | Video, Lip sync | shot clips |
| 7 | `GENERATING_AUDIO` | 1 per scene + 1 per shot | Music, SFX | score cues, SFX beds |
| 8 | `ASSEMBLING` | per shot/scene | FFmpeg | final MP4, mix, subtitles, previews |
| 9 | `QUALITY_CHECK` | 1 | FFprobe/FFmpeg | QC records; publish or refuse |

Each stage writes a `generation_jobs` row (project, run, stage, status, progress, units,
attempts, error, timestamps). Every vendor call writes a `provider_jobs` row (provider, model,
external id, attempt, fallback flag, error, estimated/actual cost, usage, duration).

## Why voice runs before picture

Video generation is the most expensive step. Generating the Urdu audio first gives the
**real** duration of every line, so scene and shot lengths are computed from real audio
(`src/server/media/timeline.ts`) before any clip is paid for:

- lines are placed sequentially: 0.6 s lead-in, 0.35 s gaps, 0.8 s tail;
- scene length = max(voice span, planned shot total);
- the scene is split across shots proportionally to their planned length, capped at the
  provider's maximum clip length × 1.2 (bounded slow-down), with any remainder held on the
  last frame (logged as a warning);
- each shot requests the smallest provider-supported duration ≥ its slot;
- assembly converts everything to **frame counts** (24/30 fps), so picture and sound line up
  frame-accurately.

## Story → plan

1. **Analysis** produces a Story Bible (title, genre, plot, timeline, characters with full
   visual + voice profiles, locations, objects, creatures, visual events, world style).
2. **Outline** converts the story into scenes with final spoken lines: narration
   (`speaker = narrator`) vs dialogue (`speaker = character_id`); `original_text` keeps the
   source, `urdu_text` is natural Pakistani Urdu in Nastaliq script, `english_text` is the
   subtitle translation. Lines are stored with `approved = true` before any voice work.
3. **Shots** per scene: duration, camera (establishing … orbit), movement, lighting, action,
   emotion, VFX, transition, keyframe prompt, motion prompt, negative prompt, SFX cues,
   ambience and whether a character speaks on camera (lip-sync target).

All LLM output is JSON-schema constrained, re-parsed with Zod and checked semantically
(unique ids, known speakers/locations, non-empty Urdu, duration bounds). The user's script is
passed as data inside `<script>` tags with instructions to never follow text inside it.

## Consistency

- One **primary reference image per character and per location**, generated once, stored in
  `character_references` / `locations.reference_asset_id`, and attached (tagged) to every keyframe
  request that features them. Characters are never redesigned between shots.
- One **voice identity per speaker per provider** in `voices`, assigned deterministically
  and reused for every line.
- One **style guide** per project (from the selected preset) is appended to every visual prompt.

## Retries, fallback and failures

- `withRetry` (exponential backoff with jitter, honours `Retry-After`) for retryable errors:
  network, 408/409/425/429/5xx, timeouts, invalid LLM JSON, and **QC failures** of a clip.
  `MAX_RETRIES` attempts per unit; permanent errors (auth, validation, moderation) fail fast.
- After retries, a configured fallback provider is tried and recorded (`is_fallback`, shot
  `videoProvider "... (fallback)"`, warning log).
- A unit that still fails is marked `failed` with a human-readable error; the stage finishes the
  other units, then the project becomes `FAILED` with e.g. *"2 shot(s) failed after retries.
  Use 'Retry failed' to regenerate only those shots."*

## Resume, pause, cancel

- **Resume** (`POST /api/projects/:id/generate`): resets only `failed` (and crashed `running`)
  units to `pending`, increments the run number and enqueues a new job.
- **Pause** sets `control = pause_requested`. Workers stop at the next checkpoint (between
  units or during provider polling) **without cancelling** in-flight provider tasks; resume
  re-polls those exact task ids.
- **Cancel** sets `control = cancel_requested`; in-flight provider tasks are cancelled where the
  provider supports it, and the project becomes `CANCELLED`.
- **Retry one shot** (`POST /api/projects/:id/shots/:shotId/retry`): resets that shot's clip
  (optionally its keyframe) and re-renders the film; nothing else is regenerated.
- Worker crash: BullMQ re-delivers the stalled job; the idempotent stages continue from the DB.

## Assembly (FFmpeg)

1. Every shot clip (lip-synced version when available) is scaled/cropped to the output size,
   slowed (≤ 1.2×) or held if short, trimmed to an exact frame count, given fades at scene
   boundaries / non-cut transitions, and encoded H.264 yuv420p.
2. Clips are concatenated (stream copy).
3. Per scene: voice track (lines at their real offsets), music bed (looped/trimmed, faded) and
   SFX bed (clips at shot starts); concatenated across scenes.
4. Final mix: music ducked under speech with `sidechaincompress`, SFX bed, two-pass EBU R128
   `loudnorm` to −16 LUFS / −1.5 dBTP, `alimiter` at −1 dBFS (no clipping).
5. Subtitles (Urdu + English, SRT + WebVTT) are built from the **final** line timings.
6. Mux to MP4 (H.264 + AAC 192 kbps, `+faststart`), optional soft subtitle track
   (`mov_text`) or burned-in subtitles (libass).
7. 480p previews per scene and a thumbnail.

All FFmpeg calls use `spawn` with argument arrays (no shell). User text reaches FFmpeg only via
files we write (subtitles), never via arguments.

## Quality control

Per clip (before it is accepted): zero-byte, decodable, has video, duration, resolution,
black-frame ratio, frozen whole clip → failure triggers regeneration.

Per voice/music/SFX file: zero-byte, decodable, has audio, minimum duration.

Final render: H.264, yuv420p, AAC, exact resolution and fps, duration vs timeline (±0.5 s),
A/V stream duration difference ≤ 0.25 s, subtitle stream present when selected, subtitle cue
timing, black frames, long freezes. Any failed `error` check → the render is **not published**
and the project is `FAILED`.

## Progress

`src/server/services/status.ts` computes progress from unit statuses in the database
(lines, references, keyframes, clips, cues) and stage job rows — never from timers. Overall
progress is a weighted sum (video generation weighs most). ETA is shown only during video
generation after at least three clips completed in the current run, and is labelled an estimate.
The UI subscribes via Server-Sent Events (`/api/projects/:id/events`), with automatic reconnect.
