import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import {
  characters,
  dialogueLines,
  generationJobs,
  generationLogs,
  locations,
  projects,
  providerJobs,
  scenes,
  shots,
  worldBibles,
  type PipelineStage,
} from "@/server/db/schema";

/**
 * Real progress, computed from persisted unit state (never from timers).
 */

export const STAGE_LABELS: Record<PipelineStage, string> = {
  ANALYZING: "Script analysis",
  PLANNING: "Scene & shot planning",
  GENERATING_VOICE: "Urdu voice generation",
  GENERATING_CHARACTERS: "Character & world design",
  GENERATING_SCENES: "Shot keyframes",
  GENERATING_VIDEO: "Video generation",
  GENERATING_AUDIO: "Music & sound effects",
  ASSEMBLING: "Video assembly",
  QUALITY_CHECK: "Quality control",
};

const WEIGHTS: Record<PipelineStage, number> = {
  ANALYZING: 4,
  PLANNING: 8,
  GENERATING_VOICE: 8,
  GENERATING_CHARACTERS: 5,
  GENERATING_SCENES: 12,
  GENERATING_VIDEO: 40,
  GENERATING_AUDIO: 8,
  ASSEMBLING: 12,
  QUALITY_CHECK: 3,
};

export type StageStatus = {
  stage: PipelineStage;
  label: string;
  progress: number;
  completed: number;
  total: number;
  failed: number;
  status: "pending" | "running" | "completed" | "failed" | "paused" | "cancelled";
  message: string | null;
};

const done = (s: string) => s === "completed" || s === "skipped" || s === "unavailable";

function unitStage(stage: PipelineStage, statuses: string[], jobStatus?: string, message?: string | null): StageStatus {
  const total = statuses.length;
  const completed = statuses.filter(done).length;
  const failed = statuses.filter((s) => s === "failed").length;
  const progress = total ? Math.round((1000 * completed) / total) / 10 : 0;
  let status: StageStatus["status"] = total > 0 && completed === total ? "completed" : "pending";
  if (jobStatus === "RUNNING") status = "running";
  else if (failed > 0 || jobStatus === "FAILED") status = status === "completed" ? "completed" : "failed";
  else if (jobStatus === "PAUSED") status = "paused";
  else if (jobStatus === "CANCELLED") status = "cancelled";
  return { stage, label: STAGE_LABELS[stage], progress, completed, total, failed, status, message: message ?? null };
}

