import { and, desc, eq, sql } from "drizzle-orm";
import { CreateProjectSchema, ProjectSettingsSchema, type CreateProjectInput } from "@/lib/settings";
import type { Db } from "@/server/db/client";
import type { StorageProvider } from "@/server/storage/types";
import {
  assets,
  characters,
  dialogueLines,
  locations,
  projects,
  scenes,
  scripts,
  shots,
  type Project,
} from "@/server/db/schema";

export class ServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

const ACTIVE_STATUSES = [
  "QUEUED",
  "ANALYZING",
  "PLANNING",
  "GENERATING_VOICE",
  "GENERATING_CHARACTERS",
  "GENERATING_SCENES",
  "GENERATING_VIDEO",
  "GENERATING_AUDIO",
  "ASSEMBLING",
  "QUALITY_CHECK",
] as const;

export function isActive(status: Project["status"]): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

export type Enqueue = (projectId: string, run: number) => Promise<void>;

/** Fetch a project only if it belongs to the user (authorization boundary). */
export async function getOwnedProject(db: Db, userId: string, projectId: string): Promise<Project> {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new ServiceError(404, "Project not found");
  const [p] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  if (!p) throw new ServiceError(404, "Project not found");
  return p;
}

export async function listProjects(db: Db, userId: string) {
  return db
    .select({
      id: projects.id,
      title: projects.title,
      status: projects.status,
      currentStage: projects.currentStage,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
      thumbnailAssetId: projects.thumbnailAssetId,
      finalAssetId: projects.finalAssetId,
      error: projects.error,
    })
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.createdAt))
    .limit(200);
}

export async function createProject(db: Db, userId: string, raw: unknown, maxScriptChars: number): Promise<Project> {
  const parsed = CreateProjectSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(400, parsed.error.issues.map((i) => i.message).join("; "));
  const input: CreateProjectInput = parsed.data;
  if (input.script.length > maxScriptChars) throw new ServiceError(413, `Script exceeds ${maxScriptChars} characters`);
  const settings = ProjectSettingsSchema.parse(input.settings);
  const title = input.title?.trim() || deriveTitle(input.script);
  return db.transaction(async (tx) => {
    const [p] = await tx.insert(projects).values({ userId, title, settings, status: "DRAFT" }).returning();
    await tx.insert(scripts).values({ projectId: p!.id, version: 1, content: input.script, isCurrent: true });
    return p!;
  });
}

function deriveTitle(script: string): string {
  const first = script.split("\n").map((l) => l.trim()).find(Boolean) ?? "Untitled";
  return first.length > 80 ? `${first.slice(0, 77)}...` : first;
}

/**
 * Start or resume generation. Failed units are reset to pending so ONLY they
 * are regenerated; completed units are untouched.
 */
export async function startGeneration(db: Db, userId: string, projectId: string, enqueue: Enqueue): Promise<{ run: number }> {
  const p = await getOwnedProject(db, userId, projectId);
  if (isActive(p.status)) throw new ServiceError(409, "Generation is already running for this project.");
  if (p.status === "COMPLETED") throw new ServiceError(409, "Project is already completed. Retry an individual shot to re-render.");
  const run = await db.transaction(async (tx) => {
    await resetFailedUnits(tx as unknown as Db, projectId);
    const [updated] = await tx
      .update(projects)
      .set({ status: "QUEUED", control: "none", error: null, runCount: sql`${projects.runCount} + 1` })
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .returning({ run: projects.runCount });
    return updated!.run;
  });
  try {
    await enqueue(projectId, run);
  } catch (err) {
    // Never leave a project claiming to be queued when no job exists.
    await db
      .update(projects)
      .set({ status: "FAILED", error: "Could not queue the generation job. Is Redis reachable? Try again." })
      .where(eq(projects.id, projectId));
    throw new ServiceError(503, `Could not queue generation: ${(err as Error).message}`);
  }
  return { run };
}

