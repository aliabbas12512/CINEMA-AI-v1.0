import { asc, eq } from "drizzle-orm";
import { qualityChecks, scenes, shots } from "@/server/db/schema";
import { qcAudioFile } from "@/server/media/qc";
import { saveMediaAsset } from "../assets";
import type { PipelineContext } from "../context";
import { StageFailedError } from "../context";
import { musicPrompt } from "../prompts";
import { runSyncCall } from "../provider-runner";
import { mapLimit } from "../retry";
import { StageTracker } from "../stage";

type AudioReq = { sfx?: Array<{ description: string; at_sec: number; duration_sec: number }>; ambience?: string };

function isInterrupt(err: unknown): boolean {
  const name = (err as Error).name;
  return name === "PipelineCancelledError" || name === "PipelinePausedError" || name === "RetryAbortedError";
}

export function sfxPromptFor(req: AudioReq): string | null {
  const parts: string[] = [];
  if (req.ambience?.trim()) parts.push(`Ambience: ${req.ambience.trim()}`);
  for (const s of req.sfx ?? []) parts.push(`at ${s.at_sec.toFixed(1)}s: ${s.description}`);
  return parts.length ? `Cinematic fantasy film sound design, no music, no speech. ${parts.join("; ")}` : null;
}

/** GENERATING_AUDIO: original music cue per scene and SFX/ambience per shot. */
export async function audioStage(ctx: PipelineContext): Promise<void> {
  const sceneRows = await ctx.db.select().from(scenes).where(eq(scenes.projectId, ctx.projectId)).orderBy(asc(scenes.sequence));
  const shotRows = await ctx.db.select().from(shots).where(eq(shots.projectId, ctx.projectId));
  // "unavailable" items are retried when the provider has since been configured.
  const retryable = (st: string, configured: boolean) => st === "pending" || st === "failed" || (configured && st === "unavailable");
  const musicTodo = sceneRows.filter((s) => retryable(s.musicStatus, !!ctx.providers.music));
  const sfxTodo = shotRows.filter((s) => retryable(s.sfxStatus, !!ctx.providers.sfx));
  if (musicTodo.length + sfxTodo.length === 0) return;
  if (!ctx.providers.music && !ctx.providers.sfx && [...musicTodo, ...sfxTodo].every((x) => ("musicStatus" in x ? x.musicStatus : x.sfxStatus) === "unavailable")) return;

  const tracker = await StageTracker.start(ctx, "GENERATING_AUDIO");
  const music = ctx.providers.music;
  const sfx = ctx.providers.sfx;
  if (!music && musicTodo.some((s) => s.musicStatus !== "unavailable")) {
    for (const s of musicTodo) await ctx.db.update(scenes).set({ musicStatus: "unavailable" }).where(eq(scenes.id, s.id));
    await ctx.event("warn", "GENERATING_AUDIO", "Music generation provider is not configured. The film will have no background music.");
  }
  if (!sfx && sfxTodo.some((s) => s.sfxStatus !== "unavailable")) {
    for (const s of sfxTodo) await ctx.db.update(shots).set({ sfxStatus: "unavailable" }).where(eq(shots.id, s.id));
    await ctx.event("warn", "GENERATING_AUDIO", "Sound-effects provider is not configured. The film will have no generated SFX.");
  }

  type Unit = { kind: "music"; id: string } | { kind: "sfx"; id: string };
  const units: Unit[] = [
    ...(music ? musicTodo.map((s): Unit => ({ kind: "music", id: s.id })) : []),
    ...(sfx ? sfxTodo.map((s): Unit => ({ kind: "sfx", id: s.id })) : []),
  ];
  const total = units.length;
  let completed = 0;
  let failed = 0;
  const report = () => tracker.progress({ completed, total, failed, message: "Composing music and sound effects" });
  await report();

  await mapLimit(units, ctx.env.AUDIO_CONCURRENCY, async (u) => {
    await ctx.checkpoint();
    try {
      if (u.kind === "music") {
        const scene = sceneRows.find((s) => s.id === u.id)!;
        const dur = scene.timelineDurationSec ?? scene.estimatedDurationSec;
        const prompt = musicPrompt(scene.musicMood, scene.emotion, ctx.settings.musicStyle);
        const out = await runSyncCall({
          ctx,
          stage: "GENERATING_AUDIO",
          capability: "music",
          entity: { type: "scene_music", id: scene.id },
          requestSummary: { prompt, durationSec: dur },
          slot: { primary: music!, fallback: null },
          call: (p) => p.generate({ prompt, durationSec: dur, instrumental: true }),
        });
        const { asset, localPath } = await saveMediaAsset(ctx, out.result, {
          kind: "music",
          folder: "audio",
          name: `music-${scene.id}`,
          provider: out.provider.info.id,
          providerModel: out.provider.info.model,
          providerJobId: out.providerJobId,
        });
        const qc = await qcAudioFile(localPath, Math.min(3, dur) * 0.9);
        await ctx.db.insert(qualityChecks).values(qc.map((r) => ({ projectId: ctx.projectId, targetType: "music" as const, targetId: scene.id, check: r.check, passed: r.passed, severity: r.severity, details: r.details ?? null })));
        if (qc.some((r) => !r.passed)) throw new Error("Music cue failed QC");
        await ctx.db.update(scenes).set({ musicStatus: "completed", musicAssetId: asset.id, musicError: null }).where(eq(scenes.id, scene.id));
      } else {
        const shot = shotRows.find((s) => s.id === u.id)!;
        const prompt = sfxPromptFor(shot.audioRequirements as AudioReq);
        if (!prompt) {
          await ctx.db.update(shots).set({ sfxStatus: "skipped" }).where(eq(shots.id, shot.id));
        } else {
          const dur = Math.min(sfx!.maxDurationSec, Math.max(sfx!.minDurationSec, shot.timelineDurationSec ?? shot.plannedDurationSec));
          const out = await runSyncCall({
            ctx,
            stage: "GENERATING_AUDIO",
            capability: "sfx",
            entity: { type: "shot_sfx", id: shot.id },
            requestSummary: { prompt: prompt.slice(0, 500), durationSec: dur },
            slot: { primary: sfx!, fallback: null },
            call: (p) => p.generate({ prompt, durationSec: dur }),
          });
          const { asset, localPath } = await saveMediaAsset(ctx, out.result, {
            kind: "sfx",
            folder: "audio",
            name: `sfx-${shot.id}`,
            provider: out.provider.info.id,
            providerModel: out.provider.info.model,
            providerJobId: out.providerJobId,
          });
          const qc = await qcAudioFile(localPath, 0.3);
          if (qc.some((r) => !r.passed)) throw new Error("SFX failed QC");
          await ctx.db.update(shots).set({ sfxStatus: "completed", sfxAssetId: asset.id }).where(eq(shots.id, shot.id));
        }
      }
      completed++;
    } catch (err) {
      if (isInterrupt(err)) throw err;
      failed++;
      const msg = (err as Error).message.slice(0, 2000);
      if (u.kind === "music") await ctx.db.update(scenes).set({ musicStatus: "failed", musicError: msg }).where(eq(scenes.id, u.id));
      else await ctx.db.update(shots).set({ sfxStatus: "failed", error: `SFX: ${msg}` }).where(eq(shots.id, u.id));
      await ctx.event("error", "GENERATING_AUDIO", `${u.kind} generation failed: ${msg}`, { id: u.id });
    }
    await report();
  });
  if (failed) throw new StageFailedError("GENERATING_AUDIO", `${failed} music/SFX item(s) failed. Resume to retry only those.`);
  await tracker.complete();
}
