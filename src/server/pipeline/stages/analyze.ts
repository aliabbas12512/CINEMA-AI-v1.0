import { and, eq } from "drizzle-orm";
import { characters, locations, providerJobs, scripts, worldBibles } from "@/server/db/schema";
import { validateStoryBible, StoryBibleLlmSchema, type StoryBible } from "@/server/domain/schemas";
import { ProviderNotConfiguredError, toProviderError } from "@/server/providers/errors";
import type { PipelineContext } from "../context";
import { StageFailedError } from "../context";
import { analysisPrompt, ANALYSIS_SYSTEM, styleGuide } from "../prompts";
import { withRetry } from "../retry";
import { StageTracker } from "../stage";

export async function currentScript(ctx: PipelineContext) {
  const [s] = await ctx.db
    .select()
    .from(scripts)
    .where(and(eq(scripts.projectId, ctx.projectId), eq(scripts.isCurrent, true)));
  if (!s) throw new StageFailedError("ANALYZING", "Project has no script.");
  return s;
}

/** Shared LLM call wrapper: records provider_jobs with token usage and cost. */
export async function llmCall<T>(
  ctx: PipelineContext,
  stage: "ANALYZING" | "PLANNING",
  entity: { type: string; id: string },
  run: () => Promise<{ data: T; usage: { inputTokens: number; outputTokens: number }; cost?: { amount: number; unit: string } }>,
): Promise<T> {
  const llm = ctx.providers.llm;
  if (!llm) throw new ProviderNotConfiguredError("Script analysis (LLM)");
  return withRetry(
    async (attempt) => {
      await ctx.checkpoint();
      const [job] = await ctx.db
        .insert(providerJobs)
        .values({
          projectId: ctx.projectId,
          generationJobId: (await ctx.stageJobId(stage)) ?? null,
          entityType: entity.type,
          entityId: entity.id,
          capability: "llm",
          provider: llm.info.id,
          model: llm.info.model,
          attempt,
          status: "running",
        })
        .returning();
      const started = Date.now();
      try {
        const out = await run();
        await ctx.db
          .update(providerJobs)
          .set({
            status: "succeeded",
            usage: out.usage,
            costActual: out.cost?.amount ?? null,
            costUnit: out.cost?.unit ?? null,
            completedAt: new Date(),
            durationMs: Date.now() - started,
          })
          .where(eq(providerJobs.id, job!.id));
        return out.data;
      } catch (err) {
        const pe = toProviderError(llm.info.id, err);
        await ctx.db
          .update(providerJobs)
          .set({ status: "failed", error: pe.message.slice(0, 2000), errorCode: pe.code ?? null, completedAt: new Date(), durationMs: Date.now() - started })
          .where(eq(providerJobs.id, job!.id));
        throw pe;
      }
    },
    {
      maxRetries: ctx.env.MAX_RETRIES,
      baseDelayMs: ctx.env.RETRY_BASE_DELAY_MS,
      onRetry: ({ attempt, error }) =>
        ctx.event("warn", stage, `Retrying language model call (attempt ${attempt + 1})`, { error: (error as Error).message }),
    },
  );
}

