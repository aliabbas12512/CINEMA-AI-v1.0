import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  characterReferences,
  characters,
  dialogueLines,
  locations,
  qualityChecks,
  scenes,
  shots,
  worldBibles,
  type Shot,
} from "@/server/db/schema";
import { probe } from "@/server/media/probe";
import { qcShotClip } from "@/server/media/qc";
import { ffmpeg, n } from "@/server/media/ffmpeg";
import { cutAudio, placeClips } from "@/server/media/audio";
import { ProviderError, ProviderNotConfiguredError } from "@/server/providers/errors";
import type { GenerationResult, ImageProvider, ReferenceImage } from "@/server/providers/types";
import { assetToFile, assetToMedia, saveMediaAsset } from "../assets";
import type { PipelineContext } from "../context";
import { StageFailedError } from "../context";
import { runAsyncTask } from "../provider-runner";
import { mapLimit } from "../retry";
import { StageTracker, tally } from "../stage";
import { splitShotPrompt } from "./plan";

function isInterrupt(err: unknown): boolean {
  const name = (err as Error).name;
  return name === "PipelineCancelledError" || name === "PipelinePausedError" || name === "RetryAbortedError";
}

async function getStyle(ctx: PipelineContext): Promise<string> {
  const [wb] = await ctx.db.select({ s: worldBibles.styleGuide }).from(worldBibles).where(eq(worldBibles.projectId, ctx.projectId));
  return wb?.s ?? "";
}

async function validateImage(result: GenerationResult, ctx: PipelineContext, name: string): Promise<void> {
  if (result.data.byteLength === 0) throw new ProviderError({ provider: "image", message: "Zero-byte image", retryable: true });
  const p = path.join(ctx.workDir, "validate", `${name}.${result.ext}`);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, result.data);
  const info = await probe(p).catch(() => null);
  if (!info?.video || info.video.width < 256) {
    throw new ProviderError({ provider: "image", message: "Generated image is not decodable or too small", retryable: true });
  }
}

/** GENERATING_CHARACTERS: one persistent reference image per character and per location. */
export async function referencesStage(ctx: PipelineContext): Promise<void> {
  const chars = await ctx.db.select().from(characters).where(eq(characters.projectId, ctx.projectId));
  const locs = await ctx.db.select().from(locations).where(eq(locations.projectId, ctx.projectId));
  const todoChars = chars.filter((c) => c.referenceStatus !== "completed");
  const todoLocs = locs.filter((l) => l.referenceStatus !== "completed");
  if (todoChars.length + todoLocs.length === 0) return;

  const image = ctx.providers.image;
  if (!image) throw new ProviderNotConfiguredError("Image");
  const tracker = await StageTracker.start(ctx, "GENERATING_CHARACTERS");
  const style = await getStyle(ctx);
  const total = chars.length + locs.length;
  let completed = total - todoChars.length - todoLocs.length;
  let failed = 0;
  const report = () => tracker.progress({ completed, total, failed, message: "Designing characters and locations" });
  await report();

  type Job = { kind: "character"; id: string; prompt: string } | { kind: "location"; id: string; prompt: string };
  const jobs: Job[] = [
    ...todoChars.map(
      (c): Job => ({
        kind: "character",
        id: c.id,
        prompt: `${style}. Character reference sheet, full body, neutral standing pose, plain softly lit studio background, entire figure visible. ${c.name}: ${c.visualPrompt}. Face: ${c.face}. Hair: ${c.hair}. Eyes: ${c.eyes}. Skin: ${c.skinTone}. Clothing: ${c.clothing}. Accessories: ${c.accessories}.`,
      }),
    ),
    ...todoLocs.map(
      (l): Job => ({
        kind: "location",
        id: l.id,
        prompt: `${style}. Environment concept frame, no people. ${l.name} (${l.type}): ${l.visualPrompt}. Architecture: ${l.architecture}. Climate: ${l.climate}.`,
      }),
    ),
  ];

  await mapLimit(jobs, ctx.env.IMAGE_CONCURRENCY, async (job) => {
    await ctx.checkpoint();
    try {
      const out = await runAsyncTask({
        ctx,
        stage: "GENERATING_CHARACTERS",
        capability: "image",
        entity: { type: job.kind, id: job.id },
        requestSummary: { prompt: job.prompt.slice(0, 500) },
        slot: { primary: image, fallback: null },
        buildRequest: async (_p, attempt) => ({ prompt: job.prompt, aspect: job.kind === "character" ? "9:16" : "16:9", seed: attempt * 7919 }),
        validate: (r) => validateImage(r, ctx, `${job.kind}-${job.id}`),
      });
      const folder = job.kind === "character" ? "characters" : "locations";
      const { asset } = await saveMediaAsset(ctx, out.result, {
        kind: job.kind === "character" ? "character_ref" : "location_ref",
        folder,
        name: `${job.kind}-${job.id}`,
        provider: out.provider.info.id,
        providerModel: out.provider.info.model,
        providerJobId: out.providerJobId,
      });
      if (job.kind === "character") {
        await ctx.db.transaction(async (tx) => {
          await tx.update(characterReferences).set({ isPrimary: false }).where(eq(characterReferences.characterId, job.id));
          await tx.insert(characterReferences).values({ characterId: job.id, assetId: asset.id, prompt: job.prompt, isPrimary: true });
          await tx.update(characters).set({ referenceStatus: "completed", referenceError: null }).where(eq(characters.id, job.id));
        });
      } else {
        await ctx.db.update(locations).set({ referenceStatus: "completed", referenceAssetId: asset.id, referenceError: null }).where(eq(locations.id, job.id));
      }
      completed++;
    } catch (err) {
      if (isInterrupt(err)) throw err;
      failed++;
      const msg = (err as Error).message.slice(0, 2000);
      if (job.kind === "character") await ctx.db.update(characters).set({ referenceStatus: "failed", referenceError: msg }).where(eq(characters.id, job.id));
      else await ctx.db.update(locations).set({ referenceStatus: "failed", referenceError: msg }).where(eq(locations.id, job.id));
      await ctx.event("error", "GENERATING_CHARACTERS", `Reference image failed: ${msg}`, { entity: job.kind, id: job.id });
    }
    await report();
  });
  if (failed) throw new StageFailedError("GENERATING_CHARACTERS", `${failed} reference image(s) failed. Resume to retry only those.`);
  await tracker.complete();
}

