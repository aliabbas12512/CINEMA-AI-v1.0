import { z } from "zod";

/**
 * Structured contracts between the LLM and the rest of the pipeline.
 *
 * The *LLM schemas* are deliberately constraint-light (no min/max) because
 * structured-output JSON Schema support is narrower than Zod. Semantic rules
 * (unique keys, valid references, sane durations) are enforced afterwards in
 * `validate*` functions; downstream code only ever sees validated data.
 */

export const CAMERA_SHOTS = [
  "establishing",
  "wide",
  "medium",
  "close_up",
  "extreme_close_up",
  "over_the_shoulder",
  "tracking",
  "aerial",
  "pov",
  "low_angle",
  "high_angle",
  "dolly_in",
  "crane",
  "orbit",
] as const;

export const TRANSITIONS = ["cut", "fade", "dissolve", "dip_to_black"] as const;

const VoiceProfileSchema = z.object({
  gender: z.enum(["male", "female", "neutral"]),
  age_group: z.enum(["child", "young_adult", "adult", "elder"]),
  timbre: z.string().describe("e.g. deep and warm, bright, raspy"),
  delivery: z.string().describe("speaking style: calm, commanding, playful ..."),
});

const CharacterSchema = z.object({
  character_id: z.string().describe("stable snake_case id, e.g. prince_zain"),
  name: z.string(),
  role: z.string().describe("protagonist, antagonist, mentor, supporting, creature ..."),
  age: z.string(),
  gender: z.string(),
  appearance: z.string(),
  face_description: z.string(),
  hair: z.string(),
  eyes: z.string(),
  skin_tone: z.string(),
  body_type: z.string(),
  clothing: z.string(),
  accessories: z.string(),
  weapons: z.string().describe("'none' if not applicable"),
  personality: z.string(),
  voice_profile: VoiceProfileSchema,
  visual_reference_prompt: z
    .string()
    .describe("English, self-contained visual description for a full-body character reference image"),
});

const LocationSchema = z.object({
  location_id: z.string().describe("stable snake_case id"),
  name: z.string(),
  type: z.string().describe("kingdom, city, castle, village, forest, mountain, river, magical place ..."),
  description: z.string(),
  architecture: z.string(),
  climate: z.string(),
  visual_reference_prompt: z.string().describe("English, self-contained environment description, no characters"),
});

export const StoryBibleLlmSchema = z.object({
  title: z.string(),
  genre: z.string(),
  logline: z.string(),
  plot_summary: z.string(),
  source_language: z.enum(["english", "urdu", "roman_urdu", "mixed"]),
  themes: z.array(z.string()),
  timeline: z.array(z.object({ order: z.number(), event: z.string() })),
  characters: z.array(CharacterSchema),
  locations: z.array(LocationSchema),
  important_objects: z.array(z.object({ name: z.string(), description: z.string() })),
  creatures: z.array(z.object({ name: z.string(), description: z.string() })),
  important_visual_events: z.array(z.string()),
  world: z.object({
    era_and_setting: z.string(),
    architecture_style: z.string(),
    climate: z.string(),
    recurring_props: z.array(z.string()),
    environmental_style: z.string(),
    color_palette: z.string(),
  }),
});
export type StoryBible = z.infer<typeof StoryBibleLlmSchema>;

const LineSchema = z.object({
  kind: z.enum(["narration", "dialogue"]),
  speaker: z.string().describe("'narrator' for narration, otherwise a character_id"),
  original_text: z.string().describe("the line exactly as in the source script (any language)"),
  urdu_text: z
    .string()
    .describe("natural spoken Pakistani Urdu in Urdu (Nastaliq) script; meaning preserved"),
  english_text: z.string().describe("faithful English translation for subtitles"),
  emotion: z.string(),
});

export const SceneOutlineLlmSchema = z.object({
  scenes: z.array(
    z.object({
      scene_id: z.string(),
      title: z.string(),
      story_purpose: z.string(),
      location_id: z.string(),
      time_of_day: z.string(),
      characters: z.array(z.string()),
      environment: z.string(),
      action: z.string(),
      emotion: z.string(),
      music_mood: z.enum(["adventure", "mystery", "emotional", "battle", "magic", "peaceful", "triumphant", "dark"]),
      estimated_duration_sec: z.number(),
      lines: z.array(LineSchema),
    }),
  ),
});
export type SceneOutline = z.infer<typeof SceneOutlineLlmSchema>;

export const ShotListLlmSchema = z.object({
  shots: z.array(
    z.object({
      shot_id: z.string(),
      duration_sec: z.number(),
      camera: z.enum(CAMERA_SHOTS),
      camera_movement: z.string().describe("motivated movement, or 'static'"),
      characters: z.array(z.string()),
      action: z.string(),
      emotion: z.string(),
      lighting: z.string(),
      visual_effects: z.string(),
      transition_in: z.enum(TRANSITIONS),
      speaking_line_index: z
        .number()
        .describe("0-based index into the scene's lines spoken on camera with visible face, or -1"),
      keyframe_prompt: z.string().describe("English still-image prompt for the first frame"),
      motion_prompt: z.string().describe("English prompt describing motion/camera over the clip"),
      negative_prompt: z.string(),
      sfx: z.array(z.object({ description: z.string(), at_sec: z.number(), duration_sec: z.number() })),
      ambience: z.string(),
    }),
  ),
});
export type ShotList = z.infer<typeof ShotListLlmSchema>;

