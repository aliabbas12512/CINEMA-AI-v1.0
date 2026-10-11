import { and, desc, eq, inArray } from "drizzle-orm";
import { providerJobs, type Capability, type PipelineStage } from "@/server/db/schema";
import { ProviderError, toProviderError } from "@/server/providers/errors";
import type {
  AsyncTaskProvider,
  CostInfo,
  GenerationResult,
  ProviderSlot,
  TaskStatus,
} from "@/server/providers/types";
import { PipelineCancelledError, PipelinePausedError, type PipelineContext } from "./context";
import { defaultSleep, RetryAbortedError, withRetry } from "./retry";

/**
 * Provider execution with persistence:
 *  - every request is recorded in provider_jobs (provider, model, cost, error)
 *  - async tasks persist their external id BEFORE polling, so an interrupted
 *    worker resumes polling the same task instead of paying for a new one
 *  - transient failures retry with exponential backoff; permanent failures
 *    try the configured fallback provider (recorded with is_fallback=true)
 */

export type Entity = { type: string; id: string };

type BaseArgs = {
  ctx: PipelineContext;
  stage: PipelineStage;
  capability: Capability;
  entity: Entity;
  /** Sanitized request summary (no media bytes, no secrets). */
  requestSummary: Record<string, unknown>;
};

type JobRow = typeof providerJobs.$inferSelect;

async function insertJob(args: BaseArgs, provider: { id: string; model: string }, isFallback: boolean, attempt: number): Promise<JobRow> {
  const [row] = await args.ctx.db
    .insert(providerJobs)
    .values({
      projectId: args.ctx.projectId,
      generationJobId: (await args.ctx.stageJobId(args.stage)) ?? null,
      entityType: args.entity.type,
      entityId: args.entity.id,
      capability: args.capability,
      provider: provider.id,
      model: provider.model,
      isFallback,
      attempt,
      status: "submitted",
      request: args.requestSummary,
    })
    .returning();
  if (!row) throw new Error("failed to insert provider job");
  return row;
}

async function finishJob(
  args: BaseArgs,
  id: string,
  startedAt: Date,
  patch: { status: "succeeded" | "failed" | "cancelled"; error?: string; errorCode?: string; cost?: CostInfo; usage?: Record<string, unknown> },
) {
  await args.ctx.db
    .update(providerJobs)
    .set({
      status: patch.status,
      error: patch.error?.slice(0, 2000) ?? null,
      errorCode: patch.errorCode ?? null,
      costActual: patch.cost?.amount ?? null,
      costUnit: patch.cost?.unit ?? null,
      usage: patch.usage ?? null,
      completedAt: new Date(),
      durationMs: Date.now() - startedAt.getTime(),
    })
    .where(eq(providerJobs.id, id));
}

function isPermanentTaskFailure(code: string | undefined): boolean {
  if (!code) return false;
  return /^(SAFETY|INPUT|MODERATION|INVALID)/i.test(code);
}

