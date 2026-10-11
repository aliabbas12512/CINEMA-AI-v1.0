import { mkdir } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { ProjectSettings } from "@/lib/settings";
import type { Db } from "@/server/db/client";
import { generationJobs, generationLogs, projects, type PipelineStage } from "@/server/db/schema";
import type { Env } from "@/server/env";
import { logFor } from "@/server/logger";
import type { ProviderSet } from "@/server/providers/types";
import type { StorageProvider } from "@/server/storage/types";

export class PipelineCancelledError extends Error {
  constructor() {
    super("Generation was cancelled.");
    this.name = "PipelineCancelledError";
  }
}

export class PipelinePausedError extends Error {
  constructor() {
    super("Generation was paused.");
    this.name = "PipelinePausedError";
  }
}

/** A stage could not finish; message is shown to the user verbatim. */
export class StageFailedError extends Error {
  constructor(
    public readonly stage: PipelineStage,
    message: string,
  ) {
    super(message);
    this.name = "StageFailedError";
  }
}

export type PipelineDeps = {
  db: Db;
  storage: StorageProvider;
  providers: ProviderSet;
  env: Env;
};

export type PipelineContext = PipelineDeps & {
  projectId: string;
  run: number;
  settings: ProjectSettings;
  workDir: string;
  log: ReturnType<typeof logFor>;
  /** Throws PipelineCancelledError / PipelinePausedError if requested. */
  checkpoint(): Promise<void>;
  /** True if a pause/cancel was requested (non-throwing). */
  interrupted(): Promise<"cancel" | "pause" | null>;
  event(level: "info" | "warn" | "error", stage: PipelineStage | null, message: string, context?: Record<string, unknown>): Promise<void>;
  stageJobId(stage: PipelineStage): Promise<string | undefined>;
};

export async function createContext(deps: PipelineDeps, projectId: string, run: number, settings: ProjectSettings): Promise<PipelineContext> {
  const workDir = path.resolve(deps.env.WORK_DIR, projectId);
  await mkdir(workDir, { recursive: true });
  const log = logFor({ project_id: projectId });

  const interrupted = async (): Promise<"cancel" | "pause" | null> => {
    const [p] = await deps.db.select({ control: projects.control }).from(projects).where(eq(projects.id, projectId));
    if (!p || p.control === "cancel_requested") return "cancel";
    if (p.control === "pause_requested") return "pause";
    return null;
  };

  return {
    ...deps,
    projectId,
    run,
    settings,
    workDir,
    log,
    interrupted,
    async checkpoint() {
      const s = await interrupted();
      if (s === "cancel") throw new PipelineCancelledError();
      if (s === "pause") throw new PipelinePausedError();
    },
    async event(level, stage, message, context) {
      log[level]({ stage, ...context }, message);
      await deps.db.insert(generationLogs).values({ projectId, level, stage, message: message.slice(0, 4000), context: context ?? null });
    },
    async stageJobId(stage) {
      const [j] = await deps.db
        .select({ id: generationJobs.id })
        .from(generationJobs)
        .where(and(eq(generationJobs.projectId, projectId), eq(generationJobs.run, run), eq(generationJobs.stage, stage)));
      return j?.id;
    },
  };
}

/**
 * Human-readable error text including the root cause. Database errors from
 * Drizzle carry only "Failed query: <sql> params: ..." in `message`; the real
 * reason (e.g. connection refused, encoding error) is in `cause`.
 */
export function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  let msg = err.message;
  if (msg.startsWith("Failed query:")) msg = `Database query failed (${msg.slice(14, 80).split("\n")[0]}...)`;
  const seen = new Set<unknown>([err]);
  let cause = (err as { cause?: unknown }).cause;
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    const c = cause.message.startsWith("Failed query:") ? "database query failed" : cause.message;
    if (c && !msg.includes(c)) msg += ` <- ${c}`;
    cause = (cause as { cause?: unknown }).cause;
  }
  return msg;
}
