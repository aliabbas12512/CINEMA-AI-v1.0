import { asc, eq } from "drizzle-orm";
import { characters, dialogueLines, locations, scenes, shots, worldBibles } from "@/server/db/schema";
import {
  SceneOutlineLlmSchema,
  ShotListLlmSchema,
  validateSceneOutline,
  validateShotList,
  type SceneOutline,
} from "@/server/domain/schemas";
import { ProviderNotConfiguredError } from "@/server/providers/errors";
import type { PipelineContext } from "../context";
import { StageFailedError } from "../context";
import { outlinePrompt, OUTLINE_SYSTEM, shotsPrompt, shotsSystem } from "../prompts";
import { mapLimit } from "../retry";
import { StageTracker } from "../stage";
import { currentScript, llmCall, loadBible } from "./analyze";

export function shotDurationBounds(ctx: PipelineContext): { min: number; max: number } {
  const caps = ctx.providers.video.primary?.capabilities;
  if (!caps) return { min: 5, max: 10 };
  const max = Math.min(12, Math.max(...caps.durations));
  const min = Math.max(Math.min(...caps.durations), Math.min(5, max));
  return { min, max };
}

/** PLANNING: scene outline with final dialogue, then a shot list per scene. */
export async function planStage(ctx: PipelineContext): Promise<void> {
  const existing = await ctx.db.select().from(scenes).where(eq(scenes.projectId, ctx.projectId)).orderBy(asc(scenes.sequence));
  if (existing.length > 0 && existing.every((s) => s.shotPlanStatus === "completed")) return;

  const llm = ctx.providers.llm;
  if (!llm) throw new ProviderNotConfiguredError("Script analysis (LLM)");
  const tracker = await StageTracker.start(ctx, "PLANNING");
  const bible = await loadBible(ctx);
  const script = await currentScript(ctx);
  const [wb] = await ctx.db.select().from(worldBibles).where(eq(worldBibles.projectId, ctx.projectId));

  const charRows = await ctx.db.select().from(characters).where(eq(characters.projectId, ctx.projectId));
  const locRows = await ctx.db.select().from(locations).where(eq(locations.projectId, ctx.projectId));
  const charByKey = new Map(charRows.map((c) => [c.key, c]));
  const locByKey = new Map(locRows.map((l) => [l.key, l]));

  // 1) Scene outline + final approved lines (only once).
  if (existing.length === 0) {
    await tracker.progress({ completed: 0, total: 1, message: "Planning scenes and dialogue" });
    const outline: SceneOutline = await llmCall(ctx, "PLANNING", { type: "script", id: script.id }, async () => {
      const out = await llm.generateStructured({
        schema: SceneOutlineLlmSchema,
        system: OUTLINE_SYSTEM,
        prompt: outlinePrompt(script.content, bible, ctx.settings),
        maxTokens: 64000,
        effort: "high",
      });
      return {
        ...out,
        data: validateSceneOutline(out.data, { characterIds: new Set(charByKey.keys()), locationIds: new Set(locByKey.keys()) }),
      };
    });
    await ctx.db.transaction(async (tx) => {
      for (const [i, s] of outline.scenes.entries()) {
        const [row] = await tx
          .insert(scenes)
          .values({
            projectId: ctx.projectId,
            sequence: i + 1,
            key: s.scene_id,
            title: s.title,
            storyPurpose: s.story_purpose,
            locationId: locByKey.get(s.location_id)?.id ?? null,
            timeOfDay: s.time_of_day,
            environment: s.environment,
            action: s.action,
            emotion: s.emotion,
            musicMood: s.music_mood,
            characterKeys: s.characters,
            estimatedDurationSec: s.estimated_duration_sec,
          })
          .returning({ id: scenes.id });
        for (const [j, l] of s.lines.entries()) {
          await tx.insert(dialogueLines).values({
            projectId: ctx.projectId,
            sceneId: row!.id,
            sequence: j + 1,
            kind: l.kind,
            speakerKey: l.speaker,
            characterId: l.kind === "dialogue" ? (charByKey.get(l.speaker)?.id ?? null) : null,
            originalText: l.original_text,
            urduText: l.urdu_text.trim(),
            englishText: l.english_text.trim(),
            emotion: l.emotion,
            // Final dialogue is stored and approved before any voice generation.
            approved: true,
          });
        }
      }
    });
    await ctx.event("info", "PLANNING", `Planned ${outline.scenes.length} scenes`);
  }

  // 2) Shot list per scene (resumable per scene).
  const allScenes = await ctx.db.select().from(scenes).where(eq(scenes.projectId, ctx.projectId)).orderBy(asc(scenes.sequence));
  const bounds = shotDurationBounds(ctx);
  const style = wb?.styleGuide ?? "";
  let done = allScenes.filter((s) => s.shotPlanStatus === "completed").length;
  const failures: string[] = [];
  await tracker.progress({ completed: done, total: allScenes.length, message: "Planning shots" });

  await mapLimit(
    allScenes.filter((s) => s.shotPlanStatus !== "completed"),
    3,
    async (scene) => {
      await ctx.checkpoint();
      const lines = await ctx.db.select().from(dialogueLines).where(eq(dialogueLines.sceneId, scene.id)).orderBy(asc(dialogueLines.sequence));
      const loc = locRows.find((l) => l.id === scene.locationId);
      const sceneForPrompt: SceneOutline["scenes"][number] = {
        scene_id: scene.key,
        title: scene.title,
        story_purpose: scene.storyPurpose,
        location_id: loc?.key ?? "",
        time_of_day: scene.timeOfDay,
        characters: scene.characterKeys,
        environment: scene.environment,
        action: scene.action,
        emotion: scene.emotion,
        music_mood: scene.musicMood as SceneOutline["scenes"][number]["music_mood"],
        estimated_duration_sec: scene.estimatedDurationSec,
        lines: lines.map((l) => ({
          kind: l.kind,
          speaker: l.speakerKey,
          original_text: l.originalText,
          urdu_text: l.urduText,
          english_text: l.englishText,
          emotion: l.emotion,
        })),
      };
      try {
        const list = await llmCall(ctx, "PLANNING", { type: "scene", id: scene.id }, async () => {
          const out = await llm.generateStructured({
            schema: ShotListLlmSchema,
            system: shotsSystem(bounds.min, bounds.max),
            prompt: shotsPrompt({ scene: sceneForPrompt, bible, style }),
            maxTokens: 24000,
            effort: "medium",
          });
          return {
            ...out,
            data: validateShotList(out.data, {
              characterIds: new Set(charByKey.keys()),
              lineCount: lines.length,
              minShotSec: bounds.min,
              maxShotSec: bounds.max,
            }),
          };
        });
        await ctx.db.transaction(async (tx) => {
          await tx.delete(shots).where(eq(shots.sceneId, scene.id));
          for (const [i, s] of list.shots.entries()) {
            const speaking = s.speaking_line_index >= 0 ? lines[s.speaking_line_index] : undefined;
            await tx.insert(shots).values({
              projectId: ctx.projectId,
              sceneId: scene.id,
              sequence: i + 1,
              key: s.shot_id,
              plannedDurationSec: s.duration_sec,
              prompt: `${s.keyframe_prompt}\n---\n${s.motion_prompt}`,
              negativePrompt: s.negative_prompt,
              characterKeys: s.characters,
              locationKey: loc?.key ?? null,
              camera: `${s.camera}; ${s.camera_movement}`,
              lighting: s.lighting,
              action: s.action,
              emotion: s.emotion,
              visualEffects: s.visual_effects,
              transition: s.transition_in,
              audioRequirements: { sfx: s.sfx, ambience: s.ambience },
              speakingLineId: speaking && speaking.kind === "dialogue" ? speaking.id : null,
              lipsyncStatus: speaking && speaking.kind === "dialogue" ? "pending" : "skipped",
            });
          }
          await tx.update(scenes).set({ shotPlanStatus: "completed", shotPlanError: null }).where(eq(scenes.id, scene.id));
        });
        done++;
      } catch (err) {
        const msg = (err as Error).message;
        if ((err as Error).name === "PipelineCancelledError" || (err as Error).name === "PipelinePausedError") throw err;
        failures.push(`Scene ${scene.sequence}: ${msg}`);
        await ctx.db.update(scenes).set({ shotPlanStatus: "failed", shotPlanError: msg.slice(0, 2000) }).where(eq(scenes.id, scene.id));
      }
      await tracker.progress({ completed: done, total: allScenes.length, failed: failures.length, message: "Planning shots" });
    },
  );

  if (failures.length) throw new StageFailedError("PLANNING", `Shot planning failed for ${failures.length} scene(s). ${failures[0]}`);
  await tracker.complete(`${allScenes.length} scenes planned`);
}

/** Splits the stored "keyframe --- motion" prompt. */
export function splitShotPrompt(prompt: string): { keyframe: string; motion: string } {
  const [keyframe, motion] = prompt.split("\n---\n");
  return { keyframe: (keyframe ?? prompt).trim(), motion: (motion ?? keyframe ?? prompt).trim() };
}
