import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { outputDimensions } from "@/lib/settings";
import {
  audioTracks,
  dialogueLines,
  projects,
  qualityChecks,
  renderJobs,
  scenes,
  shots,
  subtitles,
} from "@/server/db/schema";
import { concatAudio, cutAudio, mixFinal, musicBed, placeClips, silence } from "@/server/media/audio";
import { probe } from "@/server/media/probe";
import { blocking, qcFinal } from "@/server/media/qc";
import { buildCues, toSrt, toVtt, validateCues, type TimedText } from "@/server/media/subtitles";
import { concatVideos, mux, normalizeClip, scenePreview, thumbnail } from "@/server/media/video";
import { assetToFile, saveFileAsset } from "../assets";
import type { PipelineContext } from "../context";
import { StageFailedError } from "../context";
import { StageTracker } from "../stage";
import { computeSchedules } from "./voice";

const SCENE_FADE_SEC = 0.5;
const TRANSITION_FADE_SEC = 0.3;

type Timeline = {
  durationSec: number;
  scenes: Array<{ id: string; sequence: number; startSec: number; durationSec: number; startFrame: number; endFrame: number }>;
};

/** ASSEMBLING: deterministic FFmpeg render from persisted assets. */
export async function assembleStage(ctx: PipelineContext): Promise<{ renderJobId: string; finalPath: string; timeline: Timeline }> {
  const tracker = await StageTracker.start(ctx, "ASSEMBLING");
  const started = Date.now();
  const [render] = await ctx.db
    .insert(renderJobs)
    .values({ projectId: ctx.projectId, status: "RUNNING", settings: ctx.settings })
    .returning();
  const dir = path.join(ctx.workDir, `render-${render!.id}`);
  await mkdir(dir, { recursive: true });
  const { width, height } = outputDimensions(ctx.settings);
  const fps = ctx.settings.fps;

  try {
    await computeSchedules(ctx);
    const sceneRows = await ctx.db.select().from(scenes).where(eq(scenes.projectId, ctx.projectId)).orderBy(asc(scenes.sequence));
    const shotRows = await ctx.db.select().from(shots).where(eq(shots.projectId, ctx.projectId)).orderBy(asc(shots.sequence));
    const lineRows = await ctx.db.select().from(dialogueLines).where(eq(dialogueLines.projectId, ctx.projectId)).orderBy(asc(dialogueLines.sequence));

    // Missing component checks - never assemble around holes.
    const missingShots = shotRows.filter((s) => s.videoStatus !== "completed" || !s.videoAssetId);
    if (missingShots.length) throw new StageFailedError("ASSEMBLING", `${missingShots.length} shot(s) have no generated video.`);
    const missingLines = lineRows.filter((l) => l.voiceStatus !== "completed" || !l.audioAssetId);
    if (missingLines.length) throw new StageFailedError("ASSEMBLING", `${missingLines.length} voice line(s) are missing audio.`);
    const emptyScenes = sceneRows.filter((sc) => !shotRows.some((s) => s.sceneId === sc.id));
    if (emptyScenes.length) throw new StageFailedError("ASSEMBLING", `${emptyScenes.length} scene(s) have no shots.`);

    // Global frame-accurate timeline.
    const timeline: Timeline = { durationSec: 0, scenes: [] };
    let cursorFrames = 0;
    const shotFrames = new Map<string, { frames: number; startSec: number }>();
    for (const sc of sceneRows) {
      const sceneShots = shotRows.filter((s) => s.sceneId === sc.id);
      const sceneStartFrame = cursorFrames;
      let acc = 0;
      for (const s of sceneShots) {
        const start = Math.round(((sceneStartFrame / fps) + acc) * fps);
        acc += s.timelineDurationSec ?? s.plannedDurationSec;
        const end = Math.round(((sceneStartFrame / fps) + acc) * fps);
        shotFrames.set(s.id, { frames: Math.max(1, end - start), startSec: start / fps });
      }
      const sceneEndFrame = Math.round((sceneStartFrame / fps + acc) * fps);
      timeline.scenes.push({
        id: sc.id,
        sequence: sc.sequence,
        startSec: sceneStartFrame / fps,
        durationSec: (sceneEndFrame - sceneStartFrame) / fps,
        startFrame: sceneStartFrame,
        endFrame: sceneEndFrame,
      });
      cursorFrames = sceneEndFrame;
    }
    timeline.durationSec = cursorFrames / fps;
    const totalUnits = shotRows.length + sceneRows.length * 3 + 4;
    let doneUnits = 0;
    const step = async (msg: string) => {
      doneUnits++;
      await tracker.progress({ completed: doneUnits, total: totalUnits, message: msg });
      await ctx.checkpoint();
    };

    // ---- picture
    const normalized: string[] = [];
    const sceneClips = new Map<string, string[]>();
    for (const sc of sceneRows) {
      const sceneShots = shotRows.filter((s) => s.sceneId === sc.id);
      sceneClips.set(sc.id, []);
      for (const [i, s] of sceneShots.entries()) {
        const useLipsync = s.lipsyncStatus === "completed" && s.lipsyncAssetId;
        const src = await assetToFile(ctx, (useLipsync ? s.lipsyncAssetId : s.videoAssetId)!);
        const info = await probe(src);
        const next = sceneShots[i + 1];
        const out = path.join(dir, `shot-${String(normalized.length).padStart(4, "0")}.mp4`);
        await normalizeClip({
          input: src,
          out,
          width,
          height,
          fps,
          frames: shotFrames.get(s.id)!.frames,
          sourceDurationSec: info.durationSec,
          fadeInSec: i === 0 ? SCENE_FADE_SEC : s.transition !== "cut" ? TRANSITION_FADE_SEC : 0,
          fadeOutSec: !next ? SCENE_FADE_SEC : next.transition !== "cut" ? TRANSITION_FADE_SEC : 0,
        });
        normalized.push(out);
        sceneClips.get(sc.id)!.push(out);
        await step(`Rendering shot ${normalized.length}/${shotRows.length}`);
      }
    }
    const videoPath = path.join(dir, "video.mp4");
    await concatVideos(normalized, path.join(dir, "concat.txt"), videoPath);

    // ---- sound: per scene voice, music and sfx beds
    const voiceParts: string[] = [];
    const musicParts: string[] = [];
    const sfxParts: string[] = [];
    for (const t of timeline.scenes) {
      const sc = sceneRows.find((x) => x.id === t.id)!;
      const sceneLines = lineRows.filter((l) => l.sceneId === sc.id);
      const placed = [];
      for (const l of sceneLines) placed.push({ path: await assetToFile(ctx, l.audioAssetId!), startSec: l.startOffsetSec ?? 0 });
      const v = path.join(dir, `voice-${sc.sequence}.wav`);
      await placeClips(placed, t.durationSec, v);
      voiceParts.push(v);
      await step(`Mixing voice for scene ${sc.sequence}`);

      const m = path.join(dir, `music-${sc.sequence}.wav`);
      if (sc.musicStatus === "completed" && sc.musicAssetId) await musicBed(await assetToFile(ctx, sc.musicAssetId), t.durationSec, m);
      else await silence(t.durationSec, m);
      musicParts.push(m);
      await step(`Music bed for scene ${sc.sequence}`);

      const fx = [];
      for (const s of shotRows.filter((x) => x.sceneId === sc.id)) {
        if (s.sfxStatus === "completed" && s.sfxAssetId) {
          const f = shotFrames.get(s.id)!;
          fx.push({ path: await assetToFile(ctx, s.sfxAssetId), startSec: f.startSec - t.startSec, maxDurationSec: f.frames / fps });
        }
      }
      const fxPath = path.join(dir, `sfx-${sc.sequence}.wav`);
      await placeClips(fx, t.durationSec, fxPath);
      sfxParts.push(fxPath);
      await step(`SFX bed for scene ${sc.sequence}`);
    }
    const voiceFull = path.join(dir, "voice.wav");
    const musicFull = path.join(dir, "music.wav");
    const sfxFull = path.join(dir, "sfx.wav");
    await concatAudio(voiceParts, voiceFull);
    await concatAudio(musicParts, musicFull);
    await concatAudio(sfxParts, sfxFull);
    const mixPath = path.join(dir, "mix.wav");
    const loud = await mixFinal({ voice: voiceFull, music: musicFull, sfx: sfxFull, durationSec: timeline.durationSec, out: mixPath });
    await step("Final audio mix");

    // ---- subtitles from FINAL timed lines
    const timed: Record<"ur" | "en", TimedText[]> = { ur: [], en: [] };
    for (const t of timeline.scenes) {
      for (const l of lineRows.filter((x) => x.sceneId === t.id)) {
        const start = t.startSec + (l.startOffsetSec ?? 0);
        const end = start + (l.audioDurationSec ?? 0);
        timed.ur.push({ startSec: start, endSec: end, text: l.urduText });
        timed.en.push({ startSec: start, endSec: end, text: l.englishText });
      }
    }
    const subPaths: Partial<Record<"ur" | "en", string>> = {};
    for (const lang of ["ur", "en"] as const) {
      const cues = buildCues(timed[lang]);
      const problems = validateCues(cues, timeline.durationSec);
      await ctx.db.insert(qualityChecks).values({
        projectId: ctx.projectId,
        renderJobId: render!.id,
        targetType: "subtitle",
        check: `subtitle_timing_${lang}`,
        passed: problems.length === 0,
        severity: "error",
        details: { problems: problems.slice(0, 20), cues: cues.length },
      });
      if (problems.length) throw new StageFailedError("ASSEMBLING", `Subtitle timing invalid (${lang}): ${problems[0]}`);
      for (const fmt of ["srt", "vtt"] as const) {
        const p = path.join(dir, `subtitles-${lang}.${fmt}`);
        await writeFile(p, fmt === "srt" ? toSrt(cues) : toVtt(cues), "utf8");
        if (fmt === "srt") subPaths[lang] = p;
        const asset = await saveFileAsset(ctx, p, { kind: "subtitle", folder: "subtitles", name: `subtitles-${lang}`, probeMedia: false });
        await ctx.db
          .insert(subtitles)
          .values({ projectId: ctx.projectId, language: lang, format: fmt, assetId: asset.id, cueCount: cues.length })
          .onConflictDoUpdate({ target: [subtitles.projectId, subtitles.language, subtitles.format], set: { assetId: asset.id, cueCount: cues.length } });
      }
    }
    await step("Subtitles");

    // ---- mux
    const lang = ctx.settings.subtitleLanguage;
    const finalPath = path.join(dir, "final.mp4");
    await mux({
      video: videoPath,
      audio: mixPath,
      out: finalPath,
      durationSec: timeline.durationSec,
      softSubtitle: lang !== "off" && subPaths[lang] ? { path: subPaths[lang]!, language: lang === "ur" ? "urd" : "eng" } : undefined,
      burnSubtitlePath: lang !== "off" && ctx.settings.burnSubtitles ? subPaths[lang] : undefined,
    });
    await step("Muxing final video");

    // ---- scene previews (480p) for the project page
    for (const t of timeline.scenes) {
      const pv = path.join(dir, `preview-${t.sequence}.mp4`);
      const pa = path.join(dir, `preview-${t.sequence}.wav`);
      await cutAudio(mixPath, t.startSec, t.durationSec, pa);
      const pvv = path.join(dir, `preview-${t.sequence}-v.mp4`);
      await concatVideos(sceneClips.get(t.id)!, path.join(dir, `preview-${t.sequence}.txt`), pvv);
      await scenePreview(pvv, pa, pv);
      const a = await saveFileAsset(ctx, pv, { kind: "scene_preview", folder: "scenes", name: `preview-${t.id}` });
      await ctx.db.update(scenes).set({ previewAssetId: a.id }).where(eq(scenes.id, t.id));
      await step(`Scene ${t.sequence} preview`);
    }

    await ctx.db.insert(audioTracks).values({
      projectId: ctx.projectId,
      kind: "final_mix",
      assetId: (await saveFileAsset(ctx, mixPath, { kind: "mix_audio", folder: "audio", name: `final-mix-${render!.id}` })).id,
      durationSec: timeline.durationSec,
      integratedLufs: Number.isFinite(loud.integratedLufs) ? loud.integratedLufs : null,
      truePeakDb: Number.isFinite(loud.truePeakDb) ? loud.truePeakDb : null,
    });

    await ctx.db
      .update(renderJobs)
      .set({ durationSec: timeline.durationSec, assemblyMs: Date.now() - started })
      .where(eq(renderJobs.id, render!.id));
    await tracker.complete(`Rendered ${timeline.durationSec.toFixed(1)}s in ${Math.round((Date.now() - started) / 1000)}s`);
    return { renderJobId: render!.id, finalPath, timeline };
  } catch (err) {
    await ctx.db.update(renderJobs).set({ status: "FAILED", error: (err as Error).message.slice(0, 4000), completedAt: new Date() }).where(eq(renderJobs.id, render!.id));
    throw err;
  }
}

