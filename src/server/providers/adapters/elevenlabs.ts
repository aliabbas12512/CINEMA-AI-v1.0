import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { ProviderError, toProviderError } from "../errors";
import type {
  GenerationResult,
  MusicProvider,
  MusicRequest,
  ProviderInfo,
  SfxProvider,
  SfxRequest,
  SpeakerProfile,
  ValidationResult,
  VoiceIdentity,
  VoiceProvider,
  VoiceRequest,
} from "../types";

/**
 * ElevenLabs via the official @elevenlabs/elevenlabs-js SDK (v2.x). Verified
 * against the SDK's generated request types:
 *   textToSpeech.convert(voiceId, { text, modelId, languageCode, outputFormat, voiceSettings, previousText, nextText })
 *   textToSoundEffects.convert({ text, durationSeconds (0.5-30), loop, outputFormat, modelId: "eleven_text_to_sound_v2" })
 *   music.compose({ prompt, musicLengthMs (3000-600000), forceInstrumental, outputFormat })
 *   models.list() -> [{ modelId, languages[{ languageId, name }] }]
 *
 * Urdu support for the chosen TTS model is verified at runtime through
 * models.list() in validate(), not assumed. Voice IDs are never invented:
 * they must be configured (ELEVENLABS_*_VOICE_ID[S]) from the user's library.
 */

const OUTPUT_FORMAT = "mp3_44100_128" as const;

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function elevenError(err: unknown): ProviderError {
  return toProviderError("elevenlabs", err);
}

export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly info: ProviderInfo;
  readonly locales = ["ur-PK"];
  private readonly client: ElevenLabsClient;

  constructor(
    private readonly opts: {
      apiKey: string;
      model: string;
      narratorVoiceId: string;
      maleVoiceIds: string[];
      femaleVoiceIds: string[];
    },
  ) {
    this.client = new ElevenLabsClient({ apiKey: opts.apiKey, maxRetries: 0 });
    this.info = { id: "elevenlabs", displayName: "ElevenLabs", capability: "voice", model: opts.model };
  }

  assignVoice(profile: SpeakerProfile, index: number): VoiceIdentity {
    if (profile.role === "narrator") {
      return { providerVoiceId: this.opts.narratorVoiceId, settings: { stability: 0.5, similarityBoost: 0.8, speed: 0.95 } };
    }
    const pool = profile.gender === "female" ? this.opts.femaleVoiceIds : this.opts.maleVoiceIds;
    const fallbackPool = pool.length ? pool : [...this.opts.maleVoiceIds, ...this.opts.femaleVoiceIds];
    const voiceId = fallbackPool[index % Math.max(1, fallbackPool.length)] ?? this.opts.narratorVoiceId;
    return { providerVoiceId: voiceId, settings: { stability: 0.45, similarityBoost: 0.8, speed: 1.0 } };
  }

  async validate(): Promise<ValidationResult> {
    try {
      const models = await this.client.models.list();
      const model = models.find((m) => m.modelId === this.info.model);
      if (!model) return { ok: false, message: `ElevenLabs model ${this.info.model} not found for this account.` };
      const langs = model.languages ?? [];
      const urdu = langs.some((l) => l.languageId.toLowerCase() === "ur" || /urdu/i.test(l.name));
      if (!urdu) {
        return {
          ok: false,
          message: `ElevenLabs model ${this.info.model} does not list Urdu among its languages.`,
          details: { languages: langs.map((l) => l.languageId) },
        };
      }
      return { ok: true, message: `ElevenLabs model ${this.info.model} supports Urdu.` };
    } catch (err) {
      return { ok: false, message: elevenError(err).message };
    }
  }

  async generate(req: VoiceRequest): Promise<GenerationResult> {
    const s = req.voice.settings as { stability?: number; similarityBoost?: number; speed?: number };
    try {
      const stream = await this.client.textToSpeech.convert(req.voice.providerVoiceId, {
        text: req.text,
        modelId: this.info.model,
        languageCode: req.locale.split("-")[0],
        outputFormat: OUTPUT_FORMAT,
        previousText: req.previousText,
        nextText: req.nextText,
        voiceSettings: { stability: s.stability, similarityBoost: s.similarityBoost, speed: s.speed },
      });
      const data = await streamToBuffer(stream);
      if (data.byteLength < 100) throw new ProviderError({ provider: "elevenlabs", message: "Empty audio returned", retryable: true });
      return { data, mimeType: "audio/mpeg", ext: "mp3", usage: { characters: req.text.length } };
    } catch (err) {
      throw elevenError(err);
    }
  }
}

export class ElevenLabsMusicProvider implements MusicProvider {
  readonly info: ProviderInfo = { id: "elevenlabs", displayName: "ElevenLabs Music", capability: "music", model: "music" };
  readonly minDurationSec = 3;
  readonly maxDurationSec = 600;
  private readonly client: ElevenLabsClient;

  constructor(apiKey: string) {
    this.client = new ElevenLabsClient({ apiKey, maxRetries: 0 });
  }

  async validate(): Promise<ValidationResult> {
    try {
      const user = await this.client.user.get();
      return { ok: true, message: `ElevenLabs account reachable (tier: ${user.subscription?.tier ?? "unknown"}).` };
    } catch (err) {
      return { ok: false, message: elevenError(err).message };
    }
  }

  async generate(req: MusicRequest): Promise<GenerationResult> {
    const ms = Math.round(Math.min(this.maxDurationSec, Math.max(this.minDurationSec, req.durationSec)) * 1000);
    try {
      const stream = await this.client.music.compose({
        prompt: req.prompt.slice(0, 2000),
        musicLengthMs: ms,
        forceInstrumental: true,
        outputFormat: OUTPUT_FORMAT,
      });
      const data = await streamToBuffer(stream);
      if (data.byteLength < 100) throw new ProviderError({ provider: "elevenlabs", message: "Empty music returned", retryable: true });
      return { data, mimeType: "audio/mpeg", ext: "mp3", usage: { musicLengthMs: ms } };
    } catch (err) {
      throw elevenError(err);
    }
  }
}

export class ElevenLabsSfxProvider implements SfxProvider {
  readonly info: ProviderInfo = {
    id: "elevenlabs",
    displayName: "ElevenLabs Sound Effects",
    capability: "sfx",
    model: "eleven_text_to_sound_v2",
  };
  readonly minDurationSec = 0.5;
  readonly maxDurationSec = 30;
  private readonly client: ElevenLabsClient;

  constructor(apiKey: string) {
    this.client = new ElevenLabsClient({ apiKey, maxRetries: 0 });
  }

  async validate(): Promise<ValidationResult> {
    try {
      await this.client.user.get();
      return { ok: true, message: "ElevenLabs account reachable." };
    } catch (err) {
      return { ok: false, message: elevenError(err).message };
    }
  }

  async generate(req: SfxRequest): Promise<GenerationResult> {
    const secs = Math.min(this.maxDurationSec, Math.max(this.minDurationSec, req.durationSec));
    try {
      const stream = await this.client.textToSoundEffects.convert({
        text: req.prompt.slice(0, 1000),
        durationSeconds: Number(secs.toFixed(2)),
        loop: req.loop ?? false,
        modelId: "eleven_text_to_sound_v2",
        outputFormat: OUTPUT_FORMAT,
      });
      const data = await streamToBuffer(stream);
      if (data.byteLength < 100) throw new ProviderError({ provider: "elevenlabs", message: "Empty SFX returned", retryable: true });
      return { data, mimeType: "audio/mpeg", ext: "mp3", usage: { durationSeconds: secs } };
    } catch (err) {
      throw elevenError(err);
    }
  }
}