export async function getProjectStatus(db: Db, projectId: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new Error("not found");
  const jobs = await db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.projectId, projectId), eq(generationJobs.run, project.runCount)));
  const job = (s: PipelineStage) => jobs.find((j) => j.stage === s);

  const [bible] = await db.select({ id: worldBibles.id }).from(worldBibles).where(eq(worldBibles.projectId, projectId));
  const sceneRows = await db.select().from(scenes).where(eq(scenes.projectId, projectId)).orderBy(asc(scenes.sequence));
  const shotRows = await db.select().from(shots).where(eq(shots.projectId, projectId)).orderBy(asc(shots.sequence));
  const lineRows = await db.select({ s: dialogueLines.voiceStatus }).from(dialogueLines).where(eq(dialogueLines.projectId, projectId));
  const charRows = await db.select({ s: characters.referenceStatus }).from(characters).where(eq(characters.projectId, projectId));
  const locRows = await db.select({ s: locations.referenceStatus }).from(locations).where(eq(locations.projectId, projectId));

  const jobUnits = (s: PipelineStage): string[] => {
    const j = job(s);
    if (j?.status === "COMPLETED") return ["completed"];
    if (!j || j.totalUnits === 0) return ["pending"];
    return [...Array(j.completedUnits).fill("completed"), ...Array(Math.max(0, j.totalUnits - j.completedUnits)).fill("pending")];
  };
  const assembled = !!project.finalAssetId && project.status === "COMPLETED";

  const stages: StageStatus[] = [
    unitStage("ANALYZING", [bible ? "completed" : "pending"], job("ANALYZING")?.status, job("ANALYZING")?.message),
    unitStage("PLANNING", sceneRows.length ? sceneRows.map((s) => s.shotPlanStatus) : ["pending"], job("PLANNING")?.status, job("PLANNING")?.message),
    unitStage("GENERATING_VOICE", lineRows.length ? lineRows.map((l) => l.s) : ["pending"], job("GENERATING_VOICE")?.status, job("GENERATING_VOICE")?.message),
    unitStage("GENERATING_CHARACTERS", [...charRows, ...locRows].map((r) => r.s).concat(charRows.length ? [] : ["pending"]), job("GENERATING_CHARACTERS")?.status),
    unitStage("GENERATING_SCENES", shotRows.length ? shotRows.map((s) => s.keyframeStatus) : ["pending"], job("GENERATING_SCENES")?.status),
    unitStage("GENERATING_VIDEO", shotRows.length ? shotRows.map((s) => s.videoStatus) : ["pending"], job("GENERATING_VIDEO")?.status),
    unitStage(
      "GENERATING_AUDIO",
      shotRows.length ? [...sceneRows.map((s) => s.musicStatus), ...shotRows.map((s) => s.sfxStatus)] : ["pending"],
      job("GENERATING_AUDIO")?.status,
    ),
    unitStage("ASSEMBLING", assembled ? ["completed"] : jobUnits("ASSEMBLING"), job("ASSEMBLING")?.status, job("ASSEMBLING")?.message),
    unitStage("QUALITY_CHECK", assembled ? ["completed"] : jobUnits("QUALITY_CHECK"), job("QUALITY_CHECK")?.status, job("QUALITY_CHECK")?.message),
  ];
  const overallProgress =
    Math.round((10 * stages.reduce((s, st) => s + (WEIGHTS[st.stage] * st.progress) / 100, 0) * 100) / Object.values(WEIGHTS).reduce((a, b) => a + b, 0)) / 10;

  // Current scene / shot = first unfinished video unit (or keyframe).
  const activeShot =
    shotRows.find((s) => s.videoStatus === "running") ?? shotRows.find((s) => s.keyframeStatus === "running") ?? null;
  const activeScene = activeShot ? sceneRows.find((s) => s.id === activeShot.sceneId) : null;

  // ETA: only when the current stage has enough real samples.
  let etaSec: number | null = null;
  const vj = job("GENERATING_VIDEO");
  if (project.status === "GENERATING_VIDEO" && vj?.startedAt && vj.completedUnits >= 3) {
    const startDone = shotRows.filter((s) => s.videoStatus === "completed").length - vj.completedUnits;
    const doneThisRun = vj.completedUnits - Math.max(0, startDone);
    const elapsed = (Date.now() - vj.startedAt.getTime()) / 1000;
    if (doneThisRun >= 3) etaSec = Math.round((elapsed / doneThisRun) * (vj.totalUnits - vj.completedUnits));
  }

  const costRows = await db
    .select({
      unit: providerJobs.costUnit,
      capability: providerJobs.capability,
      amount: sql<number>`coalesce(sum(coalesce(${providerJobs.costActual}, 0)), 0)`,
      estimated: sql<number>`coalesce(sum(coalesce(${providerJobs.costEstimated}, 0)), 0)`,
      jobs: sql<number>`count(*)`,
    })
    .from(providerJobs)
    .where(eq(providerJobs.projectId, projectId))
    .groupBy(providerJobs.costUnit, providerJobs.capability);
  const byUnit = new Map<string, number>();
  for (const r of costRows) if (r.unit) byUnit.set(r.unit, (byUnit.get(r.unit) ?? 0) + Number(r.amount));
  const retries = await db
    .select({ n: sql<number>`count(*)` })
    .from(providerJobs)
    .where(and(eq(providerJobs.projectId, projectId), eq(providerJobs.status, "failed")));
  const recentErrors = await db
    .select({ message: generationLogs.message, stage: generationLogs.stage, createdAt: generationLogs.createdAt })
    .from(generationLogs)
    .where(and(eq(generationLogs.projectId, projectId), eq(generationLogs.level, "error")))
    .orderBy(desc(generationLogs.id))
    .limit(5);

  return {
    id: project.id,
    title: project.title,
    status: project.status,
    control: project.control,
    currentStage: project.currentStage,
    error: project.error,
    run: project.runCount,
    startedAt: project.startedAt,
    completedAt: project.completedAt,
    elapsedSec: project.startedAt ? Math.round(((project.completedAt ?? new Date()).getTime() - project.startedAt.getTime()) / 1000) : 0,
    etaSec,
    overallProgress,
    stages,
    scenesTotal: sceneRows.length,
    scenesCompleted: sceneRows.filter((sc) => {
      const ss = shotRows.filter((s) => s.sceneId === sc.id);
      return ss.length > 0 && ss.every((s) => s.videoStatus === "completed");
    }).length,
    currentScene: activeScene ? { id: activeScene.id, sequence: activeScene.sequence, title: activeScene.title } : null,
    currentShot: activeShot ? { id: activeShot.id, sequence: activeShot.sequence } : null,
    failedProviderCalls: Number(retries[0]?.n ?? 0),
    recentErrors,
    costs: [...byUnit.entries()].map(([unit, amount]) => ({ unit, amount })),
    costBreakdown: costRows.map((r) => ({ capability: r.capability, unit: r.unit, actual: Number(r.amount), estimated: Number(r.estimated), jobs: Number(r.jobs) })),
    finalAssetId: project.status === "COMPLETED" ? project.finalAssetId : null,
    thumbnailAssetId: project.thumbnailAssetId,
  };
}

export type ProjectStatus = Awaited<ReturnType<typeof getProjectStatus>>;