export async function resetFailedUnits(db: Db, projectId: string): Promise<void> {
  await db.update(dialogueLines).set({ voiceStatus: "pending" }).where(and(eq(dialogueLines.projectId, projectId), eq(dialogueLines.voiceStatus, "failed")));
  await db.update(characters).set({ referenceStatus: "pending" }).where(and(eq(characters.projectId, projectId), eq(characters.referenceStatus, "failed")));
  await db.update(locations).set({ referenceStatus: "pending" }).where(and(eq(locations.projectId, projectId), eq(locations.referenceStatus, "failed")));
  await db.update(scenes).set({ shotPlanStatus: "pending" }).where(and(eq(scenes.projectId, projectId), eq(scenes.shotPlanStatus, "failed")));
  await db.update(scenes).set({ musicStatus: "pending" }).where(and(eq(scenes.projectId, projectId), eq(scenes.musicStatus, "failed")));
  for (const col of ["keyframeStatus", "videoStatus", "lipsyncStatus", "sfxStatus"] as const) {
    await db
      .update(shots)
      .set({ [col]: "pending" })
      .where(and(eq(shots.projectId, projectId), eq(shots[col], "failed")));
  }
  // Units left "running" by a crashed worker are also retried.
  await db.update(shots).set({ videoStatus: "pending" }).where(and(eq(shots.projectId, projectId), eq(shots.videoStatus, "running")));
  await db.update(shots).set({ keyframeStatus: "pending" }).where(and(eq(shots.projectId, projectId), eq(shots.keyframeStatus, "running")));
  await db.update(dialogueLines).set({ voiceStatus: "pending" }).where(and(eq(dialogueLines.projectId, projectId), eq(dialogueLines.voiceStatus, "running")));
}

export async function requestControl(db: Db, userId: string, projectId: string, action: "pause" | "cancel"): Promise<Project["status"]> {
  const p = await getOwnedProject(db, userId, projectId);
  if (action === "cancel" && (p.status === "PAUSED" || p.status === "FAILED" || p.status === "DRAFT")) {
    await db.update(projects).set({ status: "CANCELLED", control: "none" }).where(eq(projects.id, projectId));
    return "CANCELLED";
  }
  if (!isActive(p.status)) throw new ServiceError(409, `Cannot ${action} a project that is ${p.status.toLowerCase()}.`);
  await db
    .update(projects)
    .set({ control: action === "pause" ? "pause_requested" : "cancel_requested" })
    .where(eq(projects.id, projectId));
  return p.status;
}

/** Regenerate one shot (video, optionally keyframe) and re-render the film. */
export async function retryShot(
  db: Db,
  userId: string,
  projectId: string,
  shotId: string,
  opts: { regenerateKeyframe: boolean },
  enqueue: Enqueue,
): Promise<{ run: number }> {
  const p = await getOwnedProject(db, userId, projectId);
  if (isActive(p.status)) throw new ServiceError(409, "Wait for the current run to finish or pause it first.");
  const [shot] = await db.select().from(shots).where(and(eq(shots.id, shotId), eq(shots.projectId, projectId)));
  if (!shot) throw new ServiceError(404, "Shot not found");
  await db
    .update(shots)
    .set({
      videoStatus: "pending",
      qcStatus: "pending",
      error: null,
      lipsyncStatus: shot.speakingLineId ? "pending" : shot.lipsyncStatus,
      ...(opts.regenerateKeyframe ? { keyframeStatus: "pending" as const } : {}),
    })
    .where(eq(shots.id, shotId));
  if (p.status === "COMPLETED") {
    await db.update(projects).set({ status: "FAILED", error: null }).where(eq(projects.id, projectId));
  }
  return startGeneration(db, userId, projectId, enqueue);
}

export async function deleteProject(db: Db, storage: StorageProvider, userId: string, projectId: string): Promise<void> {
  const p = await getOwnedProject(db, userId, projectId);
  if (isActive(p.status)) throw new ServiceError(409, "Cancel generation before deleting the project.");
  const keys = await db.select({ key: assets.storageKey }).from(assets).where(eq(assets.projectId, projectId));
  await db.delete(projects).where(eq(projects.id, projectId));
  for (const k of keys) await storage.delete(k.key).catch(() => undefined);
}

