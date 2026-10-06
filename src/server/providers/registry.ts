import { getEnv, type Env } from "@/server/env";
import { AnthropicLlmProvider } from "./adapters/anthropic-llm";
import { AzureVoiceProvider } from "./adapters/azure-voice";
import { ElevenLabsMusicProvider, ElevenLabsSfxProvider, ElevenLabsVoiceProvider } from "./adapters/elevenlabs";
import { RunwayImageProvider, RunwayVideoProvider } from "./adapters/runway";
import { SyncLipSyncProvider } from "./adapters/sync-lipsync";
import type { ProviderSet, VoiceProvider } from "./types";

/**
 * Builds the production provider set from environment variables. Anything not
 * configured is `null`, and the pipeline reports
 * "<Capability> generation provider is not configured." instead of faking it.
 *
 * Tests inject their own ProviderSet; there are no mock adapters here.
 */

export type ProviderConfigIssue = { slot: string; message: string };

function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildVoice(
  kind: Env["VOICE_PROVIDER"],
  apiKey: string | undefined,
  env: Env,
  narratorGender: "male" | "female",
  slot: string,
  issues: ProviderConfigIssue[],
): VoiceProvider | null {
  if (kind === "none") return null;
  if (!apiKey) {
    issues.push({ slot, message: `${slot} is '${kind}' but its API key is missing.` });
    return null;
  }
  if (kind === "azure") {
    if (!env.AZURE_SPEECH_REGION) {
      issues.push({ slot, message: "AZURE_SPEECH_REGION is required for the Azure voice provider." });
      return null;
    }
    return new AzureVoiceProvider({ apiKey, region: env.AZURE_SPEECH_REGION, narratorGender });
  }
  if (!env.ELEVENLABS_NARRATOR_VOICE_ID) {
    issues.push({ slot, message: "ELEVENLABS_NARRATOR_VOICE_ID is required for the ElevenLabs voice provider." });
    return null;
  }
  return new ElevenLabsVoiceProvider({
    apiKey,
    model: env.ELEVENLABS_TTS_MODEL,
    narratorVoiceId: env.ELEVENLABS_NARRATOR_VOICE_ID,
    maleVoiceIds: list(env.ELEVENLABS_MALE_VOICE_IDS),
    femaleVoiceIds: list(env.ELEVENLABS_FEMALE_VOICE_IDS),
  });
}

function safe<T>(slot: string, issues: ProviderConfigIssue[], make: () => T): T | null {
  try {
    return make();
  } catch (err) {
    issues.push({ slot, message: (err as Error).message });
    return null;
  }
}