/**
 * Consistency inputs for a shot. Providers that accept reference images get
 * the location + character primary references (tagged). Providers without
 * reference support get the full Character/World Bible description instead,
 * so recurring characters are described identically in every prompt.
 */
async function shotReferences(ctx: PipelineContext, shot: Shot, image: ImageProvider): Promise<{ refs: ReferenceImage[]; tagHint: string }> {
  const refs: ReferenceImage[] = [];
  const hints: string[] = [];
  const useRefs = image.maxReferences > 0;
  const [loc] = shot.locationKey
    ? await ctx.db
        .select()
        .from(locations)
        .where(and(eq(locations.projectId, ctx.projectId), eq(locations.key, shot.locationKey)))
    : [];
  if (loc) {
    if (useRefs && loc.referenceAssetId) {
      refs.push({ tag: "place", image: await assetToMedia(ctx, loc.referenceAssetId) });
      hints.push(`set in @place`);
    } else if (!useRefs) {
      hints.push(`Setting: ${loc.name} - ${loc.visualPrompt}`);
    }
  }
  const chars = await ctx.db.select().from(characters).where(eq(characters.projectId, ctx.projectId));
  let n = 1;
  for (const key of shot.characterKeys) {
    const c = chars.find((x) => x.key === key);
    if (!c) continue;
    if (!useRefs) {
      hints.push(`${c.name}: ${c.visualPrompt}; face ${c.face}; hair ${c.hair}; eyes ${c.eyes}; skin ${c.skinTone}; wearing ${c.clothing}`);
      continue;
    }
    if (refs.length >= image.maxReferences) break;
    // The primary reference is reused for every shot so recurring characters never get redesigned.
    const [primary] = await ctx.db
      .select()
      .from(characterReferences)
      .where(and(eq(characterReferences.characterId, c.id), eq(characterReferences.isPrimary, true)))
      .orderBy(desc(characterReferences.createdAt))
      .limit(1);
    if (!primary) continue;
    const tag = `char${n++}`;
    refs.push({ tag, image: await assetToMedia(ctx, primary.assetId) });
    hints.push(`@${tag} is ${c.name}`);
  }
  return { refs, tagHint: hints.join(". ") };
}

