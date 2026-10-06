import type { z } from "zod";
import type { Capability } from "@/server/db/schema";

/**
 * Provider-agnostic contracts. Every adapter implements one of these and is
 * selected by environment configuration in `registry.ts`.
 *
 * Asynchronous providers (image, video, lip-sync) follow:
 *   submit() -> getStatus() (poll) -> download() ; cancel() ; validate()
 * Synchronous providers (voice, music, sfx) expose:
 *   generate() ; validate()
 */

export type CostInfo = {
  amount: number;
  /** "usd" | "credits" | "characters" | "tokens" ... never invented: comes from the provider response or a documented price table. */
  unit: string;
};

export type ValidationResult = {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
};

export type ProviderInfo = {
  /** adapter id, e.g. "runway" */
  id: string;
  displayName: string;
  capability: Capability;
  model: string;
};

export type Media = {
  data: Buffer;
  mimeType: string;
  /** file extension without dot */
  ext: string;
};

export type GenerationResult = Media & {
  cost?: CostInfo;
  usage?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

export type TaskState = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export type TaskStatus = {
  externalId: string;
  state: TaskState;
  progress?: number;
  outputUrls?: string[];
  error?: string;
  errorCode?: string;
  cost?: CostInfo;
};

export type SubmitResult = { externalId: string; estimatedCost?: CostInfo };

export interface BaseProvider {
  readonly info: ProviderInfo;
  validate(): Promise<ValidationResult>;
}

export interface AsyncTaskProvider<Req> extends BaseProvider {
  submit(req: Req): Promise<SubmitResult>;
  getStatus(externalId: string): Promise<TaskStatus>;
  download(status: TaskStatus): Promise<GenerationResult>;
  cancel(externalId: string): Promise<void>;
}

// ------------------------------------------------------------------ LLM

export type LlmUsage = { inputTokens: number; outputTokens: number };

export interface LlmProvider extends BaseProvider {
  generateStructured<S extends z.ZodType>(args: {
    schema: S;
    system: string;
    prompt: string;
    maxTokens?: number;
    effort?: "low" | "medium" | "high";
  }): Promise<{ data: z.infer<S>; usage: LlmUsage; cost?: CostInfo }>;
}

// ------------------------------------------------------------------ image

export type ReferenceImage = { tag: string; image: Media };

export type ImageRequest = {
  prompt: string;
  aspect: "16:9" | "9:16" | "1:1";
  references?: ReferenceImage[];
  seed?: number;
};

export interface ImageProvider extends AsyncTaskProvider<ImageRequest> {
  readonly maxReferences: number;
  readonly maxPromptLength: number;
}

// ------------------------------------------------------------------ video

export type VideoRequest = {
  prompt: string;
  negativePrompt?: string;
  firstFrame: Media;
  durationSec: number;
  aspect: "16:9" | "9:16";
  seed?: number;
};

export type VideoCapabilities = {
  /** Allowed clip durations in seconds, ascending. */
  durations: number[];
  maxPromptLength: number;
  supportsNegativePrompt: boolean;
  /** Native output size of the provider for 16:9. */
  nativeWidth: number;
  nativeHeight: number;
};

export interface VideoProvider extends AsyncTaskProvider<VideoRequest> {
  readonly capabilities: VideoCapabilities;
}

// ------------------------------------------------------------------ voice

export type VoiceIdentity = {
  providerVoiceId: string;
  /** SSML prosody adjustments or provider voice settings, persisted per speaker. */
  settings: Record<string, unknown>;
};

export type VoiceRequest = {
  text: string;
  /** BCP-47 locale, e.g. ur-PK */
  locale: string;
  voice: VoiceIdentity;
  emotion?: string;
  previousText?: string;
  nextText?: string;
};

export type SpeakerProfile = {
  speakerKey: string;
  role: "narrator" | "character";
  gender: "male" | "female" | "neutral";
  ageGroup: "child" | "young_adult" | "adult" | "elder";
};

export interface VoiceProvider extends BaseProvider {
  readonly locales: string[];
  /** Deterministically assigns a voice identity to a speaker (consistent across the project). */
  assignVoice(profile: SpeakerProfile, index: number): VoiceIdentity;
  generate(req: VoiceRequest): Promise<GenerationResult>;
}

// ------------------------------------------------------------------ music / sfx

export type MusicRequest = { prompt: string; durationSec: number; instrumental: true };
export interface MusicProvider extends BaseProvider {
  readonly maxDurationSec: number;
  readonly minDurationSec: number;
  generate(req: MusicRequest): Promise<GenerationResult>;
}

export type SfxRequest = { prompt: string; durationSec: number; loop?: boolean };
export interface SfxProvider extends BaseProvider {
  readonly maxDurationSec: number;
  readonly minDurationSec: number;
  generate(req: SfxRequest): Promise<GenerationResult>;
}

// ------------------------------------------------------------------ lip sync

export type LipSyncRequest = { video: Media; audio: Media };
export type LipSyncProvider = AsyncTaskProvider<LipSyncRequest>;

// ------------------------------------------------------------------ set

export type ProviderSlot<P> = { primary: P | null; fallback: P | null };

export type ProviderSet = {
  llm: LlmProvider | null;
  image: ImageProvider | null;
  video: ProviderSlot<VideoProvider>;
  voice: ProviderSlot<VoiceProvider>;
  music: MusicProvider | null;
  sfx: SfxProvider | null;
  lipsync: LipSyncProvider | null;
};
