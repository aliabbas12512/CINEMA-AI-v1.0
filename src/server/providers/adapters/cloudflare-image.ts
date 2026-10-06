import { ProviderError, isRetryableStatus, parseRetryAfter, toProviderError } from "../errors";
import type {
  GenerationResult,
  ImageProvider,
  ImageRequest,
  ProviderInfo,
  SubmitResult,
  TaskStatus,
  ValidationResult,
} from "../types";
import { SyncTaskStore } from "./sync-task";

/**
 * Cloudflare Workers AI text-to-image (REST).
 *
 * Verified against Cloudflare's official docs source (cloudflare/cloudflare-docs):
 *   POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{model}
 *   Authorization: Bearer {API_TOKEN}   (token needs "Workers AI - Read" + "Workers AI - Edit")
 *   Response envelope: { result, success, errors, messages }
 *   @cf/black-forest-labs/flux-1-schnell  input { prompt (1..2048), steps (<= 8, default 4) }
 *                                          output { image: base64 }
 *   @cf/leonardo/lucid-origin             input { prompt, width, height (<= 2500), seed, steps (<= 40), guidance }
 *                                          output { image: base64 }
 * Pricing (platform/pricing): 10,000 Neurons/day free on every account;
 *   flux-1-schnell = 4.80 neurons per 512x512 tile + 9.60 neurons per step.
 *
 * Limitation: these models take no reference images, so character/location
 * consistency relies on the detailed Character/World Bible prompt + fixed seed
 * (lucid-origin) rather than image conditioning.
 */

export const CLOUDFLARE_IMAGE_MODELS = ["@cf/black-forest-labs/flux-1-schnell", "@cf/leonardo/lucid-origin"] as const;
type CfModel = (typeof CLOUDFLARE_IMAGE_MODELS)[number];

const NEURONS: Record<CfModel, { tile: number; step: number }> = {
  "@cf/black-forest-labs/flux-1-schnell": { tile: 4.8, step: 9.6 },
  "@cf/leonardo/lucid-origin": { tile: 636, step: 12 },
};

const SIZES: Record<ImageRequest["aspect"], { width: number; height: number }> = {
  "16:9": { width: 1344, height: 768 },
  "9:16": { width: 768, height: 1344 },
  "1:1": { width: 1024, height: 1024 },
};

/** Reads width/height from PNG or JPEG bytes (for accurate tile-based cost). */
export function imageSize(buf: Buffer): { width: number; height: number; mime: string } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: "image/png" };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1]!;
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), mime: "image/jpeg" };
      }
      i += 2 + len;
    }
  }
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return { width: 0, height: 0, mime: "image/webp" };
  }
  return null;
}

export class CloudflareImageProvider implements ImageProvider {
  readonly info: ProviderInfo;
  readonly maxReferences = 0;
  readonly maxPromptLength = 2048;
  private readonly store = new SyncTaskStore("cloudflare");
  private readonly base: string;

  constructor(
    private readonly opts: { accountId: string; apiToken: string; model?: string; steps?: number },
  ) {
    const model = (opts.model ?? CLOUDFLARE_IMAGE_MODELS[0]) as CfModel;
    if (!(CLOUDFLARE_IMAGE_MODELS as readonly string[]).includes(model)) {
      throw new Error(`Unsupported Cloudflare image model ${model} (supported: ${CLOUDFLARE_IMAGE_MODELS.join(", ")})`);
    }
    if (!/^[a-f0-9]{32}$/i.test(opts.accountId)) throw new Error("CLOUDFLARE_ACCOUNT_ID must be the 32-character account id");
    this.info = { id: "cloudflare", displayName: "Cloudflare Workers AI", capability: "image", model };
    this.base = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}`;
  }

  private get model(): CfModel {
    return this.info.model as CfModel;
  }

  async validate(): Promise<ValidationResult> {
    try {
      const res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
        headers: { Authorization: `Bearer ${this.opts.apiToken}` },
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: { status?: string } };
      if (!res.ok || !body.success) return { ok: false, message: `Cloudflare token verification failed (HTTP ${res.status}).` };
      return { ok: true, message: `Cloudflare API token is ${body.result?.status ?? "valid"}; model ${this.model}.` };
    } catch (err) {
      return { ok: false, message: toProviderError("cloudflare", err).message };
    }
  }

  async submit(req: ImageRequest): Promise<SubmitResult> {
    const result = await this.generate(req);
    return { externalId: this.store.put(result), estimatedCost: result.cost };
  }

  async generate(req: ImageRequest): Promise<GenerationResult> {
    const steps = this.model === "@cf/black-forest-labs/flux-1-schnell" ? Math.min(8, this.opts.steps ?? 4) : (this.opts.steps ?? 20);
    const size = SIZES[req.aspect];
    const body =
      this.model === "@cf/black-forest-labs/flux-1-schnell"
        ? { prompt: req.prompt.slice(0, this.maxPromptLength), steps }
        : { prompt: req.prompt.slice(0, this.maxPromptLength), steps, width: size.width, height: size.height, seed: req.seed };
    let res: Response;
    try {
      res = await fetch(`${this.base}/ai/run/${this.model}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      throw new ProviderError({ provider: "cloudflare", message: `Cloudflare request failed: ${(err as Error).message}`, retryable: true, cause: err });
    }
    const json = (await res.json().catch(() => null)) as
      | { success?: boolean; result?: { image?: string }; errors?: Array<{ code?: number; message?: string }> }
      | null;
    if (!res.ok || !json?.success || !json.result?.image) {
      const e = json?.errors?.[0];
      throw new ProviderError({
        provider: "cloudflare",
        message: `Cloudflare Workers AI HTTP ${res.status}${e?.message ? `: ${e.message}` : ""}`,
        retryable: isRetryableStatus(res.status),
        status: res.status,
        code: e?.code !== undefined ? String(e.code) : undefined,
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      });
    }
    const data = Buffer.from(json.result.image, "base64");
    const dim = imageSize(data);
    if (!dim) throw new ProviderError({ provider: "cloudflare", message: "Cloudflare returned an unrecognised image", retryable: true });
    const w = dim.width || size.width;
    const h = dim.height || size.height;
    const tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
    const n = NEURONS[this.model];
    const neurons = tiles * n.tile + steps * n.step;
    const ext = dim.mime === "image/png" ? "png" : dim.mime === "image/webp" ? "webp" : "jpg";
    return {
      data,
      mimeType: dim.mime,
      ext,
      // Neurons computed from Cloudflare's published per-model rates (free allocation: 10,000/day).
      cost: { amount: Math.round(neurons * 100) / 100, unit: "neurons" },
      usage: { steps, width: w, height: h },
    };
  }

  async getStatus(externalId: string): Promise<TaskStatus> {
    return this.store.status(externalId);
  }

  async download(status: TaskStatus): Promise<GenerationResult> {
    return this.store.take(status);
  }

  async cancel(externalId: string): Promise<void> {
    this.store.drop(externalId);
  }
}
