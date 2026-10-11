/**
 * TEST-ONLY provider doubles. They are never imported by production code.
 * They produce REAL media files with FFmpeg so the downstream pipeline
 * (probing, QC, assembly) is exercised for real.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { z } from "zod";
import { SceneOutlineLlmSchema, ShotListLlmSchema, StoryBibleLlmSchema } from "@/server/domain/schemas";
import { ffmpeg } from "@/server/media/ffmpeg";
import { ProviderError } from "@/server/providers/errors";
import type {
  GenerationResult,
  ImageProvider,
  ImageRequest,
  LipSyncProvider,
  LipSyncRequest,
  LlmProvider,
  MusicProvider,
  MusicRequest,
  ProviderSet,
  SfxProvider,
  SfxRequest,
  SpeakerProfile,
  TaskStatus,
  VideoProvider,
  VideoRequest,
  VoiceProvider,
  VoiceRequest,
} from "@/server/providers/types";

async function render(args: string[], ext: string): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "afs-mock-"));
  try {
    const out = path.join(dir, `out.${ext}`);
    await ffmpeg([...args, out]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export class MockLlm implements LlmProvider {
  readonly info = { id: "mock-llm", displayName: "Mock LLM", capability: "llm" as const, model: "mock" };
  calls = 0;
  async validate() {
    return { ok: true, message: "mock" };
  }
  async generateStructured<S extends z.ZodType>(args: { schema: S }): Promise<{ data: z.infer<S>; usage: { inputTokens: number; outputTokens: number } }> {
    this.calls++;
    const usage = { inputTokens: 1000, outputTokens: 500 };
    if (args.schema === (StoryBibleLlmSchema as unknown)) return { data: storyBible() as z.infer<S>, usage };
    if (args.schema === (SceneOutlineLlmSchema as unknown)) return { data: outline() as z.infer<S>, usage };
    if (args.schema === (ShotListLlmSchema as unknown)) return { data: shotList() as z.infer<S>, usage };
    throw new Error("unexpected schema");
  }
}

function character(id: string, name: string, gender: "male" | "female") {
  return {
    character_id: id,
    name,
    role: "protagonist",
    age: "20",
    gender,
    appearance: "tall",
    face_description: "kind face",
    hair: "black",
    eyes: "brown",
    skin_tone: "warm brown",
    body_type: "athletic",
    clothing: "royal blue sherwani",
    accessories: "silver ring",
    weapons: "none",
    personality: "brave",
    voice_profile: { gender, age_group: "young_adult" as const, timbre: "warm", delivery: "calm" },
    visual_reference_prompt: `${name}, a young hero in a royal blue sherwani`,
  };
}

export function storyBible() {
  return {
    title: "Shehzada aur Jadui Chiragh",
    genre: "fantasy",
    logline: "A prince finds a magic lamp.",
    plot_summary: "A prince finds a lamp and saves the kingdom.",
    source_language: "roman_urdu" as const,
    themes: ["courage"],
    timeline: [{ order: 1, event: "Prince finds lamp" }],
    characters: [character("prince_zain", "Shehzada Zain", "male"), character("pari_noor", "Pari Noor", "female")],
    locations: [
      {
        location_id: "crystal_palace",
        name: "Crystal Palace",
        type: "castle",
        description: "A palace of crystal",
        architecture: "Mughal crystal domes",
        climate: "temperate",
        visual_reference_prompt: "Crystal palace with Mughal domes at dusk",
      },
    ],
    important_objects: [{ name: "lamp", description: "golden lamp" }],
    creatures: [],
    important_visual_events: ["lamp glows"],
    world: {
      era_and_setting: "mythic",
      architecture_style: "Mughal",
      climate: "temperate",
      recurring_props: ["lamp"],
      environmental_style: "lush",
      color_palette: "gold and blue",
    },
  };
}

function line(kind: "narration" | "dialogue", speaker: string, ur: string, en: string) {
  return { kind, speaker, original_text: en, urdu_text: ur, english_text: en, emotion: "calm" };
}

export function outline() {
  return {
    scenes: [
      {
        scene_id: "scene_1",
        title: "The palace",
        story_purpose: "Introduce the prince",
        location_id: "crystal_palace",
        time_of_day: "dusk",
        characters: ["prince_zain"],
        environment: "glowing halls",
        action: "prince walks",
        emotion: "wonder",
        music_mood: "magic" as const,
        estimated_duration_sec: 6,
        lines: [
          line("narration", "narrator", "ایک زمانے کی بات ہے۔", "Once upon a time."),
          line("dialogue", "prince_zain", "یہ چراغ کیسا ہے؟", "What is this lamp?"),
        ],
      },
      {
        scene_id: "scene_2",
        title: "The fairy",
        story_purpose: "Fairy appears",
        location_id: "crystal_palace",
        time_of_day: "night",
        characters: ["prince_zain", "pari_noor"],
        environment: "moonlit balcony",
        action: "fairy appears",
        emotion: "awe",
        music_mood: "emotional" as const,
        estimated_duration_sec: 6,
        lines: [line("dialogue", "pari_noor", "میں تمہاری مدد کروں گی۔", "I will help you.")],
      },
    ],
  };
}

export function shotList() {
  const shot = (id: string, speaking: number) => ({
    shot_id: id,
    duration_sec: 3,
    camera: "medium" as const,
    camera_movement: "slow dolly in",
    characters: ["prince_zain"],
    action: "looks at lamp",
    emotion: "wonder",
    lighting: "warm candle light",
    visual_effects: "dust motes",
    transition_in: "cut" as const,
    speaking_line_index: speaking,
    keyframe_prompt: "Prince holding a golden lamp",
    motion_prompt: "Lamp glows brighter, camera pushes in",
    negative_prompt: "blurry, text",
    sfx: [{ description: "magic shimmer", at_sec: 1, duration_sec: 1 }],
    ambience: "quiet palace hall",
  });
  return { shots: [shot("shot_1", -1), shot("shot_2", 0)] };
}

type TaskRec = { state: TaskStatus["state"]; polls: number; output?: Buffer; ext: string; error?: string; code?: string };

abstract class MockAsync<Req> {
  tasks = new Map<string, TaskRec>();
  submits: Req[] = [];
  cancelled: string[] = [];
  private n = 0;
  /** polls required before a task completes */
  pollsToFinish = 1;
  async validate() {
    return { ok: true, message: "mock" };
  }
  protected abstract produce(req: Req): Promise<{ data: Buffer; ext: string } | { error: string; code?: string }>;
  async submit(req: Req) {
    this.submits.push(req);
    const id = `task-${++this.n}`;
    const out = await this.produce(req);
    if ("error" in out) this.tasks.set(id, { state: "running", polls: 0, ext: "", error: out.error, code: out.code });
    else this.tasks.set(id, { state: "running", polls: 0, output: out.data, ext: out.ext });
    return { externalId: id, estimatedCost: { amount: 5, unit: "credits" } };
  }
  async getStatus(id: string): Promise<TaskStatus> {
    const t = this.tasks.get(id);
    if (!t) throw new ProviderError({ provider: "mock", message: "unknown task", retryable: false, status: 404 });
    if (t.state === "cancelled") return { externalId: id, state: "cancelled" };
    t.polls++;
    if (t.polls < this.pollsToFinish) return { externalId: id, state: "running", progress: t.polls / this.pollsToFinish };
    if (t.error) return { externalId: id, state: "failed", error: t.error, errorCode: t.code, cost: { amount: 0, unit: "credits" } };
    return { externalId: id, state: "succeeded", outputUrls: [`mock://${id}`], cost: { amount: 5, unit: "credits" } };
  }
  async download(status: TaskStatus): Promise<GenerationResult> {
    const t = this.tasks.get(status.externalId)!;
    const mime = t.ext === "png" ? "image/png" : "video/mp4";
    return { data: t.output!, ext: t.ext, mimeType: mime, cost: status.cost };
  }
  async cancel(id: string) {
    this.cancelled.push(id);
    const t = this.tasks.get(id);
    if (t) t.state = "cancelled";
  }
}

