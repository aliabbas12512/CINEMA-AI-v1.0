import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { ProjectSettingsSchema } from "@/lib/settings";
import { closeDb, getDb } from "@/server/db/client";
import { projects } from "@/server/db/schema";
import { getEnv } from "@/server/env";
import { logger } from "@/server/logger";
import { runPipeline } from "@/server/pipeline/orchestrator";
import { closeQueue, newRedisConnection, PIPELINE_QUEUE, type PipelineJobData } from "@/server/pipeline/queue";
import { buildProviderSet } from "@/server/providers/registry";
import { getStorage } from "@/server/storage";

/**
 * Generation worker. Run separately from the web server:
 *   npm run worker
 * Requires FFmpeg/FFprobe on PATH (or FFMPEG_PATH/FFPROBE_PATH).
 */

async function main() {
  const env = getEnv();
  const db = getDb();
  const storage = getStorage();
  const connection = newRedisConnection();

  const worker = new Worker<PipelineJobData>(
    PIPELINE_QUEUE,
    async (job) => {
      const { projectId } = job.data;
      const [p] = await db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId));
      if (!p) {
        logger.warn({ project_id: projectId, job_id: job.id }, "Project no longer exists; dropping job");
        return "MISSING";
      }
      const settings = ProjectSettingsSchema.parse(p.settings);
      const { providers, issues } = buildProviderSet({ narratorGender: settings.narratorVoice });
      for (const i of issues) logger.warn({ project_id: projectId, slot: i.slot }, i.message);
      const log = logger.child({ project_id: projectId, job_id: job.id });
      const t0 = Date.now();
      log.info("pipeline job started");
      const outcome = await runPipeline({ db, storage, providers, env }, projectId);
      log.info({ outcome, duration_ms: Date.now() - t0 }, "pipeline job finished");
      return outcome;
    },
    {
      connection,
      concurrency: env.WORKER_CONCURRENCY,
      // Long provider polls: keep the lock alive; a dead worker's job is re-delivered.
      lockDuration: 5 * 60_000,
      stalledInterval: 60_000,
      maxStalledCount: 3,
    },
  );

  worker.on("failed", (job, err) => logger.error({ job_id: job?.id, err: err.message }, "pipeline job crashed"));
  worker.on("error", (err) => logger.error({ err: err.message }, "worker error"));
  logger.info({ concurrency: env.WORKER_CONCURRENCY }, "AI Fantasy Studio worker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker shutting down (in-flight jobs resume on restart)");
    await worker.close();
    await connection.quit().catch(() => undefined);
    await closeQueue();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  logger.fatal({ err: (err as Error).message }, "worker failed to start");
  process.exit(1);
});
