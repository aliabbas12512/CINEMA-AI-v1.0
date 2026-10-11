import { asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import {
  audioTracks,
  characterReferences,
  characters,
  dialogueLines,
  generationLogs,
  locations,
  providerJobs,
  qualityChecks,
  renderJobs,
  scenes,
  scripts,
  shots,
  subtitles,
  voices,
  worldBibles,
} from "@/server/db/schema";

/** Everything the project page shows. Asset ids only - media is served via /api/assets. */
export async function getProjectDetail(db: Db, projectId: string) {
  const [script] = await db.select().from(scripts).where(eq(scripts.projectId, projectId)).orderBy(desc(scripts.version)).limit(1);
  const [bible] = await db.select().from(worldBibles).where(eq(worldBibles.projectId, projectId));
  const charRows = await db.select().from(characters).where(eq(characters.projectId, projectId)).orderBy(asc(characters.name));
  const refs = charRows.length
    ? await db.select().from(characterReferences).where(inArray(characterReferences.characterId, charRows.map((c) => c.id)))
    : [];
  const locRows = await db.select().from(locations).where(eq(locations.projectId, projectId)).orderBy(asc(locations.name));
  const voiceRows = await db.select().from(voices).where(eq(voices.projectId, projectId));
  const sceneRows = await db.select().from(scenes).where(eq(scenes.projectId, projectId)).orderBy(asc(scenes.sequence));
  const shotRows = await db.select().from(shots).where(eq(shots.projectId, projectId)).orderBy(asc(shots.sequence));
  const lineRows = await db.select().from(dialogueLines).where(eq(dialogueLines.projectId, projectId)).orderBy(asc(dialogueLines.sequence));
  const subRows = await db.select().from(subtitles).where(eq(subtitles.projectId, projectId));
  const renders = await db.select().from(renderJobs).where(eq(renderJobs.projectId, projectId)).orderBy(desc(renderJobs.startedAt)).limit(10);
  const mixes = await db.select().from(audioTracks).where(eq(audioTracks.projectId, projectId)).orderBy(desc(audioTracks.createdAt)).limit(1);
  const qc = await db.select().from(qualityChecks).where(eq(qualityChecks.projectId, projectId)).orderBy(desc(qualityChecks.createdAt)).limit(300);
  const pjobs = await db
    .select({
      id: providerJobs.id,
      capability: providerJobs.capability,
      provider: providerJobs.provider,
      model: providerJobs.model,
      status: providerJobs.status,
      entityType: providerJobs.entityType,
      entityId: providerJobs.entityId,
      isFallback: providerJobs.isFallback,
      attempt: providerJobs.attempt,
      error: providerJobs.error,
      costEstimated: providerJobs.costEstimated,
      costActual: providerJobs.costActual,
      costUnit: providerJobs.costUnit,
      durationMs: providerJobs.durationMs,
      startedAt: providerJobs.startedAt,
    })
    .from(providerJobs)
    .where(eq(providerJobs.projectId, projectId))
    .orderBy(desc(providerJobs.startedAt))
    .limit(500);

  return {
    script: script ? { content: script.content, languageDetected: script.languageDetected, version: script.version } : null,
    story: bible ? { story: bible.story, world: bible.world, styleGuide: bible.styleGuide } : null,
    characters: charRows.map((c) => ({
      ...c,
      referenceAssetId: refs.find((r) => r.characterId === c.id && r.isPrimary)?.assetId ?? null,
      voices: voiceRows.filter((v) => v.speakerKey.split("@")[0] === c.key).map((v) => ({ provider: v.provider, voiceId: v.providerVoiceId, settings: v.settings })),
    })),
    narratorVoices: voiceRows.filter((v) => v.speakerKey.startsWith("narrator@")).map((v) => ({ provider: v.provider, voiceId: v.providerVoiceId })),
    locations: locRows,
    scenes: sceneRows.map((s) => ({
      ...s,
      lines: lineRows.filter((l) => l.sceneId === s.id),
      shots: shotRows.filter((sh) => sh.sceneId === s.id),
    })),
    subtitles: subRows,
    renders,
    finalMix: mixes[0] ?? null,
    qualityChecks: qc,
    providerJobs: pjobs,
  };
}

export async function getLogs(db: Db, projectId: string, afterId = 0) {
  const rows = await db.select().from(generationLogs).where(eq(generationLogs.projectId, projectId)).orderBy(desc(generationLogs.id)).limit(300);
  return rows.filter((r) => r.id > afterId).reverse();
}