/** ANALYZING: script -> validated Story Bible, Character Bible, World Bible. */
export async function analyzeStage(ctx: PipelineContext): Promise<void> {
  const [existing] = await ctx.db.select({ id: worldBibles.id }).from(worldBibles).where(eq(worldBibles.projectId, ctx.projectId));
  if (existing) return; // already done in a previous run - resume skips it

  const tracker = await StageTracker.start(ctx, "ANALYZING");
  const script = await currentScript(ctx);
  await tracker.progress({ completed: 0, total: 1, message: "Analyzing script" });

  const llm = ctx.providers.llm;
  if (!llm) throw new ProviderNotConfiguredError("Script analysis (LLM)");
  const bible: StoryBible = await llmCall(ctx, "ANALYZING", { type: "script", id: script.id }, async () => {
    const out = await llm.generateStructured({
      schema: StoryBibleLlmSchema,
      system: ANALYSIS_SYSTEM,
      prompt: analysisPrompt(script.content, ctx.settings),
      maxTokens: 32000,
      effort: "high",
    });
    return { ...out, data: validateStoryBible(out.data) };
  });

  await ctx.db.transaction(async (tx) => {
    await tx.update(scripts).set({ languageDetected: bible.source_language }).where(eq(scripts.id, script.id));
    for (const c of bible.characters) {
      await tx
        .insert(characters)
        .values({
          projectId: ctx.projectId,
          key: c.character_id,
          name: c.name,
          role: c.role,
          age: c.age,
          gender: c.gender,
          appearance: c.appearance,
          face: c.face_description,
          hair: c.hair,
          eyes: c.eyes,
          skinTone: c.skin_tone,
          bodyType: c.body_type,
          clothing: c.clothing,
          accessories: c.accessories,
          weapons: c.weapons,
          personality: c.personality,
          voiceProfile: c.voice_profile,
          visualPrompt: c.visual_reference_prompt,
        })
        .onConflictDoNothing();
    }
    for (const l of bible.locations) {
      await tx
        .insert(locations)
        .values({
          projectId: ctx.projectId,
          key: l.location_id,
          name: l.name,
          type: l.type,
          description: l.description,
          architecture: l.architecture,
          climate: l.climate,
          visualPrompt: l.visual_reference_prompt,
        })
        .onConflictDoNothing();
    }
    await tx.insert(worldBibles).values({
      projectId: ctx.projectId,
      scriptId: script.id,
      story: {
        title: bible.title,
        genre: bible.genre,
        logline: bible.logline,
        plot_summary: bible.plot_summary,
        themes: bible.themes,
        timeline: bible.timeline,
        important_objects: bible.important_objects,
        creatures: bible.creatures,
        important_visual_events: bible.important_visual_events,
        source_language: bible.source_language,
      },
      world: bible.world,
      styleGuide: styleGuide(ctx.settings.visualStyle),
    });
  });

  await tracker.progress({ completed: 1, total: 1 });
  await tracker.complete(`${bible.characters.length} characters, ${bible.locations.length} locations`);
}

/** Rebuild the StoryBible view from persisted rows (used by later stages). */
export async function loadBible(ctx: PipelineContext): Promise<StoryBible> {
  const [wb] = await ctx.db.select().from(worldBibles).where(eq(worldBibles.projectId, ctx.projectId));
  if (!wb) throw new StageFailedError("PLANNING", "Story Bible missing; analysis must run first.");
  const chars = await ctx.db.select().from(characters).where(eq(characters.projectId, ctx.projectId));
  const locs = await ctx.db.select().from(locations).where(eq(locations.projectId, ctx.projectId));
  const story = wb.story as Omit<StoryBible, "characters" | "locations" | "world">;
  return {
    ...story,
    world: wb.world as StoryBible["world"],
    characters: chars.map((c) => ({
      character_id: c.key,
      name: c.name,
      role: c.role,
      age: c.age,
      gender: c.gender,
      appearance: c.appearance,
      face_description: c.face,
      hair: c.hair,
      eyes: c.eyes,
      skin_tone: c.skinTone,
      body_type: c.bodyType,
      clothing: c.clothing,
      accessories: c.accessories,
      weapons: c.weapons,
      personality: c.personality,
      voice_profile: c.voiceProfile as StoryBible["characters"][number]["voice_profile"],
      visual_reference_prompt: c.visualPrompt,
    })),
    locations: locs.map((l) => ({
      location_id: l.key,
      name: l.name,
      type: l.type,
      description: l.description,
      architecture: l.architecture,
      climate: l.climate,
      visual_reference_prompt: l.visualPrompt,
    })),
  };
}
