import { z } from "zod";

/**
 * Project settings shared by the client form and the server API.
 * Contains no secrets - safe to import from client components.
 */

export const VISUAL_STYLES = [
  "cinematic_fantasy",
  "dark_fantasy",
  "fairy_tale",
  "epic_adventure",
  "magical_kingdom",
  "anime_fantasy",
  "family_fantasy",
] as const;

export const VISUAL_STYLE_LABELS: Record<(typeof VISUAL_STYLES)[number], string> = {
  cinematic_fantasy: "Cinematic Fantasy",
  dark_fantasy: "Dark Fantasy",
  fairy_tale: "Fairy Tale",
  epic_adventure: "Epic Adventure",
  magical_kingdom: "Magical Kingdom",
  anime_fantasy: "Anime Fantasy",
  family_fantasy: "Family Fantasy",
};

export const MUSIC_STYLES = [
  "auto",
  "epic_orchestral",
  "dark_atmospheric",
  "soft_strings",
  "battle_percussion",
  "ethereal_magic",
] as const;

export const MUSIC_STYLE_LABELS: Record<(typeof MUSIC_STYLES)[number], string> = {
  auto: "Automatic (per scene mood)",
  epic_orchestral: "Epic orchestral fantasy",
  dark_atmospheric: "Dark atmospheric",
  soft_strings: "Soft cinematic strings",
  battle_percussion: "Dramatic battle percussion",
  ethereal_magic: "Ethereal magical textures",
};

export const NARRATOR_VOICES = ["male", "female"] as const;
export const SUBTITLE_LANGUAGES = ["off", "ur", "en"] as const;
export const RESOLUTIONS = ["1080p", "2160p"] as const;
export const ASPECT_RATIOS = ["16:9", "9:16"] as const;

export const ProjectSettingsSchema = z.object({
  targetDurationSec: z.number().int().min(30).max(1200).default(600),
  visualStyle: z.enum(VISUAL_STYLES).default("cinematic_fantasy"),
  voiceLanguage: z.literal("ur").default("ur"),
  voiceAccent: z.literal("ur-PK").default("ur-PK"),
  narratorVoice: z.enum(NARRATOR_VOICES).default("male"),
  subtitleLanguage: z.enum(SUBTITLE_LANGUAGES).default("ur"),
  burnSubtitles: z.boolean().default(false),
  resolution: z.enum(RESOLUTIONS).default("1080p"),
  aspectRatio: z.enum(ASPECT_RATIOS).default("16:9"),
  fps: z.union([z.literal(24), z.literal(30)]).default(24),
  musicStyle: z.enum(MUSIC_STYLES).default("auto"),
  lipSync: z.boolean().default(true),
});

export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const DEFAULT_SETTINGS: ProjectSettings = ProjectSettingsSchema.parse({});

export function outputDimensions(settings: Pick<ProjectSettings, "resolution" | "aspectRatio">): {
  width: number;
  height: number;
} {
  const long = settings.resolution === "2160p" ? 3840 : 1920;
  const short = settings.resolution === "2160p" ? 2160 : 1080;
  return settings.aspectRatio === "16:9" ? { width: long, height: short } : { width: short, height: long };
}

export const CreateProjectSchema = z.object({
  title: z.string().trim().max(200).optional(),
  script: z.string().trim().min(200, "Script must be at least 200 characters").max(500_000),
  settings: ProjectSettingsSchema.partial().default({}),
});

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;
