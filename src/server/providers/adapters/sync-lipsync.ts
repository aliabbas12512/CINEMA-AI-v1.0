import { Blob as NodeBlob } from "node:buffer";
import { SyncClient } from "@sync.so/sdk";
import { downloadToBuffer } from "@/server/http/safe-fetch";
import { ProviderError, toProviderError } from "../errors";
import type {
  GenerationResult,
  LipSyncProvider,
  LipSyncRequest,
  ProviderInfo,
  SubmitResult,
  TaskStatus,
  ValidationResult,
} from "../types";

/**
 * sync. (sync.so) lip-sync via the official @sync.so/sdk (Fern-generated, base
 * https://api.sync.so). Verified SDK surface:
 *   generations.createWithFiles(video, audio, { model, options: { sync_mode } })
 *   generations.get(id) -> { status: PENDING|PROCESSING|COMPLETED|FAILED|REJECTED, outputUrl, error, error_code }
 *   models.list()
 * Files are uploaded multipart, so private storage never needs public URLs.
 * The SDK exposes no cancel endpoint; cancel() is a documented no-op.
 */

const MODELS = ["lipsync-2", "lipsync-2-pro", "lipsync-1.9.0-beta", "react-1", "sync-3"] as const;
type SyncModel = (typeof MODELS)[number];

export class SyncLipSyncProvider implements LipSyncProvider {
  readonly info: ProviderInfo;
  private readonly client: SyncClient;

  constructor(opts: { apiKey: string; model: string }) {
    if (!(MODELS as readonly string[]).includes(opts.model)) {
      throw new Error(`Unsupported sync. model ${opts.model} (supported: ${MODELS.join(", ")})`);
    }
    this.client = new SyncClient({ apiKey: opts.apiKey });
    this.info = { id: "sync", displayName: "sync. lip-sync", capability: "lipsync", model: opts.model };
  }

  async validate(): Promise<ValidationResult> {
    try {
      const models = await this.client.models.list({ maxRetries: 0 });
      return { ok: true, message: `sync. API reachable (${models.length} models).` };
    } catch (err) {
      return { ok: false, message: toProviderError("sync", err).message };
    }
  }

  async submit(req: LipSyncRequest): Promise<SubmitResult> {
    try {
      const video = new NodeBlob([req.video.data], { type: req.video.mimeType });
      const audio = new NodeBlob([req.audio.data], { type: req.audio.mimeType });
      const gen = await this.client.generations.createWithFiles(
        video,
        audio,
        { model: this.info.model as SyncModel, options: { sync_mode: "cut_off" } },
        { maxRetries: 0, timeoutInSeconds: 300 },
      );
      return { externalId: gen.id };
    } catch (err) {
      throw toProviderError("sync", err);
    }
  }

  async getStatus(externalId: string): Promise<TaskStatus> {
    try {
      const g = await this.client.generations.get(externalId, { maxRetries: 0 });
      switch (g.status) {
        case "PENDING":
          return { externalId, state: "pending" };
        case "PROCESSING":
          return { externalId, state: "running" };
        case "COMPLETED":
          return { externalId, state: "succeeded", outputUrls: g.outputUrl ? [g.outputUrl] : [] };
        case "FAILED":
        case "REJECTED":
          return { externalId, state: "failed", error: g.error ?? g.status, errorCode: g.error_code };
        default:
          return { externalId, state: "running" };
      }
    } catch (err) {
      throw toProviderError("sync", err);
    }
  }

  async download(status: TaskStatus): Promise<GenerationResult> {
    const url = status.outputUrls?.[0];
    if (!url) throw new ProviderError({ provider: "sync", message: "Lip-sync output URL missing", retryable: false });
    const { data } = await downloadToBuffer("sync", url, { maxBytes: 1024 * 1024 * 1024 });
    return { data, mimeType: "video/mp4", ext: "mp4" };
  }

  async cancel(_externalId: string): Promise<void> {
    // No cancel endpoint in the sync. API/SDK; the generation is left to finish and ignored.
  }
}