/** GENERATING_SCENES: first-frame keyframe per shot, conditioned on character/location references. */
export async function keyframesStage(ctx: PipelineContext): Promise<void> {
  const all = await ctx.db.select().from(shots).where(eq(shots.projectId, ctx.projectId)).orderBy(asc(shots.sceneId), asc(shots.sequence));
  const todo = all.filter((s) => s.keyframeStatus !== "completed");
  if (todo.length === 0) return;
  const image = ctx.providers.image;
  if (!image) throw new ProviderNotConfiguredError("Image");
  const tracker = await StageTracker.start(ctx, "GENERATING_SCENES");
  const style = await getStyle(ctx);
  let { completed } = tally(all, (s) => s.keyframeStatus);
  let failed = 0;
  const report = () => tracker.progress({ completed, total: all.length, failed, message: "Painting shot keyframes" });
  await report();

  await mapLimit(todo, ctx.env.IMAGE_CONCURRENCY, async (shot) => {
    await ctx.checkpoint();
    await ctx.db.update(shots).set({ keyframeStatus: "running" }).where(eq(shots.id, shot.id));
    try {
      const { refs, tagHint } = await shotReferences(ctx, shot, image);
      const { keyframe } = splitShotPrompt(shot.prompt);
      const prompt = `${keyframe} ${tagHint ? `(${tagHint}).` : ""} Camera: ${shot.camera}. Lighting: ${shot.lighting}. ${style}`;
      const out = await runAsyncTask({
        ctx,
        stage: "GENERATING_SCENES",
        capability: "image",
        entity: { type: "shot_keyframe", id: shot.id },
        requestSummary: { prompt: prompt.slice(0, 500), references: refs.map((r) => r.tag) },
        slot: { primary: image, fallback: null },
        buildRequest: async (_p, attempt) => ({ prompt, aspect: ctx.settings.aspectRatio, references: refs, seed: attempt * 104729 }),
        validate: (r) => validateImage(r, ctx, `keyframe-${shot.id}`),
      });
      const { asset } = await saveMediaAsset(ctx, out.result, {
        kind: "keyframe",
        folder: "shots",
        name: `keyframe-${shot.id}`,
        provider: out.provider.info.id,
        providerModel: out.provider.info.model,
        providerJobId: out.providerJobId,
      });
      await ctx.db.update(shots).set({ keyframeStatus: "completed", keyframeAssetId: asset.id, error: null }).where(eq(shots.id, shot.id));
      completed++;
    } catch (err) {
      if (isInterrupt(err)) {
        await ctx.db.update(shots).set({ keyframeStatus: "pending" }).where(eq(shots.id, shot.id));
        throw err;
      }
      failed++;
      await ctx.db.update(shots).set({ keyframeStatus: "failed", error: (err as Error).message.slice(0, 2000) }).where(eq(shots.id, shot.id));
      await ctx.event("error", "GENERATING_SCENES", `Keyframe failed: ${(err as Error).message}`, { shot_id: shot.id });
    }
    await report();
  });
  if (failed) throw new StageFailedError("GENERATING_SCENES", `${failed} keyframe(s) failed. Resume to retry only those.`);
  await tracker.complete();
}

