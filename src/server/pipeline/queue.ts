import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { getEnv } from "@/server/env";

/**
 * Persistent job queue (BullMQ on Redis). One "pipeline" job per run of a
 * project; jobId = project:run guarantees at most one active run per project.
 * If a worker dies mid-run, BullMQ marks the job stalled and re-delivers it;
 * the idempotent pipeline then resumes from persisted state.
 */

export const PIPELINE_QUEUE = "afs-pipeline";

export type PipelineJobData = { projectId: string; run: number };

declare global {
  var __afsRedis: Redis | undefined;
  var __afsQueue: Queue<PipelineJobData> | undefined;
}

export function getRedis(): Redis {
  if (!globalThis.__afsRedis) {
    globalThis.__afsRedis = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
  }
  return globalThis.__afsRedis;
}

export function newRedisConnection(): Redis {
  return new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
}

export function getPipelineQueue(): Queue<PipelineJobData> {
  if (!globalThis.__afsQueue) {
    globalThis.__afsQueue = new Queue<PipelineJobData>(PIPELINE_QUEUE, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
        removeOnFail: { age: 30 * 24 * 3600 },
      },
    });
  }
  return globalThis.__afsQueue;
}

export async function enqueuePipeline(projectId: string, run: number): Promise<void> {
  await getPipelineQueue().add("run", { projectId, run }, { jobId: `${projectId}:${run}` });
}

export async function closeQueue(): Promise<void> {
  await globalThis.__afsQueue?.close();
  globalThis.__afsQueue = undefined;
  await globalThis.__afsRedis?.quit().catch(() => undefined);
  globalThis.__afsRedis = undefined;
}