/** QUALITY_CHECK: verify the final render; only a passing file is ever delivered. */
export async function qualityStage(ctx: PipelineContext, r: { renderJobId: string; finalPath: string; timeline: Timeline }): Promise<void> {
  const tracker = await StageTracker.start(ctx, "QUALITY_CHECK");
  const { width, height } = outputDimensions(ctx.settings);
  await tracker.progress({ completed: 0, total: 2, message: "Inspecting final video" });
  const qc = await qcFinal(r.finalPath, {
    width,
    height,
    fps: ctx.settings.fps,
    durationSec: r.timeline.durationSec,
    expectSubtitleStream: ctx.settings.subtitleLanguage !== "off",
  });
  await ctx.db.insert(qualityChecks).values(
    qc.results.map((q) => ({
      projectId: ctx.projectId,
      renderJobId: r.renderJobId,
      targetType: "final" as const,
      check: q.check,
      passed: q.passed,
      severity: q.severity,
      details: q.details ?? null,
    })),
  );
  const bad = blocking(qc.results);
  if (bad.length) {
    await ctx.db.update(renderJobs).set({ status: "FAILED", error: `QC failed: ${bad.map((b) => b.check).join(", ")}`, completedAt: new Date() }).where(eq(renderJobs.id, r.renderJobId));
    throw new StageFailedError("QUALITY_CHECK", `Final video failed quality control: ${bad.map((b) => b.check).join(", ")}. It was not delivered.`);
  }
  for (const w of qc.results.filter((q) => !q.passed)) {
    await ctx.event("warn", "QUALITY_CHECK", `QC warning: ${w.check}`, w.details);
  }
  await tracker.progress({ completed: 1, total: 2, message: "Publishing" });

  const finalAsset = await saveFileAsset(ctx, r.finalPath, { kind: "final_video", folder: "final", name: `final-${r.renderJobId}` });
  const thumbPath = path.join(path.dirname(r.finalPath), "thumbnail.jpg");
  await thumbnail(r.finalPath, Math.min(r.timeline.durationSec / 2, Math.max(1, r.timeline.durationSec * 0.1)), thumbPath);
  const thumbAsset = await saveFileAsset(ctx, thumbPath, { kind: "thumbnail", folder: "final", name: `thumbnail-${r.renderJobId}` });
  await ctx.db
    .update(renderJobs)
    .set({ status: "COMPLETED", outputAssetId: finalAsset.id, thumbnailAssetId: thumbAsset.id, completedAt: new Date() })
    .where(eq(renderJobs.id, r.renderJobId));
  await ctx.db.update(projects).set({ finalAssetId: finalAsset.id, thumbnailAssetId: thumbAsset.id }).where(eq(projects.id, ctx.projectId));
  await tracker.progress({ completed: 2, total: 2 });
  await tracker.complete("Final video passed QC");
  // Scratch render files are no longer needed once uploaded.
  await rm(path.dirname(r.finalPath), { recursive: true, force: true });
}