// ------------------------------------------------------------- validation

export class PlanValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Plan validation failed: ${issues.slice(0, 8).join("; ")}`);
    this.name = "PlanValidationError";
  }
}

const KEY_RE = /^[a-z][a-z0-9_]{1,62}$/;

export function normalizeKey(raw: string): string {
  const k = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 62);
  return KEY_RE.test(k) ? k : `k_${k || "item"}`.slice(0, 62);
}

/** Normalizes ids and checks invariants. Returns a cleaned copy. */
export function validateStoryBible(input: StoryBible): StoryBible {
  const issues: string[] = [];
  const bible: StoryBible = structuredClone(input);
  if (!bible.title.trim()) issues.push("title is empty");
  if (bible.characters.length === 0) issues.push("no characters extracted");
  if (bible.locations.length === 0) issues.push("no locations extracted");

  const seenChars = new Set<string>();
  for (const c of bible.characters) {
    c.character_id = normalizeKey(c.character_id || c.name);
    if (c.character_id === "narrator") c.character_id = "char_narrator";
    if (seenChars.has(c.character_id)) issues.push(`duplicate character_id ${c.character_id}`);
    seenChars.add(c.character_id);
    if (!c.visual_reference_prompt.trim()) issues.push(`character ${c.character_id} has no visual prompt`);
  }
  const seenLocs = new Set<string>();
  for (const l of bible.locations) {
    l.location_id = normalizeKey(l.location_id || l.name);
    if (seenLocs.has(l.location_id)) issues.push(`duplicate location_id ${l.location_id}`);
    seenLocs.add(l.location_id);
  }
  if (issues.length) throw new PlanValidationError(issues);
  return bible;
}

export function validateSceneOutline(
  outline: SceneOutline,
  ctx: { characterIds: Set<string>; locationIds: Set<string> },
): SceneOutline {
  const issues: string[] = [];
  const out: SceneOutline = structuredClone(outline);
  if (out.scenes.length === 0) issues.push("no scenes planned");
  const seen = new Set<string>();
  out.scenes.forEach((s, i) => {
    s.scene_id = normalizeKey(s.scene_id || `scene_${i + 1}`);
    if (seen.has(s.scene_id)) s.scene_id = `${s.scene_id}_${i + 1}`;
    seen.add(s.scene_id);
    s.location_id = normalizeKey(s.location_id);
    if (!ctx.locationIds.has(s.location_id)) issues.push(`scene ${s.scene_id} references unknown location ${s.location_id}`);
    s.characters = s.characters.map(normalizeKey).filter((c) => ctx.characterIds.has(c));
    if (!(s.estimated_duration_sec > 0)) issues.push(`scene ${s.scene_id} has non-positive duration`);
    s.lines.forEach((l, j) => {
      l.speaker = normalizeKey(l.speaker);
      if (l.kind === "narration") l.speaker = "narrator";
      if (l.kind === "dialogue" && !ctx.characterIds.has(l.speaker)) {
        issues.push(`scene ${s.scene_id} line ${j} has unknown speaker ${l.speaker}`);
      }
      if (!l.urdu_text.trim()) issues.push(`scene ${s.scene_id} line ${j} has empty Urdu text`);
    });
  });
  if (issues.length) throw new PlanValidationError(issues);
  return out;
}

export function validateShotList(
  list: ShotList,
  ctx: { characterIds: Set<string>; lineCount: number; minShotSec: number; maxShotSec: number },
): ShotList {
  const issues: string[] = [];
  const out: ShotList = structuredClone(list);
  if (out.shots.length === 0) issues.push("scene has no shots");
  out.shots.forEach((s, i) => {
    s.shot_id = normalizeKey(s.shot_id || `shot_${i + 1}`);
    s.characters = s.characters.map(normalizeKey).filter((c) => ctx.characterIds.has(c));
    if (!Number.isFinite(s.duration_sec)) issues.push(`shot ${i} has invalid duration`);
    s.duration_sec = Math.min(ctx.maxShotSec, Math.max(ctx.minShotSec, s.duration_sec));
    if (!Number.isInteger(s.speaking_line_index) || s.speaking_line_index >= ctx.lineCount) {
      s.speaking_line_index = -1;
    }
    if (!s.keyframe_prompt.trim()) issues.push(`shot ${i} has empty keyframe prompt`);
    s.sfx = s.sfx.filter((x) => x.description.trim().length > 0 && x.duration_sec > 0);
  });
  if (issues.length) throw new PlanValidationError(issues);
  return out;
}
