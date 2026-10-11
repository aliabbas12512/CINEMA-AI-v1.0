import { describe, expect, it } from "vitest";
import { ProjectSettingsSchema, outputDimensions } from "@/lib/settings";
import {
  normalizeKey,
  PlanValidationError,
  SceneOutlineLlmSchema,
  ShotListLlmSchema,
  StoryBibleLlmSchema,
  validateSceneOutline,
  validateShotList,
  validateStoryBible,
} from "@/server/domain/schemas";
import { outline, shotList, storyBible } from "../mocks/providers";

describe("settings", () => {
  it("defaults match the product brief", () => {
    const s = ProjectSettingsSchema.parse({});
    expect(s).toMatchObject({
      targetDurationSec: 600,
      voiceLanguage: "ur",
      voiceAccent: "ur-PK",
      resolution: "1080p",
      aspectRatio: "16:9",
      visualStyle: "cinematic_fantasy",
    });
    expect(outputDimensions(s)).toEqual({ width: 1920, height: 1080 });
    expect(outputDimensions({ resolution: "2160p", aspectRatio: "16:9" })).toEqual({ width: 3840, height: 2160 });
  });
  it("rejects out-of-range values", () => {
    expect(ProjectSettingsSchema.safeParse({ targetDurationSec: 5 }).success).toBe(false);
    expect(ProjectSettingsSchema.safeParse({ voiceLanguage: "hi" }).success).toBe(false);
  });
});

describe("story bible validation", () => {
  it("accepts and normalizes a valid bible", () => {
    const raw = storyBible();
    raw.characters[0]!.character_id = "Prince Zain!";
    const parsed = StoryBibleLlmSchema.parse(raw);
    const v = validateStoryBible(parsed);
    expect(v.characters[0]!.character_id).toBe("prince_zain");
  });
  it("rejects duplicates and empty extraction", () => {
    const raw = storyBible();
    raw.characters.push({ ...raw.characters[0]! });
    expect(() => validateStoryBible(StoryBibleLlmSchema.parse(raw))).toThrow(PlanValidationError);
    expect(() => validateStoryBible({ ...storyBible(), characters: [] })).toThrow(/no characters/);
  });
  it("rejects malformed LLM output at the schema level", () => {
    expect(StoryBibleLlmSchema.safeParse({ title: "x" }).success).toBe(false);
  });
  it("normalizeKey produces safe ids", () => {
    expect(normalizeKey("  Pari  Noor ")).toBe("pari_noor");
    expect(normalizeKey("9 lives")).toMatch(/^k_/);
  });
});

describe("scene + shot validation", () => {
  const ctx = { characterIds: new Set(["prince_zain", "pari_noor"]), locationIds: new Set(["crystal_palace"]) };
  it("accepts a valid outline and forces narration speaker", () => {
    const o = SceneOutlineLlmSchema.parse(outline());
    o.scenes[0]!.lines[0]!.speaker = "Narrator Voice";
    const v = validateSceneOutline(o, ctx);
    expect(v.scenes[0]!.lines[0]!.speaker).toBe("narrator");
  });
  it("rejects unknown speakers / locations and empty Urdu", () => {
    const o = SceneOutlineLlmSchema.parse(outline());
    o.scenes[0]!.location_id = "nowhere";
    o.scenes[1]!.lines[0]!.speaker = "ghost";
    o.scenes[1]!.lines[0]!.urdu_text = " ";
    try {
      validateSceneOutline(o, ctx);
      expect.unreachable();
    } catch (e) {
      const issues = (e as PlanValidationError).issues.join("\n");
      expect(issues).toMatch(/unknown location/);
      expect(issues).toMatch(/unknown speaker/);
      expect(issues).toMatch(/empty Urdu/);
    }
  });
  it("clamps shot durations to provider bounds and drops bad lip-sync indexes", () => {
    const l = ShotListLlmSchema.parse(shotList());
    l.shots[0]!.duration_sec = 40;
    l.shots[1]!.speaking_line_index = 9;
    const v = validateShotList(l, { characterIds: ctx.characterIds, lineCount: 2, minShotSec: 5, maxShotSec: 10 });
    expect(v.shots[0]!.duration_sec).toBe(10);
    expect(v.shots[1]!.duration_sec).toBe(5);
    expect(v.shots[1]!.speaking_line_index).toBe(-1);
  });
});
