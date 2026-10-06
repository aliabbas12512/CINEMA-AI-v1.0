import { and, eq, sql } from "drizzle-orm";
import { generationJobs, projects, type PipelineStage } from "@/server/db/schema";
import type { PipelineContext } from "./context";

/** Track one stage of one run in generation_jobs. Progress = real unit counts. */
export class StageTracker {
  constructor(
    private readonly ctx: PipelineContext,
    readonly stage: PipelineStage,
    private readonly jobId: string,
  ) {}

  static async start(ctx: PipelineContext, stage: PipelineStage): Promise<StageTracker> {
    const now = new Date();
    const [row] = await ctx.db
      .insert(generationJobs)
      .values({ projectId: ctx.projectId, run: ctx.run, stage, status: "RUNNING", startedAt: now, attempts: 1 })
      .onConflictDoUpdate({
        target: [generationJobs.projectId, generationJobs.run, generationJobs.stage],
        set: { status: "RUNNING", error: null, attempts: sql`${generationJobs.attempts} + 1`, startedAt: now, completedAt: null },
      })
      .returning({ id: generationJobs.id });
    await ctx.db.update(projects).set({ status: stage, currentStage: stage, error: null }).where(eq(projects.id, ctx.projectId));
    await ctx.event("info", stage, `Stage ${stage} started`);
    return new StageTracker(ctx, stage, row!.id);
  }

  async progress(p: { completed: number; total: number; failed?: number; message?: string }): Promise<void> {
    const pct = p.total > 0 ? Math.min(100, (100 * p.completed) / p.total) : 0;
    await this.ctx.db
      .update(generationJobs)
      .set({ progress: pct, completedUnits: p.completed, totalUnits: p.total, failedUnits: p.failed ?? 0, message: p.message ?? null })
      .where(eq(generationJobs.id, this.jobId));
  }

  async complete(message?: string): Promise<void> {
    await this.ctx.db
      .update(generationJobs)
      .set({ status: "COMPLETED", progress: 100, completedAt: new Date(), message: message ?? null })
      .where(eq(generationJobs.id, this.jobId));
    await this.ctx.event("info", this.stage, `Stage ${this.stage} completed${message ? `: ${message}` : ""}`);
  }

  async end(status: "FAILED" | "CANCELLED" | "PAUSED", error?: string): Promise<void> {
    await this.ctx.db
      .update(generationJobs)
      .set({ status, error: error?.slice(0, 4000) ?? null, completedAt: new Date() })
      .where(and(eq(generationJobs.id, this.jobId)));
  }
}

/** Count units by status for progress reporting. */
export function tally<T>(items: T[], statusOf: (t: T) => string) {
  let completed = 0;
  let failed = 0;
  for (const i of items) {
    const s = statusOf(i);
    if (s === "completed" || s === "skipped" || s === "unavailable") completed++;
    else if (s === "failed") failed++;
  }
  return { completed, failed, total: items.length };
}
