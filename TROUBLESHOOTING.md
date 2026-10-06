# Troubleshooting

## "… generation provider is not configured."

The capability's `*_PROVIDER` is `none` or its key is missing. Set the variables in
[ENVIRONMENT.md](ENVIRONMENT.md), restart **both** web and worker, run
`npm run providers:check`, then press **Resume / retry failed**. Completed work is kept.

## Project stays `QUEUED`

No worker is consuming the queue. Start `npm run worker`, check it logs
`AI Fantasy Studio worker started`, and that web and worker use the same `REDIS_URL`.

## "Could not queue the generation job"

Redis is unreachable from the web process. Check `REDIS_URL`, network and `GET /api/health`.

## Provider errors

| Symptom | Meaning / fix |
|---|---|
| HTTP 401/403 in the log | Wrong or revoked key, or wrong Azure region. Not retried. |
| HTTP 429 | Rate limited; retried with backoff + Retry-After. Lower `*_CONCURRENCY`. |
| Runway `SAFETY…` / `INPUT…` failure | Moderation rejected the prompt/image; not retried blindly. Edit the script or retry the shot. |
| "Task timed out" | Raise `PROVIDER_TASK_TIMEOUT_SEC`; the task is cancelled and retried. |
| ElevenLabs "does not list Urdu" | Choose a TTS model whose `models.list()` languages include Urdu (`ELEVENLABS_TTS_MODEL`). |
| Azure "ur-PK voices missing in region" | Use a region that offers the ur-PK neural voices. |
| "The language model declined this script" | The LLM refused the content; revise the script. |
| "output failed schema validation" | LLM returned invalid structure; retried automatically. Persistent → try a shorter script. |

## Shots failed QC repeatedly

The provider kept returning black, frozen, too-short or undecodable clips. See the shot's QC
records on the **Scenes** tab, adjust the story or retry the shot with **Regenerate frame + clip**.

## Final video failed quality control

The render is not published. The failing checks are listed on the **Logs** tab
(e.g. `av_sync`, `resolution`). Fix the cause (often FFmpeg build/fonts or disk space) and resume:
only assembly + QC re-run.

## FFmpeg problems

- `ffmpeg failed to start` → install FFmpeg or set `FFMPEG_PATH`/`FFPROBE_PATH`.
- `No such filter: 'subtitles'` → FFmpeg built without libass; install a full build or disable burn-in.
- Urdu burned-in subtitles show boxes → install Urdu fonts (`fonts-noto-core` provides Noto Nastaliq Urdu).
- `No space left on device` → free `WORK_DIR`; each 10-minute 1080p render needs several GB temporarily.

## Pause/cancel does nothing immediately

Both are *requests*; the worker confirms at the next safe checkpoint (between items or the next
provider poll, ≤ `PROVIDER_POLL_INTERVAL_MS`). The UI shows "pause requested — waiting for worker".

## Videos don't play in the browser (local storage)

Assets stream through `/api/assets/:id` with Range support and require the session cookie.
Make sure web and worker share `STORAGE_LOCAL_DIR`. For multi-host deployments use S3 storage.

## Tests

`npm test` needs Postgres (database `studio_test`), Redis (db 15) and FFmpeg; override with
`DATABASE_URL` / `REDIS_URL`. The integration tests truncate tables in the test database.
