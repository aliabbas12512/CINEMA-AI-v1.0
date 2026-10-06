import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/server/db/client";
import {
  assets,
  characterReferences,
  dialogueLines,
  generationJobs,
  projects,
  providerJobs,
  qualityChecks,
  shots,
  subtitles,
  voices,
} from "@/server/db/schema";
import { probe } from "@/server/media/probe";
import { runPipeline } from "@/server/pipeline/orchestrator";
import { createProject, requestControl, retryShot, startGeneration } from "@/server/services/projects";
import { getStorage } from "@/server/storage";
import { createUser, deps, resetDatabase, SAMPLE_SCRIPT } from "../helpers";
import { mockProviderSet, MockVideo, MockVoice } from "../mocks/providers";
import { FfmpegMotionVideoProvider } from "@/server/providers/adapters/ffmpeg-motion";
import { getProjectStatus } from "@/server/services/status";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const db = () => getDb();
const noEnqueue = async () => undefined;

async function newProject(settings: Record<string, unknown> = {}) {
  const user = await createUser();
  const project = await createProject(
    db(),
    user.id,
    { script: SAMPLE_SCRIPT, settings: { targetDurationSec: 30, subtitleLanguage: "ur", ...settings } },
    60_000,
  );
  return { user, project };
}

describe("generation pipeline end-to-end (mock providers, real DB/FFmpeg/storage)", () => {
  beforeEach(async () => {
    await resetDatabase();
    await rm(path.resolve("tmp/test-storage"), { recursive: true, force: true });
    await mkdir(path.resolve("tmp/test-storage"), { recursive: true });
  });
  afterAll(async () => {
    await closeDb();
  });

  it("create project -> submit script -> jobs -> providers -> assemble -> validated final output", async () => {
    const { user, project } = await newProject();
    const providers = mockProviderSet();
    await startGeneration(db(), user.id, project.id, noEnqueue);
    const outcome = await runPipeline(deps(providers), project.id);
    const [p] = await db().select().from(projects).where(eq(projects.id, project.id));
    expect(p?.error ?? null).toBeNull();
    expect(outcome).toBe("COMPLETED");
    expect(p!.status).toBe("COMPLETED");
    expect(p!.finalAssetId).toBeTruthy();

    // Final file exists in storage and is a valid 1080p H.264/AAC video with Urdu subtitles.
    const [final] = await db().select().from(assets).where(eq(assets.id, p!.finalAssetId!));
    const local = path.resolve("tmp/test-storage", final!.storageKey);
    const info = await probe(local);
    expect(info.video?.codec).toBe("h264");
    expect(info.video?.width).toBe(1920);
    expect(info.video?.height).toBe(1080);
    expect(info.audio?.codec).toBe("aac");
    expect(info.subtitleStreams).toBe(1);
    expect(info.durationSec).toBeGreaterThan(5);

    // Every stage recorded with real progress.
    const jobs = await db().select().from(generationJobs).where(eq(generationJobs.projectId, project.id));
    expect(jobs.map((j) => j.stage).sort()).toEqual(
      ["ANALYZING", "ASSEMBLING", "GENERATING_AUDIO", "GENERATING_CHARACTERS", "GENERATING_SCENES", "GENERATING_VIDEO", "GENERATING_VOICE", "PLANNING", "QUALITY_CHECK"].sort(),
    );
    expect(jobs.every((j) => j.status === "COMPLETED" && j.progress === 100)).toBe(true);

    // Character persistence: one primary reference per character, reused for every keyframe.
    const refs = await db().select().from(characterReferences);
    expect(refs.filter((r) => r.isPrimary)).toHaveLength(2);
    const imageSubmits = (providers.image as unknown as { submits: Array<{ references?: Array<{ tag: string }> }> }).submits;
    const keyframeSubmits = imageSubmits.filter((s) => (s.references ?? []).length > 0);
    expect(keyframeSubmits.length).toBe(4);
    expect(keyframeSubmits.every((s) => s.references!.some((r) => r.tag === "char1"))).toBe(true);

    // Consistent voices: same speaker -> same voice id.
    const voiceRows = await db().select().from(voices).where(eq(voices.projectId, project.id));
    expect(voiceRows.map((v) => v.speakerKey).sort()).toEqual(["narrator@mock-voice", "pari_noor@mock-voice", "prince_zain@mock-voice"]);

    // Subtitles from final audio timing, both languages and formats.
    const subs = await db().select().from(subtitles).where(eq(subtitles.projectId, project.id));
    expect(subs).toHaveLength(4);
    const [urSrt] = subs.filter((s) => s.language === "ur" && s.format === "srt");
    const srtAsset = (await db().select().from(assets).where(eq(assets.id, urSrt!.assetId)))[0]!;
    const srt = (await getStorage().get(srtAsset.storageKey)).toString("utf8");
    expect(srt).toContain("ایک زمانے کی بات ہے۔");
    const lines = await db().select().from(dialogueLines).where(eq(dialogueLines.projectId, project.id));
    expect(lines.every((l) => l.approved && l.audioDurationSec && l.startOffsetSec !== null)).toBe(true);

    // QC recorded and passed for the final render.
    const qc = await db().select().from(qualityChecks).where(and(eq(qualityChecks.projectId, project.id), eq(qualityChecks.targetType, "final")));
    expect(qc.filter((q) => !q.passed && q.severity === "error")).toEqual([]);

    // Lip sync applied only to on-camera dialogue (never narration); costs recorded per provider job.
    const shotRows = await db().select().from(shots).where(eq(shots.projectId, project.id));
    expect(shotRows.filter((s) => s.lipsyncStatus === "completed").length).toBe(1);
    expect(shotRows.filter((s) => s.lipsyncStatus === "skipped").length).toBe(3);
    const pj = await db().select().from(providerJobs).where(eq(providerJobs.projectId, project.id));
    expect(pj.filter((j) => j.capability === "video" && j.status === "succeeded" && j.costActual === 5 && j.costUnit === "credits")).toHaveLength(4);

    const status = await getProjectStatus(db(), project.id);
    expect(status.overallProgress).toBe(100);
    expect(status.costs.find((c) => c.unit === "credits")?.amount).toBeGreaterThan(0);
  });

  it("retries transient failures, regenerates QC failures and resumes without regenerating successful shots", async () => {
    const { user, project } = await newProject();
    const video = new MockVideo();
    video.failTransientTimes = 1; // 503 once -> retried with backoff
    video.produceBlackOnce = true; // first produced clip is black -> QC regenerates it
    video.failPermanently.add("glows brighter"); // all shots share this motion prompt...
    const providers = mockProviderSet({ video: { primary: video, fallback: null } });

    await startGeneration(db(), user.id, project.id, noEnqueue);
    const first = await runPipeline(deps(providers), project.id);
    expect(first).toBe("FAILED");
    const [p1] = await db().select().from(projects).where(eq(projects.id, project.id));
    expect(p1!.error).toMatch(/shot\(s\) failed/);
    const failedShots = await db().select().from(shots).where(and(eq(shots.projectId, project.id), eq(shots.videoStatus, "failed")));
    expect(failedShots.length).toBe(4);
    // Permanent moderation failures are not retried endlessly.
    const voiceCallsAfterFirstRun = (providers.voice.primary as MockVoice).calls.length;

    // Fix the cause and resume: voice/keyframes are NOT regenerated, only failed shots.
    video.failPermanently.clear();
    const imageSubmitsBefore = (providers.image as unknown as { submits: unknown[] }).submits.length;
    await startGeneration(db(), user.id, project.id, noEnqueue);
    const second = await runPipeline(deps(providers), project.id);
    expect(second).toBe("COMPLETED");
    expect((providers.voice.primary as MockVoice).calls.length).toBe(voiceCallsAfterFirstRun);
    expect((providers.image as unknown as { submits: unknown[] }).submits.length).toBe(imageSubmitsBefore);

    // QC failure was recorded and the shot regenerated.
    const qcFails = await db().select().from(qualityChecks).where(and(eq(qualityChecks.projectId, project.id), eq(qualityChecks.check, "black_frames"), eq(qualityChecks.passed, false)));
    expect(qcFails.length).toBeGreaterThanOrEqual(1);

    // Retry exactly one shot after completion: only that shot is re-generated.
    const submitsBefore = video.submits.length;
    const target = (await db().select().from(shots).where(eq(shots.projectId, project.id)))[0]!;
    await retryShot(db(), user.id, project.id, target.id, { regenerateKeyframe: false }, noEnqueue);
    expect(await runPipeline(deps(providers), project.id)).toBe("COMPLETED");
    expect(video.submits.length).toBe(submitsBefore + 1);
  });

  it("produces a real film with the no-cost ffmpeg_motion video provider (no Runway)", async () => {
    const { user, project } = await newProject({ lipSync: false });
    const providers = mockProviderSet({ video: { primary: new FfmpegMotionVideoProvider(), fallback: null } });
    await startGeneration(db(), user.id, project.id, noEnqueue);
    expect(await runPipeline(deps(providers), project.id)).toBe("COMPLETED");
    const rows = await db().select().from(shots).where(eq(shots.projectId, project.id));
    expect(rows.every((s) => s.videoProvider === "ffmpeg_motion/zoompan-v1")).toBe(true);
    const [p] = await db().select().from(projects).where(eq(projects.id, project.id));
    const [final] = await db().select().from(assets).where(eq(assets.id, p!.finalAssetId!));
    const info = await probe(path.resolve("tmp/test-storage", final!.storageKey));
    expect(info.video).toMatchObject({ codec: "h264", width: 1920, height: 1080 });
    const pj = await db().select().from(providerJobs).where(and(eq(providerJobs.projectId, project.id), eq(providerJobs.capability, "video")));
    expect(pj.every((j) => j.status === "succeeded" && j.costActual === 0 && j.costUnit === "usd")).toBe(true);
  });

  it("uses the fallback video provider and records it", async () => {
    const { user, project } = await newProject({ lipSync: false });
    const primary = new MockVideo("primary-video");
    primary.failPermanently.add("glows brighter");
    const fallback = new MockVideo("fallback-video");
    const providers = mockProviderSet({ video: { primary, fallback } });
    await startGeneration(db(), user.id, project.id, noEnqueue);
    expect(await runPipeline(deps(providers), project.id)).toBe("COMPLETED");
    const rows = await db().select().from(shots).where(eq(shots.projectId, project.id));
    expect(rows.every((s) => s.videoProvider?.includes("fallback-video") && s.videoProvider.includes("(fallback)"))).toBe(true);
    expect(rows.every((s) => s.lipsyncStatus === "unavailable" || s.lipsyncStatus === "skipped")).toBe(true);
    const pj = await db().select().from(providerJobs).where(and(eq(providerJobs.projectId, project.id), eq(providerJobs.isFallback, true)));
    expect(pj.length).toBe(4);
  });

  it("reports a missing provider honestly instead of faking output", async () => {
    const { user, project } = await newProject();
    const providers = mockProviderSet({ video: { primary: null, fallback: null } });
    await startGeneration(db(), user.id, project.id, noEnqueue);
    expect(await runPipeline(deps(providers), project.id)).toBe("FAILED");
    const [p] = await db().select().from(projects).where(eq(projects.id, project.id));
    expect(p!.error).toBe("Video generation provider is not configured.");
    expect(p!.finalAssetId).toBeNull();
    // Work done before the missing capability is kept for resume.
    const lines = await db().select().from(dialogueLines).where(eq(dialogueLines.projectId, project.id));
    expect(lines.every((l) => l.voiceStatus === "completed")).toBe(true);
  });

  it("marks a failing voice provider as FAILED with a human-readable error", async () => {
    const { user, project } = await newProject();
    const voice = new MockVoice();
    voice.failAll = true;
    await startGeneration(db(), user.id, project.id, noEnqueue);
    expect(await runPipeline(deps(mockProviderSet({ voice: { primary: voice, fallback: null } })), project.id)).toBe("FAILED");
    const [p] = await db().select().from(projects).where(eq(projects.id, project.id));
    expect(p!.error).toMatch(/voice line\(s\) failed/);
    const lines = await db().select().from(dialogueLines).where(eq(dialogueLines.projectId, project.id));
    expect(lines.every((l) => l.voiceStatus === "failed" && l.voiceError?.includes("401"))).toBe(true);
  });

  it("cancels an in-flight generation and cancels the provider task", async () => {
    const { user, project } = await newProject();
    const video = new MockVideo();
    video.pollsToFinish = 1_000_000; // never finishes on its own
    const providers = mockProviderSet({ video: { primary: video, fallback: null } });
    await startGeneration(db(), user.id, project.id, noEnqueue);
    const run = runPipeline(deps(providers), project.id);
    for (let i = 0; i < 600 && video.submits.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(video.submits.length).toBeGreaterThan(0);
    await requestControl(db(), user.id, project.id, "cancel");
    expect(await run).toBe("CANCELLED");
    expect(video.cancelled.length).toBeGreaterThan(0);
    const [p] = await db().select().from(projects).where(eq(projects.id, project.id));
    expect(p!.status).toBe("CANCELLED");
  });

  it("pauses and resumes polling the SAME provider task (no duplicate charge)", async () => {
    const { user, project } = await newProject();
    const video = new MockVideo();
    video.pollsToFinish = 1_000_000;
    const providers = mockProviderSet({ video: { primary: video, fallback: null } });
    await startGeneration(db(), user.id, project.id, noEnqueue);
    const run = runPipeline(deps(providers), project.id);
    for (let i = 0; i < 600 && video.submits.length < 3; i++) await new Promise((r) => setTimeout(r, 100));
    await requestControl(db(), user.id, project.id, "pause");
    expect(await run).toBe("PAUSED");
    const submitted = video.submits.length;
    expect(submitted).toBeGreaterThan(0);
    expect(video.cancelled).toHaveLength(0);
    // Nothing keeps running after the pause settles.
    await new Promise((r) => setTimeout(r, 500));
    expect(video.submits.length).toBe(submitted);

    video.pollsToFinish = 1;
    await startGeneration(db(), user.id, project.id, noEnqueue);
    expect(await runPipeline(deps(providers), project.id)).toBe("COMPLETED");
    // In-flight tasks were resumed by external id; only never-submitted shots were submitted.
    expect(video.submits.length).toBe(4);
  });
});
