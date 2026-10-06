import RunwayML from "@runwayml/sdk";
import { downloadToBuffer } from "@/server/http/safe-fetch";
import { extFromMime, mimeFromExt, toDataUri } from "@/server/media/image-utils";
import { ProviderError, toProviderError } from "../errors";
import type {
  GenerationResult,
  ImageProvider,
  ImageRequest,
  ProviderInfo,
  SubmitResult,
  TaskStatus,
  ValidationResult,
  VideoCapabilities,
  VideoProvider,
  VideoRequest,
} from "../types";

/**
 * Runway API via the official @runwayml/sdk (base https://api.dev.runwayml.com,
 * X-Runway-Version handled by the SDK). Verified against SDK 4.x type
 * definitions:
 *   textToImage.create({ model, promptText, ratio, referenceImages[{uri,tag}], seed })
 *   imageToVideo.create({ model, promptImage, promptText, ratio, duration, seed, negativePrompt? })
 *   tasks.retrieve(id) -> PENDING | THROTTLED | RUNNING(progress) | SUCCEEDED(output[]) | FAILED(failure, failureCode) | CANCELLED
 *   tasks.delete(id)   -> cancels running tasks
 * Costs are reported by Runway in credits (estimatedCost / cost.credits).
 */

type RunwayTask = Awaited<ReturnType<RunwayML["tasks"]["retrieve"]>>;

function mapTask(t: RunwayTask): TaskStatus {
  switch (t.status) {
    case "PENDING":
    case "THROTTLED":
      return { externalId: t.id, state: "pending", cost: { amount: t.estimatedCost.credits, unit: "credits" } };
    case "RUNNING":
      return {
        externalId: t.id,
        state: "running",
        progress: t.progress,
        cost: { amount: t.estimatedCost.credits, unit: "credits" },
      };
    case "SUCCEEDED":
      return { externalId: t.id, state: "succeeded", outputUrls: t.output, cost: { amount: t.cost.credits, unit: "credits" } };
    case "FAILED":
      return {
        externalId: t.id,
        state: "failed",
        error: t.failure,
        errorCode: t.failureCode,
        cost: { amount: t.cost.credits, unit: "credits" },
      };
    case "CANCELLED":
      return { externalId: t.id, state: "cancelled", cost: { amount: t.cost.credits, unit: "credits" } };
  }
}

abstract class RunwayBase {
  protected readonly client: RunwayML;
  abstract readonly info: ProviderInfo;

  constructor(apiKey: string) {
    this.client = new RunwayML({ apiKey, maxRetries: 0 });
  }

  async validate(): Promise<ValidationResult> {
    try {
      const org = await this.client.organization.retrieve();
      return {
        ok: true,
        message: `Runway account reachable. Credit balance: ${org.creditBalance}.`,
        details: { creditBalance: org.creditBalance },
      };
    } catch (err) {
      return { ok: false, message: toProviderError("runway", err).message };
    }
  }

  async getStatus(externalId: string): Promise<TaskStatus> {
    try {
      return mapTask(await this.client.tasks.retrieve(externalId));
    } catch (err) {
      throw toProviderError("runway", err);
    }
  }

  async cancel(externalId: string): Promise<void> {
    try {
      await this.client.tasks.delete(externalId);
    } catch (err) {
      throw toProviderError("runway", err);
    }
  }

  async download(status: TaskStatus): Promise<GenerationResult> {
    const url = status.outputUrls?.[0];
    if (status.state !== "succeeded" || !url) {
      throw new ProviderError({ provider: "runway", message: "Task has no output to download", retryable: false });
    }
    const { data, contentType } = await downloadToBuffer("runway", url, { maxBytes: 2 * 1024 * 1024 * 1024 });
    const defaultExt = this.info.capability === "video" ? "mp4" : "png";
    const ext = extFromMime(contentType, defaultExt);
    return { data, ext, mimeType: mimeFromExt(ext), cost: status.cost };
  }
}

const IMAGE_RATIOS = { "16:9": "1920:1080", "9:16": "1080:1920", "1:1": "1024:1024" } as const;

export class RunwayImageProvider extends RunwayBase implements ImageProvider {
  readonly info: ProviderInfo;
  readonly maxReferences = 3;
  readonly maxPromptLength = 1000;

  constructor(opts: { apiKey: string; model: string }) {
    super(opts.apiKey);
    if (opts.model !== "gen4_image" && opts.model !== "gen4_image_turbo") {
      throw new Error(`Unsupported Runway image model ${opts.model} (supported: gen4_image, gen4_image_turbo)`);
    }
    this.info = { id: "runway", displayName: "Runway", capability: "image", model: opts.model };
  }

