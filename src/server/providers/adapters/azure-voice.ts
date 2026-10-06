import { ProviderError, isRetryableStatus, parseRetryAfter, toProviderError } from "../errors";
import type {
  GenerationResult,
  ProviderInfo,
  SpeakerProfile,
  ValidationResult,
  VoiceIdentity,
  VoiceProvider,
  VoiceRequest,
} from "../types";

/**
 * Azure AI Speech - Text to speech REST API.
 *
 * Verified against Microsoft's official docs (MicrosoftDocs/azure-ai-docs,
 * articles/ai-services/speech-service/rest-text-to-speech.md):
 *   POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1
 *   Headers: Ocp-Apim-Subscription-Key, Content-Type: application/ssml+xml,
 *            X-Microsoft-OutputFormat, User-Agent
 *   GET  https://{region}.tts.speech.microsoft.com/cognitiveservices/voices/list
 * Pakistani Urdu neural voices (language-support tts table):
 *   ur-PK-AsadNeural (Male), ur-PK-UzmaNeural (Female)
 *
 * Only two Pakistani Urdu voices exist, so additional characters are
 * differentiated with SSML <prosody> pitch/rate offsets that are assigned once
 * per speaker and persisted, keeping every character consistent.
 * Azure reports no per-request price, so cost is recorded as characters.
 */

export const AZURE_UR_PK_VOICES = { male: "ur-PK-AsadNeural", female: "ur-PK-UzmaNeural" } as const;
const OUTPUT_FORMAT = "riff-48khz-16bit-mono-pcm";

const PITCH_VARIANTS = ["+0%", "-7%", "+7%", "-12%", "+12%", "-4%", "+4%"];
const RATE_VARIANTS = ["+0%", "-4%", "+4%", "-6%", "+2%", "-2%", "+6%"];

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const PROSODY_RE = /^[+-]?\d{1,2}%$/;

export function buildSsml(req: VoiceRequest): string {
  const pitch = typeof req.voice.settings.pitch === "string" && PROSODY_RE.test(req.voice.settings.pitch) ? req.voice.settings.pitch : "+0%";
  const rate = typeof req.voice.settings.rate === "string" && PROSODY_RE.test(req.voice.settings.rate) ? req.voice.settings.rate : "+0%";
  if (!/^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/.test(req.voice.providerVoiceId)) {
    throw new ProviderError({ provider: "azure", message: "Invalid Azure voice name", retryable: false });
  }
  const locale = escapeXml(req.locale);
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">` +
    `<voice name="${req.voice.providerVoiceId}">` +
    `<prosody pitch="${pitch}" rate="${rate}">${escapeXml(req.text)}</prosody>` +
    `</voice></speak>`
  );
}

export class AzureVoiceProvider implements VoiceProvider {
  readonly info: ProviderInfo = { id: "azure", displayName: "Azure AI Speech", capability: "voice", model: "neural-tts" };
  readonly locales = ["ur-PK"];
  private readonly base: string;

  constructor(
    private readonly opts: { apiKey: string; region: string; narratorGender: "male" | "female" },
  ) {
    if (!/^[a-z0-9]+$/.test(opts.region)) throw new Error("AZURE_SPEECH_REGION must be a region name like 'eastus'");
    this.base = `https://${opts.region}.tts.speech.microsoft.com/cognitiveservices`;
  }

  assignVoice(profile: SpeakerProfile, index: number): VoiceIdentity {
    if (profile.role === "narrator") {
      return { providerVoiceId: AZURE_UR_PK_VOICES[this.opts.narratorGender], settings: { pitch: "+0%", rate: "-4%" } };
    }
    const voice = profile.gender === "female" ? AZURE_UR_PK_VOICES.female : AZURE_UR_PK_VOICES.male;
    // index counts characters of the same gender; 0 is reserved-free because narrator uses rate -4%.
    let pitch = PITCH_VARIANTS[(index + 1) % PITCH_VARIANTS.length] ?? "+0%";
    let rate = RATE_VARIANTS[(index + 1) % RATE_VARIANTS.length] ?? "+0%";
    if (profile.ageGroup === "child") pitch = "+15%";
    if (profile.ageGroup === "elder") {
      pitch = "-10%";
      rate = "-8%";
    }
    return { providerVoiceId: voice, settings: { pitch, rate } };
  }

  async validate(): Promise<ValidationResult> {
    try {
      const res = await fetch(`${this.base}/voices/list`, {
        headers: { "Ocp-Apim-Subscription-Key": this.opts.apiKey },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { ok: false, message: `Azure voices/list returned HTTP ${res.status}` };
      const list = (await res.json()) as Array<{ ShortName?: string }>;
      const names = new Set(list.map((v) => v.ShortName));
      const missing = Object.values(AZURE_UR_PK_VOICES).filter((v) => !names.has(v));
      if (missing.length) return { ok: false, message: `Urdu (Pakistan) voices missing in region: ${missing.join(", ")}` };
      return { ok: true, message: "Azure Speech reachable; ur-PK Asad and Uzma neural voices available." };
    } catch (err) {
      return { ok: false, message: toProviderError("azure", err).message };
    }
  }

  async generate(req: VoiceRequest): Promise<GenerationResult> {
    const ssml = buildSsml(req);
    let res: Response;
    try {
      res = await fetch(`${this.base}/v1`, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": this.opts.apiKey,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": OUTPUT_FORMAT,
          "User-Agent": "ai-fantasy-studio",
        },
        body: ssml,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new ProviderError({ provider: "azure", message: `Azure TTS request failed: ${(err as Error).message}`, retryable: true, cause: err });
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      throw new ProviderError({
        provider: "azure",
        message: `Azure TTS HTTP ${res.status}${body ? `: ${body}` : ""}`,
        retryable: isRetryableStatus(res.status),
        status: res.status,
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      });
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (data.byteLength < 100) {
      throw new ProviderError({ provider: "azure", message: "Azure TTS returned empty audio", retryable: true });
    }
    return {
      data,
      mimeType: "audio/wav",
      ext: "wav",
      usage: { characters: req.text.length },
      cost: undefined,
    };
  }
}
