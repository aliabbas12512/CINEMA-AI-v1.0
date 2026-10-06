import { and, asc, eq, inArray } from "drizzle-orm";
import { characters, dialogueLines, qualityChecks, scenes, shots, voices, type DialogueLine } from "@/server/db/schema";
import { probe } from "@/server/media/probe";
import { qcAudioFile } from "@/server/media/qc";
import { scheduleScene } from "@/server/media/timeline";
import { ProviderError, ProviderNotConfiguredError } from "@/server/providers/errors";
import type { SpeakerProfile, VoiceIdentity, VoiceProvider } from "@/server/providers/types";
import { saveMediaAsset } from "../assets";
import type { PipelineContext } from "../context";
import { StageFailedError } from "../context";
import { runSyncCall } from "../provider-runner";
import { mapLimit } from "../retry";
import { StageTracker, tally } from "../stage";

type VoiceProfileJson = { gender?: string; age_group?: string };

/** Assign (once) and load a consistent voice identity for every speaker. */
async function ensureVoices(ctx: PipelineContext, provider: VoiceProvider, speakerKeys: string[]): Promise<Map<string, VoiceIdentity>> {
  const existing = await ctx.db.select().from(voices).where(eq(voices.projectId, ctx.projectId));
  const map = new Map<string, VoiceIdentity>();
  for (const v of existing) {
    if (v.provider === provider.info.id) map.set(v.speakerKey.split("@")[0]!, { providerVoiceId: v.providerVoiceId, settings: v.settings as Record<string, unknown> });
  }
  const chars = await ctx.db.select().from(characters).where(eq(characters.projectId, ctx.projectId));
  const genderCounters: Record<string, number> = {};
  // Deterministic order so re-runs assign identical voices.
  for (const key of [...new Set(speakerKeys)].sort()) {
    if (map.has(key)) continue;
    let profile: SpeakerProfile;
    let characterId: string | null = null;
    if (key === "narrator") {
      profile = { speakerKey: key, role: "narrator", gender: ctx.settings.narratorVoice, ageGroup: "adult" };
    } else {
      const c = chars.find((x) => x.key === key);
      const vp = (c?.voiceProfile ?? {}) as VoiceProfileJson;
      characterId = c?.id ?? null;
      const gender = vp.gender === "female" ? "female" : vp.gender === "neutral" ? "neutral" : "male";
      const ageGroup = (["child", "young_adult", "adult", "elder"] as const).find((a) => a === vp.age_group) ?? "adult";
      profile = { speakerKey: key, role: "character", gender, ageGroup };
    }
    const idx = genderCounters[profile.gender] ?? 0;
    if (profile.role === "character") genderCounters[profile.gender] = idx + 1;
    const identity = provider.assignVoice(profile, idx);
    await ctx.db
      .insert(voices)
      .values({
        projectId: ctx.projectId,
        // One identity per (speaker, provider): stable across runs and provider fallback.
        speakerKey: `${key}@${provider.info.id}`,
        characterId,
        provider: provider.info.id,
        providerVoiceId: identity.providerVoiceId,
        settings: identity.settings,
      })
      .onConflictDoNothing();
    map.set(key, identity);
  }
  return map;
}