/** GENERATING_VIDEO: image-to-video per shot (with QC + regeneration), then lip sync where supported. */
export async function videoStage(ctx: PipelineContext): Promise<void> {
  const all = await ctx.db.select().from(shots).where(eq(shots.projectId, ctx.projectId)).orderBy(asc(shots.sceneId), asc(shots.sequence));
  const lipsyncOn = ctx.settings.lipSync && !!ctx.providers.lipsync;
  const wantLipsync = (s: Shot) =>
    s.speakingLineId !== null &&
    (s.lipsyncStatus === "pending" || s.lipsyncStatus === "failed" || (lipsyncOn && s.lipsyncStatus === "unavailable"));
  if (!ctx.settings.lipSync || !ctx.providers.lipsync) {
    const reason = !ctx.settings.lipSync ? "disabled in project settings" : "Lip-sync provider is not configured";
    const affected = all.filter((s) => s.speakingLineId && (s.lipsyncStatus === "pending" || s.lipsyncStatus === "failed"));
    for (const s of affected) await ctx.db.update(shots).set({ lipsyncStatus: "unavailable" }).where(eq(shots.id, s.id));
    if (affected.length) await ctx.event("warn", "GENERATING_VIDEO", `Lip sync unavailable for ${affected.length} speaking shot(s): ${reason}.`);
  }
  const todo = all.filter((s) => s.videoStatus !== "completed" || (lipsyncOn && wantLipsync(s)));
  if (todo.length === 0) return;

  const video = ctx.providers.video;
  if (!video.primary) throw new ProviderNotConfiguredError("Video");
  const tracker = await StageTracker.start(ctx, "GENERATING_VIDEO");

  const style = await getStyle(ctx);
  const done = () => all.filter((s) => s.videoStatus === "completed").length;
  let failed = 0;
  const report = () => tracker.progress({ completed: done(), total: all.length, failed, message: "Animating shots" });
  await report();

  await mapLimit(todo, ctx.env.VIDEO_CONCURRENCY, async (shot) => {
    await ctx.checkpoint();
    try {
      if (shot.videoStatus !== "completed") {
        if (!shot.keyframeAssetId) throw new StageFailedError("GENERATING_VIDEO", `Shot ${shot.id} has no keyframe`);
        if (!shot.generationDurationSec) throw new StageFailedError("GENERATING_VIDEO", `Shot ${shot.id} has no scheduled duration`);
        await ctx.db.update(shots).set({ videoStatus: "running", attempts: shot.attempts + 1 }).where(eq(shots.id, shot.id));
        const firstFrame = await assetToMedia(ctx, shot.keyframeAssetId);
        const { motion } = splitShotPrompt(shot.prompt);
        const prompt = `${motion} Camera: ${shot.camera}. Action: ${shot.action}. Emotion: ${shot.emotion}. ${shot.visualEffects}. ${style}`;
        const timeline = shot.timelineDurationSec ?? shot.generationDurationSec;
        const out = await runAsyncTask({
          ctx,
          stage: "GENERATING_VIDEO",
          capability: "video",
          entity: { type: "shot_video", id: shot.id },
          requestSummary: { prompt: prompt.slice(0, 500), duration: shot.generationDurationSec },
          slot: video,
          buildRequest: async (p, attempt) => ({
            prompt,
            negativePrompt: shot.negativePrompt,
            firstFrame,
            // Fallback models may support different durations; quantize per provider.
            durationSec:
              p.capabilities.durations.find((d) => d >= (shot.generationDurationSec ?? 0)) ?? Math.max(...p.capabilities.durations),
            aspect: ctx.settings.aspectRatio,
            seed: attempt * 15485863 + shot.sequence,
            camera: shot.camera,
          }),
          validate: async (r) => {
            const p = path.join(ctx.workDir, "validate", `shot-${shot.id}.${r.ext}`);
                      await mkdir(path.dirname(p), { recursive: true });
            await writeFile(p, r.data);
            const qc = await qcShotClip(p, Math.min(timeline, shot.generationDurationSec ?? timeline) * 0.9);
            await ctx.db.insert(qualityChecks).values(
              qc.results.map((q) => ({ projectId: ctx.projectId, targetType: "shot" as const, targetId: shot.id, check: q.check, passed: q.passed, severity: q.severity, details: q.details ?? null })),
            );
            const bad = qc.results.filter((q) => !q.passed && q.severity === "error");
            if (bad.length) {
              await ctx.db.update(shots).set({ qcStatus: "failed", qcNotes: bad.map((b) => b.check).join(", ") }).where(eq(shots.id, shot.id));
              throw new ProviderError({ provider: "qc", message: `Shot failed QC (${bad.map((b) => b.check).join(", ")}); regenerating`, retryable: true });
            }
          },
        });
        const { asset } = await saveMediaAsset(ctx, out.result, {
          kind: "shot_video",
          folder: "shots",
          name: `video-${shot.id}`,
          provider: out.provider.info.id,
          providerModel: out.provider.info.model,
          providerJobId: out.providerJobId,
        });
        shot.videoStatus = "completed";
        shot.videoAssetId = asset.id;
        await ctx.db
          .update(shots)
          .set({
            videoStatus: "completed",
            videoAssetId: asset.id,
            qcStatus: "completed",
            qcNotes: null,
            error: null,
            videoProvider: `${out.provider.info.id}/${out.provider.info.model}${out.isFallback ? " (fallback)" : ""}`,
          })
          .where(eq(shots.id, shot.id));
      }
      await report();
      if (ctx.settings.lipSync && ctx.providers.lipsync && wantLipsync(shot)) {
        try {
          await lipsyncShot(ctx, shot);
        } catch (err) {
          if (isInterrupt(err)) throw err;
          // Non-blocking: the un-synced clip is used and the failure is visible on the shot.
          await ctx.event("warn", "GENERATING_VIDEO", `Lip sync failed; using original clip: ${(err as Error).message}`, { shot_id: shot.id });
        }
      }
    } catch (err) {
      if (isInterrupt(err)) {
        if (shot.videoStatus !== "completed") await ctx.db.update(shots).set({ videoStatus: "pending" }).where(eq(shots.id, shot.id));
        throw err;
      }
      failed++;
      if (shot.videoStatus !== "completed") {
        await ctx.db.update(shots).set({ videoStatus: "failed", error: (err as Error).message.slice(0, 2000) }).where(eq(shots.id, shot.id));
      }
      await ctx.event("error", "GENERATING_VIDEO", `Shot failed: ${(err as Error).message}`, { shot_id: shot.id, scene_id: shot.sceneId });
      await report();
    }
  });
  if (failed) throw new StageFailedError("GENERATING_VIDEO", `${failed} shot(s) failed after retries. Use "Retry failed" to regenerate only those shots.`);
  await tracker.complete();
}