  async submit(req: ImageRequest): Promise<SubmitResult> {
    const refs = await Promise.all(
      (req.references ?? []).slice(0, this.maxReferences).map(async (r) => ({ uri: await toDataUri(r.image), tag: r.tag })),
    );
    const promptText = req.prompt.slice(0, this.maxPromptLength);
    const ratio = IMAGE_RATIOS[req.aspect];
    try {
      const res =
        this.info.model === "gen4_image_turbo"
          ? await this.client.textToImage.create({
              model: "gen4_image_turbo",
              promptText,
              ratio,
              referenceImages: refs,
              seed: req.seed,
            })
          : await this.client.textToImage.create({
              model: "gen4_image",
              promptText,
              ratio,
              referenceImages: refs.length ? refs : undefined,
              seed: req.seed,
            });
      return { externalId: res.id, estimatedCost: { amount: res.estimatedCost.credits, unit: "credits" } };
    } catch (err) {
      throw toProviderError("runway", err);
    }
  }
}

/** Per-model capabilities taken from the SDK's request types. */
const VIDEO_MODELS: Record<string, VideoCapabilities & { ratios: Record<"16:9" | "9:16", string> }> = {
  "gen4.5": {
    durations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    maxPromptLength: 1000,
    supportsNegativePrompt: false,
    nativeWidth: 1280,
    nativeHeight: 720,
    ratios: { "16:9": "1280:720", "9:16": "720:1280" },
  },
  "veo3.1": {
    durations: [4, 6, 8],
    maxPromptLength: 1000,
    supportsNegativePrompt: true,
    nativeWidth: 1920,
    nativeHeight: 1080,
    ratios: { "16:9": "1920:1080", "9:16": "1080:1920" },
  },
  "veo3.1_fast": {
    durations: [4, 6, 8],
    maxPromptLength: 1000,
    supportsNegativePrompt: true,
    nativeWidth: 1920,
    nativeHeight: 1080,
    ratios: { "16:9": "1920:1080", "9:16": "1080:1920" },
  },
};

export const RUNWAY_VIDEO_MODELS = Object.keys(VIDEO_MODELS);

export class RunwayVideoProvider extends RunwayBase implements VideoProvider {
  readonly info: ProviderInfo;
  readonly capabilities: VideoCapabilities;
  private readonly ratios: Record<"16:9" | "9:16", string>;

  constructor(opts: { apiKey: string; model: string }) {
    super(opts.apiKey);
    const caps = VIDEO_MODELS[opts.model];
    if (!caps) throw new Error(`Unsupported Runway video model ${opts.model} (supported: ${RUNWAY_VIDEO_MODELS.join(", ")})`);
    const { ratios, ...rest } = caps;
    this.capabilities = rest;
    this.ratios = ratios;
    this.info = { id: "runway", displayName: "Runway", capability: "video", model: opts.model };
  }

  async submit(req: VideoRequest): Promise<SubmitResult> {
    if (!this.capabilities.durations.includes(req.durationSec)) {
      throw new ProviderError({
        provider: "runway",
        message: `Duration ${req.durationSec}s not supported by ${this.info.model}`,
        retryable: false,
      });
    }
    const promptImage = await toDataUri(req.firstFrame);
    const promptText = req.prompt.slice(0, this.capabilities.maxPromptLength);
    const ratio = this.ratios[req.aspect];
    try {
      let res: { id: string; estimatedCost: { credits: number } };
      if (this.info.model === "gen4.5") {
        res = await this.client.imageToVideo.create({
          model: "gen4.5",
          promptImage,
          promptText,
          ratio: ratio as "1280:720" | "720:1280",
          duration: req.durationSec,
          seed: req.seed,
        });
      } else {
        const model = this.info.model as "veo3.1" | "veo3.1_fast";
        res = await this.client.imageToVideo.create({
          model,
          promptImage,
          promptText,
          ratio: ratio as "1920:1080" | "1080:1920",
          duration: req.durationSec as 4 | 6 | 8,
          negativePrompt: req.negativePrompt?.slice(0, 1000),
          // Dialogue/music/SFX are produced by dedicated providers and mixed by FFmpeg.
          audio: false,
          seed: req.seed,
        });
      }
      return { externalId: res.id, estimatedCost: { amount: res.estimatedCost.credits, unit: "credits" } };
    } catch (err) {
      throw toProviderError("runway", err);
    }
  }
}
