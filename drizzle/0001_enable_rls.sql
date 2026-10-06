-- Defense in depth for Supabase / shared Postgres deployments.
-- The application connects as the table OWNER, which bypasses RLS, and enforces
-- per-user authorization in the service layer. Enabling RLS with no policies
-- means any other role (e.g. Supabase "anon"/"authenticated" via PostgREST)
-- can read or write NOTHING in these tables.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scripts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "world_bibles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "characters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "character_references" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "locations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "voices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scenes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dialogue_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audio_tracks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "generation_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subtitles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "render_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quality_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "generation_logs" ENABLE ROW LEVEL SECURITY;