export class MockImage extends MockAsync<ImageRequest> implements ImageProvider {
  readonly info = { id: "mock-image", displayName: "Mock Image", capability: "image" as const, model: "mock" };
  readonly maxReferences = 3;
  readonly maxPromptLength = 1000;
  protected async produce(req: ImageRequest) {
    const size = req.aspect === "9:16" ? "540x960" : req.aspect === "1:1" ? "720x720" : "960x540";
    const data = await render(["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=1`, "-frames:v", "1"], "png");
    return { data, ext: "png" };
  }
}

export class MockVideo extends MockAsync<VideoRequest> implements VideoProvider {
  readonly info: { id: string; displayName: string; capability: "video"; model: string };
  readonly capabilities = { durations: [2, 3, 4, 5, 6, 7, 8, 9, 10], maxPromptLength: 1000, supportsNegativePrompt: false, nativeWidth: 1280, nativeHeight: 720 };
  /** Substring of prompt -> behaviour */
  failPermanently = new Set<string>();
  failTransientTimes = 0;
  produceBlackOnce = false;
  constructor(id = "mock-video") {
    super();
    this.info = { id, displayName: `Mock Video ${id}`, capability: "video", model: "mock" };
  }
  override async submit(req: VideoRequest) {
    if (this.failTransientTimes > 0) {
      this.failTransientTimes--;
      throw new ProviderError({ provider: this.info.id, message: "503 temporarily unavailable", retryable: true, status: 503 });
    }
    return super.submit(req);
  }
  protected async produce(req: VideoRequest) {
    for (const f of this.failPermanently) {
      if (req.prompt.includes(f)) return { error: "Content moderation rejected input", code: "SAFETY.INPUT.TEXT" };
    }
    if (this.produceBlackOnce) {
      this.produceBlackOnce = false;
      const data = await render(["-f", "lavfi", "-i", `color=c=black:s=1280x720:r=24:d=${req.durationSec}`, "-c:v", "libx264", "-pix_fmt", "yuv420p"], "mp4");
      return { data, ext: "mp4" };
    }
    const data = await render(["-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=24:duration=${req.durationSec}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast"], "mp4");
    return { data, ext: "mp4" };
  }
}

export class MockLipSync extends MockAsync<LipSyncRequest> implements LipSyncProvider {
  readonly info = { id: "mock-lipsync", displayName: "Mock Lipsync", capability: "lipsync" as const, model: "mock" };
  protected async produce(req: LipSyncRequest) {
    return { data: req.video.data, ext: "mp4" };
  }
}

async function toneFor(seconds: number, freq: number, ext: "wav" | "mp3"): Promise<Buffer> {
  const codec = ext === "mp3" ? ["-c:a", "libmp3lame", "-b:a", "128k"] : ["-c:a", "pcm_s16le"];
  return render(["-f", "lavfi", "-i", `sine=frequency=${freq}:sample_rate=48000:duration=${seconds.toFixed(2)}`, ...codec], ext);
}

export class MockVoice implements VoiceProvider {
  readonly info: { id: string; displayName: string; capability: "voice"; model: string };
  readonly locales = ["ur-PK"];
  calls: VoiceRequest[] = [];
  failAll = false;
  constructor(id = "mock-voice") {
    this.info = { id, displayName: `Mock Voice ${id}`, capability: "voice", model: "mock" };
  }
  async validate() {
    return { ok: true, message: "mock" };
  }
  assignVoice(p: SpeakerProfile, index: number) {
    return { providerVoiceId: `${p.role}-${p.gender}-${index}`, settings: { pitch: "+0%" } };
  }
  async generate(req: VoiceRequest): Promise<GenerationResult> {
    this.calls.push(req);
    if (this.failAll) throw new ProviderError({ provider: this.info.id, message: "401 invalid key", retryable: false, status: 401 });
    const secs = Math.max(0.8, req.text.length * 0.08);
    return { data: await toneFor(secs, 300 + (this.calls.length % 5) * 60, "wav"), mimeType: "audio/wav", ext: "wav", usage: { characters: req.text.length } };
  }
}

export class MockMusic implements MusicProvider {
  readonly info = { id: "mock-music", displayName: "Mock Music", capability: "music" as const, model: "mock" };
  readonly minDurationSec = 3;
  readonly maxDurationSec = 600;
  calls: MusicRequest[] = [];
  async validate() {
    return { ok: true, message: "mock" };
  }
  async generate(req: MusicRequest): Promise<GenerationResult> {
    this.calls.push(req);
    return { data: await toneFor(Math.max(3, req.durationSec), 110, "mp3"), mimeType: "audio/mpeg", ext: "mp3" };
  }
}

export class MockSfx implements SfxProvider {
  readonly info = { id: "mock-sfx", displayName: "Mock SFX", capability: "sfx" as const, model: "mock" };
  readonly minDurationSec = 0.5;
  readonly maxDurationSec = 30;
  calls: SfxRequest[] = [];
  async validate() {
    return { ok: true, message: "mock" };
  }
  async generate(req: SfxRequest): Promise<GenerationResult> {
    this.calls.push(req);
    return { data: await toneFor(req.durationSec, 2000, "mp3"), mimeType: "audio/mpeg", ext: "mp3" };
  }
}

export function mockProviderSet(overrides: Partial<ProviderSet> = {}) {
  const set = {
    llm: new MockLlm(),
    image: new MockImage(),
    video: { primary: new MockVideo(), fallback: null as VideoProvider | null },
    voice: { primary: new MockVoice(), fallback: null as VoiceProvider | null },
    music: new MockMusic(),
    sfx: new MockSfx(),
    lipsync: new MockLipSync(),
    ...overrides,
  };
  return set;
}
