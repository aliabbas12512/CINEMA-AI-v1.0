# Architecture

```
 Browser (Next.js React UI)
   │  HTTPS, session cookie (httpOnly, SameSite=Lax)       SSE: /api/projects/:id/events
   ▼
 Next.js web (App Router route handlers, Node runtime)  ──────────────►  PostgreSQL
   │  auth, validation (Zod), ownership checks, rate limits                (Drizzle ORM)
   │  enqueue                                                                 ▲
   ▼                                                                          │
 Redis (BullMQ queue "afs-pipeline", rate-limit counters)                     │
   │                                                                          │
   ▼                                                                          │
 Worker (src/worker) ── runPipeline() ── stages ──► provider adapters ──► AI vendors
   │                                     │
   │                                     └──► FFmpeg / FFprobe (spawn, no shell)
   ▼
 Object storage (local FS or S3-compatible: AWS S3 / Supabase Storage / R2)
```

## Repository layout

| Path | Purpose |
|---|---|
| `src/app` | Pages (dashboard, new project, project, providers, auth) and API route handlers |
| `src/components` | Client components (project dashboard with SSE, forms) |
| `src/lib` | Client-safe code (settings schema, fetch helper) |
| `src/server/env.ts` | Zod-validated environment (the only place secrets are read) |
| `src/server/db` | Drizzle schema, client, migrator |
| `src/server/domain` | LLM output schemas + semantic validation |
| `src/server/providers` | Interfaces, errors, registry, vendor adapters |
| `src/server/media` | FFmpeg runner, probe, timeline, audio, video, subtitles, QC |
| `src/server/pipeline` | Context, stages, retry, provider runner, queue, orchestrator |
| `src/server/services` | Projects, auth, status, detail (used by API + tests) |
| `src/server/storage` | Local + S3 storage drivers |
| `src/worker` | BullMQ worker entrypoint |
| `drizzle/` | SQL migrations |
| `tests/` | Vitest unit/integration tests; `tests/mocks` holds test-only provider doubles |
| `e2e/` | Playwright UI tests |

## Data model (PostgreSQL)

UUID primary keys, `created_at/updated_at` timestamps, foreign keys with cascade, indexes on
lookup paths, unique constraints for natural keys, CHECK constraints (progress 0–100, positive
durations/sizes).

- `users`, `sessions` (HMAC of token only)
- `projects` (status, current stage, control flag, settings JSON, run counter, final asset)
- `scripts` (versioned), `world_bibles` (story + world JSON, style guide)
- `characters`, `character_references`, `locations`, `voices`
- `scenes`, `dialogue_lines` (approved final Urdu/English lines with real audio timing), `shots`
- `assets` (every stored file: kind, storage key, mime, size, sha256, duration, dimensions, provider, model)
- `audio_tracks`, `subtitles`, `render_jobs`, `quality_checks`
- `generation_jobs` (per stage per run), `provider_jobs` (per vendor request, cost), `generation_logs`

Row Level Security is enabled on all tables with no policies (defense in depth for Supabase);
the application role owns the tables and enforces authorization in `services/`.

## Security

| Concern | Implementation |
|---|---|
| Secrets | Only in env; `src/server/env.ts` is server-only; provider summary API returns no secrets; logger redacts key-like fields |
| Authentication | Email + scrypt password hashes; random 256-bit session tokens; DB stores HMAC-SHA256 of the token; httpOnly, Secure (prod), SameSite=Lax cookie |
| Authorization | Every project/asset/shot query is scoped by `user_id`; foreign ids return 404 |
| CSRF | State-changing routes require same-origin `Origin`/`Referer` |
| Rate limiting | Redis fixed windows: auth per IP, generation per user, validation per user; fails closed |
| Input validation | Zod on every body; script length cap; JSON body size caps |
| SSRF | Provider output URLs: https only, DNS-resolved, private/loopback/link-local/metadata ranges blocked, manual redirect re-checks, size cap |
| Command injection | FFmpeg via `spawn` argument arrays, no shell; numbers formatted; filter paths escaped; user text only via files |
| Prompt injection | Script passed as tagged data; schema-constrained outputs; semantic validation |
| SSML injection | XML escaping; whitelisted voice names/prosody values |
| Files | Server-generated storage keys only (`projects/{uuid}/{folder}/{safe-name}`), path traversal rejected; private bucket; short-lived presigned URLs |
| Headers | `nosniff`, `X-Frame-Options: DENY`, referrer policy, permissions policy |

Webhooks: the pipeline polls providers and does not expose webhook endpoints, so there is no
unauthenticated inbound surface to verify. If webhooks are added, verify the vendor signature
before trusting the payload.

## Observability

pino JSON logs with `project_id`, `job_id`, `scene_id`, `shot_id`, `stage`; provider requests,
failures, retries, durations, assembly time and QC results are persisted in
`provider_jobs`, `generation_logs`, `render_jobs` and `quality_checks` and shown on the project page.