/** Lip-sync one speaking shot with the exact audio that will play under it. */
async function lipsyncShot(ctx: PipelineContext, shot: Shot): Promise<void> {
  const lipsync = ctx.providers.lipsync!;
  const [scene] = await ctx.db.select().from(scenes).where(eq(scenes.id, shot.sceneId));
  const sceneShots = await ctx.db.select().from(shots).where(eq(shots.sceneId, shot.sceneId)).orderBy(asc(shots.sequence));
  const lines = await ctx.db.select().from(dialogueLines).where(eq(dialogueLines.sceneId, shot.sceneId));
  if (!scene || !shot.videoAssetId || !shot.timelineDurationSec) return;
  const shotStart = sceneShots.filter((s) => s.sequence < shot.sequence).reduce((sum, s) => sum + (s.timelineDurationSec ?? 0), 0);
  const dur = shot.timelineDurationSec;
  await ctx.db.update(shots).set({ lipsyncStatus: "running" }).where(eq(shots.id, shot.id));
  try {
    const dir = path.join(ctx.workDir, "lipsync", shot.id);
      await mkdir(dir, { recursive: true });
    // Scene voice track, then the slice under this shot.
    const placed = [];
    for (const l of lines) {
      if (!l.audioAssetId || l.startOffsetSec === null) continue;
      placed.push({ path: await assetToFile(ctx, l.audioAssetId), startSec: l.startOffsetSec });
    }
    const sceneVoice = path.join(dir, "scene-voice.wav");
    await placeClips(placed, scene.timelineDurationSec ?? dur, sceneVoice);
    const audioPath = path.join(dir, "audio.wav");
    await cutAudio(sceneVoice, shotStart, dur, audioPath);
    const clipPath = path.join(dir, "clip.mp4");
    const src = await assetToFile(ctx, shot.videoAssetId);
    await ffmpeg(["-i", src, "-t", n(dur), "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "18", clipPath]);
    const videoMedia = { data: await readFile(clipPath), mimeType: "video/mp4", ext: "mp4" };
    const audioMedia = { data: await readFile(audioPath), mimeType: "audio/wav", ext: "wav" };
    const out = await runAsyncTask({
      ctx,
      stage: "GENERATING_VIDEO",
      capability: "lipsync",
      entity: { type: "shot_lipsync", id: shot.id },
      requestSummary: { durationSec: dur },
      slot: { primary: lipsync, fallback: null },
      buildRequest: async () => ({ video: videoMedia, audio: audioMedia }),
      validate: async (r) => {
        const p = path.join(dir, `out.${r.ext}`);
        await writeFile(p, r.data);
        const qc = await qcShotClip(p, dur * 0.8);
        if (qc.results.some((q) => !q.passed && q.severity === "error")) {
          throw new ProviderError({ provider: lipsync.info.id, message: "Lip-sync output failed QC", retryable: true });
        }
      },
    });
    const { asset } = await saveMediaAsset(ctx, out.result, {
      kind: "lipsync_video",
      folder: "shots",
      name: `lipsync-${shot.id}`,
      provider: out.provider.info.id,
      providerModel: out.provider.info.model,
      providerJobId: out.providerJobId,
    });
    await ctx.db.update(shots).set({ lipsyncStatus: "completed", lipsyncAssetId: asset.id }).where(eq(shots.id, shot.id));
  } catch (err) {
    if (isInterrupt(err)) {
      await ctx.db.update(shots).set({ lipsyncStatus: "pending" }).where(eq(shots.id, shot.id));
      throw err;
    }
    await ctx.db.update(shots).set({ lipsyncStatus: "failed", error: `Lip sync: ${(err as Error).message}`.slice(0, 2000) }).where(eq(shots.id, shot.id));
    throw err;
  }
}