/** Run a synchronous provider call (voice, music, sfx) with retries + fallback. */
export async function runSyncCall<P extends { info: { id: string; model: string } }>(
  args: BaseArgs & {
    slot: ProviderSlot<P>;
    call: (provider: P) => Promise<GenerationResult>;
  },
): Promise<{ result: GenerationResult; provider: P; providerJobId: string; isFallback: boolean }> {
  const candidates = [args.slot.primary, args.slot.fallback].filter((p): p is P => p !== null);
  let lastErr: unknown;
  for (const [i, provider] of candidates.entries()) {
    const isFallback = i > 0;
    if (isFallback) {
      await args.ctx.event("warn", args.stage, `Using fallback ${args.capability} provider ${provider.info.id} for ${args.entity.type} ${args.entity.id}`, {
        entity: args.entity,
      });
    }
    try {
      return await withRetry(
        async (attempt) => {
          await args.ctx.checkpoint();
          const job = await insertJob(args, provider.info, isFallback, attempt);
          const started = new Date();
          try {
            const result = await args.call(provider);
            await finishJob(args, job.id, started, { status: "succeeded", cost: result.cost, usage: result.usage });
            return { result, provider, providerJobId: job.id, isFallback };
          } catch (err) {
            const pe = toProviderError(provider.info.id, err);
            await finishJob(args, job.id, started, { status: "failed", error: pe.message, errorCode: pe.code });
            throw pe;
          }
        },
        retryOpts(args),
      );
    } catch (err) {
      if (err instanceof PipelineCancelledError || err instanceof PipelinePausedError || err instanceof RetryAbortedError) throw err;
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("No provider available");
}

function retryOpts(args: BaseArgs) {
  return {
    maxRetries: args.ctx.env.MAX_RETRIES,
    baseDelayMs: args.ctx.env.RETRY_BASE_DELAY_MS,
    onRetry: async ({ attempt, delayMs, error }: { attempt: number; delayMs: number; error: unknown }) => {
      await args.ctx.event("warn", args.stage, `Retrying ${args.capability} for ${args.entity.type} (attempt ${attempt + 1}) in ${Math.round(delayMs / 1000)}s`, {
        entity: args.entity,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  };
}

/**
 * Run an async provider task (image, video, lip-sync): submit -> persist id ->
 * poll -> download -> validate. Resumes an in-flight task from a previous run.
 */
export async function runAsyncTask<Req, P extends AsyncTaskProvider<Req>>(
  args: BaseArgs & {
    slot: ProviderSlot<P>;
    buildRequest: (provider: P, attempt: number) => Promise<Req>;
    /** Validate downloaded output (QC). Throw a retryable ProviderError to regenerate. */
    validate?: (result: GenerationResult) => Promise<void>;
    onProgress?: (progress: number) => Promise<void> | void;
  },
): Promise<{ result: GenerationResult; provider: P; providerJobId: string; isFallback: boolean }> {
  const candidates = [args.slot.primary, args.slot.fallback].filter((p): p is P => p !== null);
  let lastErr: unknown;
  for (const [i, provider] of candidates.entries()) {
    const isFallback = i > 0;
    if (isFallback) {
      await args.ctx.event("warn", args.stage, `Using fallback ${args.capability} provider ${provider.info.id}/${provider.info.model} for ${args.entity.type}`, {
        entity: args.entity,
      });
    }
    try {
      return await withRetry(async (attempt) => {
        await args.ctx.checkpoint();
        // Resume an in-flight task for this entity + provider if one exists.
        const [inflight] = await args.ctx.db
          .select()
          .from(providerJobs)
          .where(
            and(
              eq(providerJobs.projectId, args.ctx.projectId),
              eq(providerJobs.entityType, args.entity.type),
              eq(providerJobs.entityId, args.entity.id),
              eq(providerJobs.capability, args.capability),
              eq(providerJobs.provider, provider.info.id),
              eq(providerJobs.model, provider.info.model),
              inArray(providerJobs.status, ["submitted", "running"]),
            ),
          )
          .orderBy(desc(providerJobs.startedAt))
          .limit(1);

        let job: JobRow;
        if (inflight?.externalId) {
          job = inflight;
          await args.ctx.event("info", args.stage, `Resuming in-flight ${args.capability} task ${inflight.externalId}`, { entity: args.entity });
        } else {
          if (inflight) await finishJob(args, inflight.id, inflight.startedAt, { status: "failed", error: "Abandoned before submission" });
          job = await insertJob(args, provider.info, isFallback, attempt);
          const req = await args.buildRequest(provider, attempt);
          try {
            const sub = await provider.submit(req);
            await args.ctx.db
              .update(providerJobs)
              .set({ externalId: sub.externalId, status: "running", costEstimated: sub.estimatedCost?.amount ?? null, costUnit: sub.estimatedCost?.unit ?? null })
              .where(eq(providerJobs.id, job.id));
            job = { ...job, externalId: sub.externalId };
          } catch (err) {
            const pe = toProviderError(provider.info.id, err);
            await finishJob(args, job.id, job.startedAt, { status: "failed", error: pe.message, errorCode: pe.code });
            throw pe;
          }
        }

        const status = await pollUntilDone(args, provider, job);
        if (status.state !== "succeeded") {
          const msg = status.state === "cancelled" ? "Provider task was cancelled" : (status.error ?? "Provider task failed");
          await finishJob(args, job.id, job.startedAt, { status: status.state === "cancelled" ? "cancelled" : "failed", error: msg, errorCode: status.errorCode, cost: status.cost });
          throw new ProviderError({
            provider: provider.info.id,
            message: `${provider.info.displayName}: ${msg}`,
            retryable: !isPermanentTaskFailure(status.errorCode),
            code: status.errorCode,
          });
        }
        let result: GenerationResult;
        try {
          result = await provider.download(status);
          await args.validate?.(result);
        } catch (err) {
          const pe = toProviderError(provider.info.id, err);
          await finishJob(args, job.id, job.startedAt, { status: "failed", error: pe.message, errorCode: pe.code ?? "output_invalid", cost: status.cost });
          throw pe;
        }
        await finishJob(args, job.id, job.startedAt, { status: "succeeded", cost: status.cost });
        return { result, provider, providerJobId: job.id, isFallback };
      }, retryOpts(args));
    } catch (err) {
      if (err instanceof PipelineCancelledError || err instanceof PipelinePausedError || err instanceof RetryAbortedError) throw err;
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("No provider available");
}

async function pollUntilDone<Req>(
  args: BaseArgs & { onProgress?: (p: number) => Promise<void> | void },
  provider: AsyncTaskProvider<Req>,
  job: JobRow,
): Promise<TaskStatus> {
  const externalId = job.externalId!;
  const deadline = job.startedAt.getTime() + args.ctx.env.PROVIDER_TASK_TIMEOUT_SEC * 1000;
  let transientErrors = 0;
  for (;;) {
    const intr = await args.ctx.interrupted();
    if (intr === "cancel") {
      await provider.cancel(externalId).catch(() => undefined);
      await finishJob(args, job.id, job.startedAt, { status: "cancelled", error: "Cancelled by user" });
      throw new PipelineCancelledError();
    }
    // On pause we stop polling but leave the provider task running; resume re-polls it.
    if (intr === "pause") throw new PipelinePausedError();

    let status: TaskStatus;
    try {
      status = await provider.getStatus(externalId);
      transientErrors = 0;
    } catch (err) {
      const pe = toProviderError(provider.info.id, err);
      if (!pe.retryable || ++transientErrors > 5) throw pe;
      await defaultSleep(args.ctx.env.PROVIDER_POLL_INTERVAL_MS * 2 ** transientErrors);
      continue;
    }
    if (status.state === "succeeded" || status.state === "failed" || status.state === "cancelled") return status;
    if (status.progress !== undefined) await args.onProgress?.(status.progress);
    if (Date.now() > deadline) {
      await provider.cancel(externalId).catch(() => undefined);
      await finishJob(args, job.id, job.startedAt, { status: "failed", error: "Timed out waiting for provider", errorCode: "timeout" });
      throw new ProviderError({ provider: provider.info.id, message: `${provider.info.displayName} task timed out`, retryable: true, code: "timeout" });
    }
    await defaultSleep(args.ctx.env.PROVIDER_POLL_INTERVAL_MS);
  }
}
