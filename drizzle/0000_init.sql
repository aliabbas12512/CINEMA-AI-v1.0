CREATE TYPE "public"."asset_kind" AS ENUM('character_ref', 'location_ref', 'keyframe', 'shot_video', 'lipsync_video', 'voice_line', 'music', 'sfx', 'mix_audio', 'subtitle', 'scene_preview', 'final_video', 'thumbnail');--> statement-breakpoint
CREATE TYPE "public"."capability" AS ENUM('llm', 'image', 'video', 'voice', 'music', 'sfx', 'lipsync');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED');--> statement-breakpoint
CREATE TYPE "public"."pipeline_stage" AS ENUM('ANALYZING', 'PLANNING', 'GENERATING_VOICE', 'GENERATING_CHARACTERS', 'GENERATING_SCENES', 'GENERATING_VIDEO', 'GENERATING_AUDIO', 'ASSEMBLING', 'QUALITY_CHECK');--> statement-breakpoint
CREATE TYPE "public"."project_control" AS ENUM('none', 'pause_requested', 'cancel_requested');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('DRAFT', 'QUEUED', 'ANALYZING', 'PLANNING', 'GENERATING_VOICE', 'GENERATING_CHARACTERS', 'GENERATING_SCENES', 'GENERATING_VIDEO', 'GENERATING_AUDIO', 'ASSEMBLING', 'QUALITY_CHECK', 'COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED');--> statement-breakpoint
CREATE TYPE "public"."provider_job_status" AS ENUM('submitted', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."unit_status" AS ENUM('pending', 'running', 'completed', 'failed', 'skipped', 'unavailable');--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"duration_sec" double precision,
	"width" integer,
	"height" integer,
	"provider" text,
	"provider_model" text,
	"provider_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "assets_byte_size_positive" CHECK ("assets"."byte_size" > 0)
);
--> statement-breakpoint
CREATE TABLE "audio_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"scene_id" uuid,
	"kind" text NOT NULL,
	"asset_id" uuid NOT NULL,
	"duration_sec" double precision NOT NULL,
	"integrated_lufs" double precision,
	"true_peak_db" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"age" text NOT NULL,
	"gender" text NOT NULL,
	"appearance" text NOT NULL,
	"face" text NOT NULL,
	"hair" text NOT NULL,
	"eyes" text NOT NULL,
	"skin_tone" text NOT NULL,
	"body_type" text NOT NULL,
	"clothing" text NOT NULL,
	"accessories" text NOT NULL,
	"weapons" text NOT NULL,
	"personality" text NOT NULL,
	"voice_profile" jsonb NOT NULL,
	"visual_prompt" text NOT NULL,
	"reference_status" "unit_status" DEFAULT 'pending' NOT NULL,
	"reference_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dialogue_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"scene_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"speaker_key" text NOT NULL,
	"character_id" uuid,
	"original_text" text NOT NULL,
	"urdu_text" text NOT NULL,
	"english_text" text NOT NULL,
	"emotion" text NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"voice_status" "unit_status" DEFAULT 'pending' NOT NULL,
	"voice_error" text,
	"audio_asset_id" uuid,
	"audio_duration_sec" double precision,
	"start_offset_sec" double precision,
	"voice_provider" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"run" integer NOT NULL,
	"stage" "pipeline_stage" NOT NULL,
	"status" "job_status" DEFAULT 'QUEUED' NOT NULL,
	"progress" double precision DEFAULT 0 NOT NULL,
	"total_units" integer DEFAULT 0 NOT NULL,
	"completed_units" integer DEFAULT 0 NOT NULL,
	"failed_units" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"message" text,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gen_jobs_progress_range" CHECK ("generation_jobs"."progress" >= 0 AND "generation_jobs"."progress" <= 100)
);
--> statement-breakpoint
CREATE TABLE "generation_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"level" text NOT NULL,
	"stage" "pipeline_stage",
	"message" text NOT NULL,
	"context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"description" text NOT NULL,
	"architecture" text NOT NULL,
	"climate" text NOT NULL,
	"visual_prompt" text NOT NULL,
	"reference_asset_id" uuid,
	"reference_status" "unit_status" DEFAULT 'pending' NOT NULL,
	"reference_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "project_status" DEFAULT 'DRAFT' NOT NULL,
	"current_stage" "pipeline_stage",
	"control" "project_control" DEFAULT 'none' NOT NULL,
	"settings" jsonb NOT NULL,
	"error" text,
	"run_count" integer DEFAULT 0 NOT NULL,
	"qc_regenerations" integer DEFAULT 0 NOT NULL,
	"final_asset_id" uuid,
	"thumbnail_asset_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"generation_job_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"capability" "capability" NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"is_fallback" boolean DEFAULT false NOT NULL,
	"external_id" text,
	"status" "provider_job_status" DEFAULT 'submitted' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"request" jsonb,
	"error" text,
	"error_code" text,
	"cost_estimated" double precision,
	"cost_actual" double precision,
	"cost_unit" text,
	"usage" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "quality_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"render_job_id" uuid,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"check" text NOT NULL,
	"passed" boolean NOT NULL,
	"severity" text NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "render_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" "job_status" DEFAULT 'RUNNING' NOT NULL,
	"settings" jsonb NOT NULL,
	"output_asset_id" uuid,
	"thumbnail_asset_id" uuid,
	"duration_sec" double precision,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"assembly_ms" integer
);
--> statement-breakpoint
CREATE TABLE "scenes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"story_purpose" text NOT NULL,
	"location_id" uuid,
	"time_of_day" text NOT NULL,
	"environment" text NOT NULL,
	"action" text NOT NULL,
	"emotion" text NOT NULL,
	"music_mood" text NOT NULL,
	"character_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"estimated_duration_sec" double precision NOT NULL,
	"timeline_duration_sec" double precision,
	"shot_plan_status" "unit_status" DEFAULT 'pending' NOT NULL,
	"shot_plan_error" text,
	"music_status" "unit_status" DEFAULT 'pending' NOT NULL,
	"music_asset_id" uuid,
	"music_error" text,
	"preview_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"language_detected" text,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"scene_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"key" text NOT NULL,
	"planned_duration_sec" double precision NOT NULL,
	"generation_duration_sec" double precision,
	"timeline_duration_sec" double precision,
	"prompt" text NOT NULL,
	"negative_prompt" text NOT NULL,
	"character_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"location_key" text,
	"camera" text NOT NULL,
	"lighting" text NOT NULL,
	"action" text NOT NULL,
	"emotion" text NOT NULL,
	"visual_effects" text NOT NULL,
	"transition" text NOT NULL,
	"audio_requirements" jsonb NOT NULL,
	"speaking_line_id" uuid,
	"keyframe_status" "unit_status" DEFAULT 'pending' NOT NULL,
	"keyframe_asset_id" uuid,
	"video_status" "unit_status" DEFAULT 'pending' NOT NULL,
	"video_asset_id" uuid,
	"lipsync_status" "unit_status" DEFAULT 'pending' NOT NULL,
	"lipsync_asset_id" uuid,
	"sfx_status" "unit_status" DEFAULT 'pending' NOT NULL,
	"sfx_asset_id" uuid,
	"qc_status" "unit_status" DEFAULT 'pending' NOT NULL,
	"qc_notes" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"video_provider" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shots_planned_duration_positive" CHECK ("shots"."planned_duration_sec" > 0)
);
--> statement-breakpoint
CREATE TABLE "subtitles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"language" text NOT NULL,
	"format" text NOT NULL,
	"asset_id" uuid NOT NULL,
	"cue_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "voices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"speaker_key" text NOT NULL,
	"character_id" uuid,
	"provider" text NOT NULL,
	"provider_voice_id" text NOT NULL,
	"settings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world_bibles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"script_id" uuid NOT NULL,
	"story" jsonb NOT NULL,
	"world" jsonb NOT NULL,
	"style_guide" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "world_bibles_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_tracks" ADD CONSTRAINT "audio_tracks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_tracks" ADD CONSTRAINT "audio_tracks_scene_id_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_tracks" ADD CONSTRAINT "audio_tracks_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_references" ADD CONSTRAINT "character_references_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_references" ADD CONSTRAINT "character_references_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialogue_lines" ADD CONSTRAINT "dialogue_lines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialogue_lines" ADD CONSTRAINT "dialogue_lines_scene_id_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialogue_lines" ADD CONSTRAINT "dialogue_lines_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialogue_lines" ADD CONSTRAINT "dialogue_lines_audio_asset_id_assets_id_fk" FOREIGN KEY ("audio_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_logs" ADD CONSTRAINT "generation_logs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_reference_asset_id_assets_id_fk" FOREIGN KEY ("reference_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_jobs" ADD CONSTRAINT "provider_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_jobs" ADD CONSTRAINT "provider_jobs_generation_job_id_generation_jobs_id_fk" FOREIGN KEY ("generation_job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_render_job_id_render_jobs_id_fk" FOREIGN KEY ("render_job_id") REFERENCES "public"."render_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_output_asset_id_assets_id_fk" FOREIGN KEY ("output_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_thumbnail_asset_id_assets_id_fk" FOREIGN KEY ("thumbnail_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_music_asset_id_assets_id_fk" FOREIGN KEY ("music_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_preview_asset_id_assets_id_fk" FOREIGN KEY ("preview_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shots" ADD CONSTRAINT "shots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shots" ADD CONSTRAINT "shots_scene_id_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shots" ADD CONSTRAINT "shots_speaking_line_id_dialogue_lines_id_fk" FOREIGN KEY ("speaking_line_id") REFERENCES "public"."dialogue_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shots" ADD CONSTRAINT "shots_keyframe_asset_id_assets_id_fk" FOREIGN KEY ("keyframe_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shots" ADD CONSTRAINT "shots_video_asset_id_assets_id_fk" FOREIGN KEY ("video_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shots" ADD CONSTRAINT "shots_lipsync_asset_id_assets_id_fk" FOREIGN KEY ("lipsync_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shots" ADD CONSTRAINT "shots_sfx_asset_id_assets_id_fk" FOREIGN KEY ("sfx_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtitles" ADD CONSTRAINT "subtitles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtitles" ADD CONSTRAINT "subtitles_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voices" ADD CONSTRAINT "voices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voices" ADD CONSTRAINT "voices_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_bibles" ADD CONSTRAINT "world_bibles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_bibles" ADD CONSTRAINT "world_bibles_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_project_kind_idx" ON "assets" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "audio_tracks_project_idx" ON "audio_tracks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "character_refs_character_idx" ON "character_references" USING btree ("character_id");--> statement-breakpoint
CREATE UNIQUE INDEX "characters_project_key_uq" ON "characters" USING btree ("project_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "lines_scene_seq_uq" ON "dialogue_lines" USING btree ("scene_id","sequence");--> statement-breakpoint
CREATE INDEX "lines_project_idx" ON "dialogue_lines" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gen_jobs_project_run_stage_uq" ON "generation_jobs" USING btree ("project_id","run","stage");--> statement-breakpoint
CREATE INDEX "generation_logs_project_idx" ON "generation_logs" USING btree ("project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "locations_project_key_uq" ON "locations" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "projects_user_idx" ON "projects" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "provider_jobs_entity_idx" ON "provider_jobs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "provider_jobs_project_idx" ON "provider_jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "quality_checks_project_idx" ON "quality_checks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "render_jobs_project_idx" ON "render_jobs" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scenes_project_seq_uq" ON "scenes" USING btree ("project_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "scripts_project_version_uq" ON "scripts" USING btree ("project_id","version");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shots_scene_seq_uq" ON "shots" USING btree ("scene_id","sequence");--> statement-breakpoint
CREATE INDEX "shots_project_idx" ON "shots" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subtitles_project_lang_fmt_uq" ON "subtitles" USING btree ("project_id","language","format");--> statement-breakpoint
CREATE UNIQUE INDEX "voices_project_speaker_uq" ON "voices" USING btree ("project_id","speaker_key");