/** GENERATING_VOICE: real Urdu audio for every approved line, then timeline scheduling. */
export async function voiceStage(ctx: PipelineContext): Promise<void> {
  const lines = await ctx.db
    .select()
    .from(dialogueLines)
    .where(eq(dialogueLines.projectId, ctx.projectId))
    .orderBy(asc(dialogueLines.sceneId), asc(dialogueLines.sequence));
  const pending = lines.filter((l) => l.voiceStatus !== "completed");
  if (pending.length === 0 && (await schedulesComplete(ctx))) return;

  const tracker = await StageTracker.start(ctx, "GENERATING_VOICE");
  if (pending.length > 0) {
    const primary = ctx.providers.voice.primary;
    if (!primary) throw new ProviderNotConfiguredError("Voice");
    if (lines.some((l) => !l.approved)) throw new StageFailedError("GENERATING_VOICE", "Some dialogue lines are not approved.");

    const speakerKeys = lines.map((l) => l.speakerKey);
    const voiceMaps = new Map<VoiceProvider, Map<string, VoiceIdentity>>();
    voiceMaps.set(primary, await ensureVoices(ctx, primary, speakerKeys));
    const fb = ctx.providers.voice.fallback;
    if (fb) voiceMaps.set(fb, await ensureVoices(ctx, fb, speakerKeys));

    const byScene = new Map<string, DialogueLine[]>();
    for (const l of lines) byScene.set(l.sceneId, [...(byScene.get(l.sceneId) ?? []), l]);

    const counts = tally(lines, (l) => l.voiceStatus);
    await tracker.progress({ ...counts, message: "Generating Urdu narration and dialogue" });
    let completed = counts.completed;
    let failed = 0;

    await mapLimit(pending, ctx.env.VOICE_CONCURRENCY, async (line) => {
      await ctx.checkpoint();
      await ctx.db.update(dialogueLines).set({ voiceStatus: "running", voiceError: null }).where(eq(dialogueLines.id, line.id));
      const sceneLines = byScene.get(line.sceneId) ?? [];
      const idx = sceneLines.findIndex((l) => l.id === line.id);
      try {
        const out = await runSyncCall({
          ctx,
          stage: "GENERATING_VOICE",
          capability: "voice",
          entity: { type: "dialogue_line", id: line.id },
          requestSummary: { speaker: line.speakerKey, chars: line.urduText.length, locale: ctx.settings.voiceAccent },
          slot: ctx.providers.voice,
          call: async (p) => {
            const identity = voiceMaps.get(p)?.get(line.speakerKey);
            if (!identity) throw new ProviderError({ provider: p.info.id, message: `No voice assigned for ${line.speakerKey}`, retryable: false });
            return p.generate({
              text: line.urduText,
              locale: ctx.settings.voiceAccent,
              voice: identity,
              emotion: line.emotion,
              previousText: sceneLines[idx - 1]?.urduText,
              nextText: sceneLines[idx + 1]?.urduText,
            });
          },
        });
        const { asset, localPath } = await saveMediaAsset(ctx, out.result, {
          kind: "voice_line",
          folder: "audio",
          name: `line-${line.id}`,
          provider: out.provider.info.id,
          providerModel: out.provider.info.model,
          providerJobId: out.providerJobId,
        });
        const qc = await qcAudioFile(localPath, 0.2);
        await ctx.db.insert(qualityChecks).values(
          qc.map((r) => ({ projectId: ctx.projectId, targetType: "line" as const, targetId: line.id, check: r.check, passed: r.passed, severity: r.severity, details: r.details ?? null })),
        );
        if (qc.some((r) => !r.passed)) throw new ProviderError({ provider: out.provider.info.id, message: "Generated audio failed QC", retryable: false });
        const info = await probe(localPath);
        await ctx.db
          .update(dialogueLines)
          .set({ voiceStatus: "completed", audioAssetId: asset.id, audioDurationSec: info.durationSec, voiceProvider: out.provider.info.id })
          .where(eq(dialogueLines.id, line.id));
        if (out.isFallback) {
          await ctx.event("warn", "GENERATING_VOICE", `Line ${line.id} was voiced by fallback provider ${out.provider.info.id}; voice timbre may differ.`);
        }
        completed++;
      } catch (err) {
        if ((err as Error).name === "PipelineCancelledError" || (err as Error).name === "PipelinePausedError") {
          await ctx.db.update(dialogueLines).set({ voiceStatus: "pending" }).where(eq(dialogueLines.id, line.id));
          throw err;
        }
        failed++;
        await ctx.db
          .update(dialogueLines)
          .set({ voiceStatus: "failed", voiceError: (err as Error).message.slice(0, 2000) })
          .where(eq(dialogueLines.id, line.id));
        await ctx.event("error", "GENERATING_VOICE", `Voice generation failed for a line: ${(err as Error).message}`, { line_id: line.id });
      }
      await tracker.progress({ completed, total: lines.length, failed, message: "Generating Urdu narration and dialogue" });
    });
    if (failed > 0) throw new StageFailedError("GENERATING_VOICE", `${failed} voice line(s) failed. Use "Resume" to retry only the failed lines.`);
  }

  await computeSchedules(ctx);
  await tracker.complete();
}

async function schedulesComplete(ctx: PipelineContext): Promise<boolean> {
  const rows = await ctx.db.select({ d: scenes.timelineDurationSec }).from(scenes).where(eq(scenes.projectId, ctx.projectId));
  return rows.length > 0 && rows.every((r) => r.d !== null);
}

/**
 * Derive line offsets, scene durations and per-shot timeline/generation
 * durations from REAL audio durations. Deterministic; safe to re-run.
 */
export async function computeSchedules(ctx: PipelineContext): Promise<void> {
  const durations = ctx.providers.video.primary?.capabilities.durations ?? [4, 5, 6, 7, 8, 9, 10];
  const sceneRows = await ctx.db.select().from(scenes).where(eq(scenes.projectId, ctx.projectId)).orderBy(asc(scenes.sequence));
  for (const scene of sceneRows) {
    const lines = await ctx.db.select().from(dialogueLines).where(eq(dialogueLines.sceneId, scene.id)).orderBy(asc(dialogueLines.sequence));
    if (lines.some((l) => l.audioDurationSec === null)) throw new StageFailedError("GENERATING_VOICE", "Cannot schedule scenes before all voice lines exist.");
    const sceneShots = await ctx.db.select().from(shots).where(eq(shots.sceneId, scene.id)).orderBy(asc(shots.sequence));
    const sched = scheduleScene({
      lines: lines.map((l) => ({ id: l.id, durationSec: l.audioDurationSec ?? 0 })),
      shots: sceneShots.map((s) => ({ id: s.id, plannedDurationSec: s.plannedDurationSec })),
      supportedDurations: durations,
    });
    await ctx.db.transaction(async (tx) => {
      for (const l of sched.lines) await tx.update(dialogueLines).set({ startOffsetSec: l.startOffsetSec }).where(eq(dialogueLines.id, l.id));
      for (const s of sched.shots) {
        await tx
          .update(shots)
          .set({ timelineDurationSec: s.timelineDurationSec, generationDurationSec: s.generationDurationSec })
          .where(eq(shots.id, s.id));
      }
      await tx.update(scenes).set({ timelineDurationSec: sched.durationSec }).where(eq(scenes.id, scene.id));
    });
    for (const w of sched.warnings) await ctx.event("warn", "GENERATING_VOICE", `Scene ${scene.sequence}: ${w}`, { scene_id: scene.id });
  }
}

export async function linesWithAudio(ctx: PipelineContext, ids: string[]) {
  if (ids.length === 0) return [];
  return ctx.db.select().from(dialogueLines).where(and(eq(dialogueLines.projectId, ctx.projectId), inArray(dialogueLines.id, ids)));
}
