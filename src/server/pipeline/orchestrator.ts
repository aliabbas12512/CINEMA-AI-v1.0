import { and, eq, inArray } from "drizzle-orm";
import { ProjectSettingsSchema } from "@/lib/settings";
import { generationJobs, projects, type PipelineStage } from "@/server/db/schema";
import { ProviderNotConfiguredError } from "@/server/providers/errors";
import {
  createContext,
  PipelineCancelledError,
  PipelinePausedError,
  StageFailedError,
  type PipelineContext,
  type PipelineDeps,
} from "./context";
import { analyzeStage } from "./stages/analyze";
import { assembleStage, qualityStage } from "./stages/assemble";
import { audioStage } from "./stages/audio";
import { planStage } from "./stages/plan";
import { keyframesStage, referencesStage, videoStage } from "./stages/visuals";
import { voiceStage } from "./stages/voice";

/**
 * The pipeline is a sequence of idempotent stages. Each stage reads persisted
 * unit status and only works on what is not yet completed, so re-running the
 * pipeline IS resume: successful shots/lines/cues are never regenerated.
 *
 * Voice runs before picture so shot lengths are derived from the real Urdu
 * audio durations (frame-accurate sync) before paying for video generation.
 */
export const STAGE_ORDER: PipelineStage[] = [
  "ANALYZING",
  "PLANNING",
  "GENERATING_VOICE",
  "GENERATING_CHARACTERS",
  "GENERATING_SCENES",
  "GENERATING_VIDEO",
  "GENERATING_AUDIO",
  "ASSEMBLING",
  "QUALITY_CHECK",
];

export type PipelineOutcome = "COMPLETED" | "FAILED" | "CANCELLED" | "PAUSED";

async function markRunningStages(ctx: PipelineContext, status: "FAILED" | "CANCELLED" | "PAUSED", error?: string) {
  await ctx.db
    .update(generationJobs)
    .set({ status, error: error ?? null, completedAt: new Date() })
    .where(and(eq(generationJobs.projectId, ctx.projectId), eq(generationJobs.run, ctx.run), inArray(generationJobs.status, ["RUNNING", "QUEUED"])));
}

export async function runPipeline(deps: PipelineDeps, projectId: string): Promise<PipelineOutcome> {
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new Error(`Project ${projectId} not found`);
  if (project.status === "COMPLETED") return "COMPLETED";
  if (project.control === "cancel_requested") {
    await deps.db.update(projects).set({ status: "CANCELLED", control: "none" }).where(eq(projects.id, projectId));
    return "CANCELLED";
  }
  const settings = ProjectSettingsSchema.parse(project.settings);
  const ctx = await createContext(deps, projectId, project.runCount, settings);
  await deps.db
    .update(projects)
    .set({ startedAt: project.startedAt ?? new Date(), error: null, completedAt: null })
    .where(eq(projects.id, projectId));
  await ctx.event("info", null, `Pipeline run ${ctx.run} started`);

  try {
    await analyzeStage(ctx);
    await planStage(ctx);
    await voiceStage(ctx);
    await referencesStage(ctx);
    await keyframesStage(ctx);
    await videoStage(ctx);
    await audioStage(ctx);
    const render = await assembleStage(ctx);
    await qualityStage(ctx, render);
    await deps.db
      .update(projects)
      .set({ status: "COMPLETED", currentStage: null, control: "none", completedAt: new Date(), error: null })
      .where(eq(projects.id, projectId));
    await ctx.event("info", null, "Generation completed; final video passed quality control.");
    return "COMPLETED";
  } catch (err) {
    if (err instanceof PipelineCancelledError) {
      await markRunningStages(ctx, "CANCELLED");
      await deps.db.update(projects).set({ status: "CANCELLED", control: "none" }).where(eq(projects.id, projectId));
      await ctx.event("warn", null, "Generation cancelled by user.");
      return "CANCELLED";
    }
    if (err instanceof PipelinePausedError) {
      await markRunningStages(ctx, "PAUSED");
      await deps.db.update(projects).set({ status: "PAUSED", control: "none" }).where(eq(projects.id, projectId));
      await ctx.event("info", null, "Generation paused. Resume continues from the last completed item.");
      return "PAUSED";
    }
    const message =
      err instanceof ProviderNotConfiguredError || err instanceof StageFailedError
        ? err.message
        : `Unexpected error: ${(err as Error).message ?? String(err)}`;
    await markRunningStages(ctx, "FAILED", message);
    await deps.db.update(projects).set({ status: "FAILED", control: "none", error: message.slice(0, 4000) }).where(eq(projects.id, projectId));
    await ctx.event("error", null, message, { stack: (err as Error).stack?.split("\n").slice(0, 6).join("\n") });
    return "FAILED";
  }
}
