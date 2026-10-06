import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ProjectSettings } from "@/lib/settings";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------------------------------------------------------------- enums

export const projectStatus = pgEnum("project_status", [
  "DRAFT",
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
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "PAUSED",
]);

export const pipelineStage = pgEnum("pipeline_stage", [
  "ANALYZING",
  "PLANNING",
  "GENERATING_VOICE",
  "GENERATING_CHARACTERS",
  "GENERATING_SCENES",
  "GENERATING_VIDEO",
  "GENERATING_AUDIO",
  "ASSEMBLING",
  "QUALITY_CHECK",
]);

export const jobStatus = pgEnum("job_status", [
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "PAUSED",
]);

export const projectControl = pgEnum("project_control", ["none", "pause_requested", "cancel_requested"]);

/** Status of one generated unit (shot video, voice line, music cue, ...). */
export const unitStatus = pgEnum("unit_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
  "unavailable",
]);

export const assetKind = pgEnum("asset_kind", [
  "character_ref",
  "location_ref",
  "keyframe",
  "shot_video",
  "lipsync_video",
  "voice_line",
  "music",
  "sfx",
  "mix_audio",
  "subtitle",
  "scene_preview",
  "final_video",
  "thumbnail",
]);

export const providerJobStatus = pgEnum("provider_job_status", [
  "submitted",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const capability = pgEnum("capability", ["llm", "image", "video", "voice", "music", "sfx", "lipsync"]);

// ---------------------------------------------------------------- auth

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    /** sha256 of the opaque session token; the raw token only lives in the cookie. */
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

// ---------------------------------------------------------------- projects

export const projects = pgTable(
  "projects",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: projectStatus("status").notNull().default("DRAFT"),
    currentStage: pipelineStage("current_stage"),
    control: projectControl("control").notNull().default("none"),
    settings: jsonb("settings").$type<ProjectSettings>().notNull(),
    error: text("error"),
    runCount: integer("run_count").notNull().default(0),
    qcRegenerations: integer("qc_regenerations").notNull().default(0),
    finalAssetId: uuid("final_asset_id"),
    thumbnailAssetId: uuid("thumbnail_asset_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("projects_user_idx").on(t.userId, t.createdAt)],
);

export const scripts = pgTable(
  "scripts",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    languageDetected: text("language_detected"),
    isCurrent: boolean("is_current").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("scripts_project_version_uq").on(t.projectId, t.version)],
);

/** Story + world bible produced by script analysis. One per project. */
export const worldBibles = pgTable("world_bibles", {
  id: id(),
  projectId: uuid("project_id")
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: "cascade" }),
  scriptId: uuid("script_id")
    .notNull()
    .references(() => scripts.id, { onDelete: "cascade" }),
  story: jsonb("story").notNull(),
  world: jsonb("world").notNull(),
  styleGuide: text("style_guide").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const characters = pgTable(
  "characters",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    age: text("age").notNull(),
    gender: text("gender").notNull(),
    appearance: text("appearance").notNull(),
    face: text("face").notNull(),
    hair: text("hair").notNull(),
    eyes: text("eyes").notNull(),
    skinTone: text("skin_tone").notNull(),
    bodyType: text("body_type").notNull(),
    clothing: text("clothing").notNull(),
    accessories: text("accessories").notNull(),
    weapons: text("weapons").notNull(),
    personality: text("personality").notNull(),
    voiceProfile: jsonb("voice_profile").notNull(),
    visualPrompt: text("visual_prompt").notNull(),
    referenceStatus: unitStatus("reference_status").notNull().default("pending"),
    referenceError: text("reference_error"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("characters_project_key_uq").on(t.projectId, t.key)],
);

export const characterReferences = pgTable(
  "character_references",
  {
    id: id(),
    characterId: uuid("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    isPrimary: boolean("is_primary").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("character_refs_character_idx").on(t.characterId)],
);

export const locations = pgTable(
  "locations",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    description: text("description").notNull(),
    architecture: text("architecture").notNull(),
    climate: text("climate").notNull(),
    visualPrompt: text("visual_prompt").notNull(),
    referenceAssetId: uuid("reference_asset_id").references(() => assets.id, { onDelete: "set null" }),
    referenceStatus: unitStatus("reference_status").notNull().default("pending"),
    referenceError: text("reference_error"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("locations_project_key_uq").on(t.projectId, t.key)],
);

/** Voice identity per speaker (narrator or character). Keeps voices consistent. */
export const voices = pgTable(
  "voices",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    speakerKey: text("speaker_key").notNull(),
    characterId: uuid("character_id").references(() => characters.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerVoiceId: text("provider_voice_id").notNull(),
    settings: jsonb("settings").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("voices_project_speaker_uq").on(t.projectId, t.speakerKey)],
);

export const scenes = pgTable(
  "scenes",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    key: text("key").notNull(),
    title: text("title").notNull(),
    storyPurpose: text("story_purpose").notNull(),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
    timeOfDay: text("time_of_day").notNull(),
    environment: text("environment").notNull(),
    action: text("action").notNull(),
    emotion: text("emotion").notNull(),
    musicMood: text("music_mood").notNull(),
    characterKeys: text("character_keys").array().notNull().default(sql`'{}'::text[]`),
    estimatedDurationSec: doublePrecision("estimated_duration_sec").notNull(),
    /** Final scene length, derived from real voice durations. */
    timelineDurationSec: doublePrecision("timeline_duration_sec"),
    shotPlanStatus: unitStatus("shot_plan_status").notNull().default("pending"),
    shotPlanError: text("shot_plan_error"),
    musicStatus: unitStatus("music_status").notNull().default("pending"),
    musicAssetId: uuid("music_asset_id").references(() => assets.id, { onDelete: "set null" }),
    musicError: text("music_error"),
    previewAssetId: uuid("preview_asset_id").references(() => assets.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("scenes_project_seq_uq").on(t.projectId, t.sequence)],
);

/** Final approved narration/dialogue, stored before voice generation. */
export const dialogueLines = pgTable(
  "dialogue_lines",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sceneId: uuid("scene_id")
      .notNull()
      .references(() => scenes.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    kind: text("kind").$type<"narration" | "dialogue">().notNull(),
    speakerKey: text("speaker_key").notNull(),
    characterId: uuid("character_id").references(() => characters.id, { onDelete: "set null" }),
    originalText: text("original_text").notNull(),
    urduText: text("urdu_text").notNull(),
    englishText: text("english_text").notNull(),
    emotion: text("emotion").notNull(),
    approved: boolean("approved").notNull().default(false),
    voiceStatus: unitStatus("voice_status").notNull().default("pending"),
    voiceError: text("voice_error"),
    audioAssetId: uuid("audio_asset_id").references(() => assets.id, { onDelete: "set null" }),
    audioDurationSec: doublePrecision("audio_duration_sec"),
    /** Start offset of this line inside its scene, computed from real audio. */
    startOffsetSec: doublePrecision("start_offset_sec"),
    voiceProvider: text("voice_provider"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("lines_scene_seq_uq").on(t.sceneId, t.sequence), index("lines_project_idx").on(t.projectId)],
);

export const shots = pgTable(
  "shots",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sceneId: uuid("scene_id")
      .notNull()
      .references(() => scenes.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    key: text("key").notNull(),
    plannedDurationSec: doublePrecision("planned_duration_sec").notNull(),
    /** Duration requested from the video provider (provider-quantized). */
    generationDurationSec: doublePrecision("generation_duration_sec"),
    /** Exact on-timeline duration, derived from voice timing. */
    timelineDurationSec: doublePrecision("timeline_duration_sec"),
    prompt: text("prompt").notNull(),
    negativePrompt: text("negative_prompt").notNull(),
    characterKeys: text("character_keys").array().notNull().default(sql`'{}'::text[]`),
    locationKey: text("location_key"),
    camera: text("camera").notNull(),
    lighting: text("lighting").notNull(),
    action: text("action").notNull(),
    emotion: text("emotion").notNull(),
    visualEffects: text("visual_effects").notNull(),
    transition: text("transition").notNull(),
    audioRequirements: jsonb("audio_requirements").notNull(),
    speakingLineId: uuid("speaking_line_id").references(() => dialogueLines.id, { onDelete: "set null" }),

    keyframeStatus: unitStatus("keyframe_status").notNull().default("pending"),
    keyframeAssetId: uuid("keyframe_asset_id").references(() => assets.id, { onDelete: "set null" }),
    videoStatus: unitStatus("video_status").notNull().default("pending"),
    videoAssetId: uuid("video_asset_id").references(() => assets.id, { onDelete: "set null" }),
    lipsyncStatus: unitStatus("lipsync_status").notNull().default("pending"),
    lipsyncAssetId: uuid("lipsync_asset_id").references(() => assets.id, { onDelete: "set null" }),
    sfxStatus: unitStatus("sfx_status").notNull().default("pending"),
    sfxAssetId: uuid("sfx_asset_id").references(() => assets.id, { onDelete: "set null" }),
    qcStatus: unitStatus("qc_status").notNull().default("pending"),
    qcNotes: text("qc_notes"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    videoProvider: text("video_provider"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("shots_scene_seq_uq").on(t.sceneId, t.sequence),
    index("shots_project_idx").on(t.projectId),
    check("shots_planned_duration_positive", sql`${t.plannedDurationSec} > 0`),
  ],
);

export const assets = pgTable(
  "assets",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: assetKind("kind").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    mimeType: text("mime_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    durationSec: doublePrecision("duration_sec"),
    width: integer("width"),
    height: integer("height"),
    provider: text("provider"),
    providerModel: text("provider_model"),
    providerJobId: uuid("provider_job_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("assets_project_kind_idx").on(t.projectId, t.kind),
    check("assets_byte_size_positive", sql`${t.byteSize} > 0`),
  ],
);

export const audioTracks = pgTable(
  "audio_tracks",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sceneId: uuid("scene_id").references(() => scenes.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"voice_mix" | "music_bed" | "sfx_bed" | "final_mix">().notNull(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    durationSec: doublePrecision("duration_sec").notNull(),
    integratedLufs: doublePrecision("integrated_lufs"),
    truePeakDb: doublePrecision("true_peak_db"),
    createdAt: createdAt(),
  },
  (t) => [index("audio_tracks_project_idx").on(t.projectId)],
);

export const generationJobs = pgTable(
  "generation_jobs",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    run: integer("run").notNull(),
    stage: pipelineStage("stage").notNull(),
    status: jobStatus("status").notNull().default("QUEUED"),
    progress: doublePrecision("progress").notNull().default(0),
    totalUnits: integer("total_units").notNull().default(0),
    completedUnits: integer("completed_units").notNull().default(0),
    failedUnits: integer("failed_units").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    message: text("message"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("gen_jobs_project_run_stage_uq").on(t.projectId, t.run, t.stage),
    check("gen_jobs_progress_range", sql`${t.progress} >= 0 AND ${t.progress} <= 100`),
  ],
);

export const providerJobs = pgTable(
  "provider_jobs",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    generationJobId: uuid("generation_job_id").references(() => generationJobs.id, { onDelete: "set null" }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    capability: capability("capability").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    isFallback: boolean("is_fallback").notNull().default(false),
    externalId: text("external_id"),
    status: providerJobStatus("status").notNull().default("submitted"),
    attempt: integer("attempt").notNull().default(1),
    request: jsonb("request"),
    error: text("error"),
    errorCode: text("error_code"),
    costEstimated: doublePrecision("cost_estimated"),
    costActual: doublePrecision("cost_actual"),
    costUnit: text("cost_unit"),
    usage: jsonb("usage"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
  },
  (t) => [
    index("provider_jobs_entity_idx").on(t.entityType, t.entityId),
    index("provider_jobs_project_idx").on(t.projectId),
  ],
);

export const subtitles = pgTable(
  "subtitles",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    language: text("language").$type<"ur" | "en">().notNull(),
    format: text("format").$type<"srt" | "vtt">().notNull(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    cueCount: integer("cue_count").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("subtitles_project_lang_fmt_uq").on(t.projectId, t.language, t.format)],
);

export const renderJobs = pgTable(
  "render_jobs",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: jobStatus("status").notNull().default("RUNNING"),
    settings: jsonb("settings").notNull(),
    outputAssetId: uuid("output_asset_id").references(() => assets.id, { onDelete: "set null" }),
    thumbnailAssetId: uuid("thumbnail_asset_id").references(() => assets.id, { onDelete: "set null" }),
    durationSec: doublePrecision("duration_sec"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    assemblyMs: integer("assembly_ms"),
  },
  (t) => [index("render_jobs_project_idx").on(t.projectId)],
);

export const qualityChecks = pgTable(
  "quality_checks",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    renderJobId: uuid("render_job_id").references(() => renderJobs.id, { onDelete: "cascade" }),
    targetType: text("target_type").$type<"shot" | "line" | "music" | "sfx" | "final" | "subtitle">().notNull(),
    targetId: uuid("target_id"),
    check: text("check").notNull(),
    passed: boolean("passed").notNull(),
    severity: text("severity").$type<"error" | "warning" | "info">().notNull(),
    details: jsonb("details"),
    createdAt: createdAt(),
  },
  (t) => [index("quality_checks_project_idx").on(t.projectId)],
);

export const generationLogs = pgTable(
  "generation_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    level: text("level").$type<"info" | "warn" | "error">().notNull(),
    stage: pipelineStage("stage"),
    message: text("message").notNull(),
    context: jsonb("context"),
    createdAt: createdAt(),
  },
  (t) => [index("generation_logs_project_idx").on(t.projectId, t.id)],
);

export type Project = typeof projects.$inferSelect;
export type Scene = typeof scenes.$inferSelect;
export type Shot = typeof shots.$inferSelect;
export type DialogueLine = typeof dialogueLines.$inferSelect;
export type Character = typeof characters.$inferSelect;
export type Location = typeof locations.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type Voice = typeof voices.$inferSelect;
export type ProviderJob = typeof providerJobs.$inferSelect;
export type GenerationJob = typeof generationJobs.$inferSelect;
export type PipelineStage = (typeof pipelineStage.enumValues)[number];
export type ProjectStatus = (typeof projectStatus.enumValues)[number];
export type UnitStatus = (typeof unitStatus.enumValues)[number];
export type AssetKind = (typeof assetKind.enumValues)[number];
export type Capability = (typeof capability.enumValues)[number];
