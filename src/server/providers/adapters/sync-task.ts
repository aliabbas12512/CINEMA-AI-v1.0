import { randomUUID } from "node:crypto";
import { ProviderError } from "../errors";
import type { GenerationResult, TaskStatus } from "../types";

/**
 * Adapts a provider whose API answers synchronously (the result comes back in
 * the same HTTP response, or is rendered locally) to the async
 * submit/getStatus/download contract used by the pipeline.
 *
 * Results live in this process only. If the worker restarts between submit
 * and download, getStatus reports a retryable failure and the pipeline simply
 * generates the unit again.
 */
export class SyncTaskStore {
  private readonly results = new Map<string, { result: GenerationResult; at: number }>();

  constructor(private readonly provider: string) {}

  put(result: GenerationResult): string {
    this.gc();
    const id = `${this.provider}-${randomUUID()}`;
    this.results.set(id, { result, at: Date.now() });
    return id;
  }

  status(externalId: string): TaskStatus {
    const r = this.results.get(externalId);
    if (!r) {
      return {
        externalId,
        state: "failed",
        error: "Result no longer held in memory (worker restarted); regenerating.",
        errorCode: "RESULT_EXPIRED",
      };
    }
    return { externalId, state: "succeeded", outputUrls: [], cost: r.result.cost };
  }

  take(status: TaskStatus): GenerationResult {
    const r = this.results.get(status.externalId);
    if (!r) throw new ProviderError({ provider: this.provider, message: "Result expired", retryable: true });
    this.results.delete(status.externalId);
    return r.result;
  }

  drop(externalId: string): void {
    this.results.delete(externalId);
  }

  private gc(): void {
    const cutoff = Date.now() - 60 * 60_000;
    for (const [k, v] of this.results) if (v.at < cutoff) this.results.delete(k);
  }
}