export function buildProviderSet(opts: { narratorGender: "male" | "female" } = { narratorGender: "male" }): {
  providers: ProviderSet;
  issues: ProviderConfigIssue[];
} {
  const env = getEnv();
  const issues: ProviderConfigIssue[] = [];
  const need = (slot: string, kind: string, key: string | undefined): key is string => {
    if (kind === "none") return false;
    if (!key) {
      issues.push({ slot, message: `${slot} is '${kind}' but its API key is missing.` });
      return false;
    }
    return true;
  };

  const llm =
    env.LLM_PROVIDER === "anthropic" && need("LLM_PROVIDER", "anthropic", env.ANTHROPIC_API_KEY)
      ? safe("LLM_PROVIDER", issues, () => new AnthropicLlmProvider({ apiKey: env.ANTHROPIC_API_KEY!, model: env.ANTHROPIC_MODEL }))
      : null;

  const image = need("IMAGE_PROVIDER", env.IMAGE_PROVIDER, env.IMAGE_PROVIDER_API_KEY)
    ? safe("IMAGE_PROVIDER", issues, () => new RunwayImageProvider({ apiKey: env.IMAGE_PROVIDER_API_KEY!, model: env.IMAGE_MODEL }))
    : null;

  const videoPrimary = need("VIDEO_PROVIDER", env.VIDEO_PROVIDER, env.VIDEO_PROVIDER_API_KEY)
    ? safe("VIDEO_PROVIDER", issues, () => new RunwayVideoProvider({ apiKey: env.VIDEO_PROVIDER_API_KEY!, model: env.VIDEO_MODEL }))
    : null;
  let videoFallback = null;
  if (env.VIDEO_FALLBACK_PROVIDER !== "none") {
    if (!env.VIDEO_FALLBACK_MODEL) {
      issues.push({ slot: "VIDEO_FALLBACK_PROVIDER", message: "VIDEO_FALLBACK_MODEL is required when a video fallback is set." });
    } else if (need("VIDEO_FALLBACK_PROVIDER", env.VIDEO_FALLBACK_PROVIDER, env.VIDEO_PROVIDER_API_KEY)) {
      videoFallback = safe(
        "VIDEO_FALLBACK_PROVIDER",
        issues,
        () => new RunwayVideoProvider({ apiKey: env.VIDEO_PROVIDER_API_KEY!, model: env.VIDEO_FALLBACK_MODEL! }),
      );
    }
  }

  const voicePrimary = buildVoice(env.VOICE_PROVIDER, env.VOICE_PROVIDER_API_KEY, env, opts.narratorGender, "VOICE_PROVIDER", issues);
  const voiceFallback = buildVoice(
    env.VOICE_FALLBACK_PROVIDER,
    env.VOICE_FALLBACK_API_KEY,
    env,
    opts.narratorGender,
    "VOICE_FALLBACK_PROVIDER",
    issues,
  );

  const music = need("MUSIC_PROVIDER", env.MUSIC_PROVIDER, env.MUSIC_PROVIDER_API_KEY)
    ? new ElevenLabsMusicProvider(env.MUSIC_PROVIDER_API_KEY!)
    : null;
  const sfx = need("SFX_PROVIDER", env.SFX_PROVIDER, env.SFX_PROVIDER_API_KEY) ? new ElevenLabsSfxProvider(env.SFX_PROVIDER_API_KEY!) : null;
  const lipsync = need("LIPSYNC_PROVIDER", env.LIPSYNC_PROVIDER, env.LIPSYNC_PROVIDER_API_KEY)
    ? safe("LIPSYNC_PROVIDER", issues, () => new SyncLipSyncProvider({ apiKey: env.LIPSYNC_PROVIDER_API_KEY!, model: env.LIPSYNC_MODEL }))
    : null;

  return {
    providers: {
      llm,
      image,
      video: { primary: videoPrimary, fallback: videoFallback },
      voice: { primary: voicePrimary, fallback: voiceFallback },
      music,
      sfx,
      lipsync,
    },
    issues,
  };
}

export type ProviderSummary = {
  capability: string;
  configured: boolean;
  provider?: string;
  model?: string;
  fallback?: string;
  required: boolean;
  message: string;
};

/** Client-safe description of configured providers (no secrets). */
export function summarizeProviders(set: ProviderSet, issues: ProviderConfigIssue[]): ProviderSummary[] {
  const issueFor = (slot: string) => issues.find((i) => i.slot.startsWith(slot))?.message;
  const row = (
    capability: string,
    slot: string,
    p: { info: { displayName: string; model: string } } | null,
    required: boolean,
    fallback?: { info: { displayName: string; model: string } } | null,
  ): ProviderSummary => ({
    capability,
    configured: p !== null,
    provider: p?.info.displayName,
    model: p?.info.model,
    fallback: fallback ? `${fallback.info.displayName} (${fallback.info.model})` : undefined,
    required,
    message: p
      ? "Configured"
      : (issueFor(slot) ?? `${capability} generation provider is not configured.`),
  });
  return [
    row("Script analysis (LLM)", "LLM", set.llm, true),
    row("Image", "IMAGE", set.image, true),
    row("Video", "VIDEO", set.video.primary, true, set.video.fallback),
    row("Voice", "VOICE", set.voice.primary, true, set.voice.fallback),
    row("Music", "MUSIC", set.music, false),
    row("Sound effects", "SFX", set.sfx, false),
    row("Lip sync", "LIPSYNC", set.lipsync, false),
  ];
}
