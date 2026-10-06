import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { ProviderError, toProviderError } from "../errors";
import type { CostInfo, LlmProvider, LlmUsage, ProviderInfo, ValidationResult } from "../types";

/**
 * Anthropic Messages API (official @anthropic-ai/sdk).
 *
 * - Structured output via `output_config.format` (JSON schema derived from Zod),
 *   then re-validated with Zod - never trusted blindly.
 * - Streaming is used because plans for a 10-minute film are long outputs.
 * - Server-side refusal fallback (`fallbacks: "default"`, beta
 *   `server-side-fallback-2026-07-01`) is enabled; the serving model is
 *   recorded so cost is computed for the model that actually ran.
 */

/** USD per 1M tokens, Anthropic first-party list prices (Claude API skill reference, cached 2026-09-25). */
const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export function anthropicCost(model: string, usage: LlmUsage): CostInfo | undefined {
  const p = PRICES_PER_MTOK[model];
  if (!p) return undefined;
  return {
    amount: (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000,
    unit: "usd",
  };
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly info: ProviderInfo;
  private readonly client: Anthropic;

  constructor(opts: { apiKey: string; model: string }) {
    this.client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 0 });
    this.info = { id: "anthropic", displayName: "Anthropic Claude", capability: "llm", model: opts.model };
  }

  async validate(): Promise<ValidationResult> {
    try {
      const m = await this.client.models.retrieve(this.info.model);
      return { ok: true, message: `Model ${m.id} is available.` };
    } catch (err) {
      return { ok: false, message: toProviderError("anthropic", err).message };
    }
  }

  async generateStructured<S extends z.ZodType>(args: {
    schema: S;
    system: string;
    prompt: string;
    maxTokens?: number;
    effort?: "low" | "medium" | "high";
  }): Promise<{ data: z.infer<S>; usage: LlmUsage; cost?: CostInfo }> {
    let message: Anthropic.Beta.BetaMessage;
    try {
      const stream = this.client.beta.messages.stream({
        model: this.info.model,
        max_tokens: args.maxTokens ?? 64000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: args.effort ?? "high", format: betaZodOutputFormat(args.schema) },
        system: args.system,
        messages: [{ role: "user", content: args.prompt }],
      });
      message = await stream.finalMessage();
    } catch (err) {
      throw toProviderError("anthropic", err);
    }

    const usage: LlmUsage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };

    if (message.stop_reason === "refusal") {
      throw new ProviderError({
        provider: "anthropic",
        message: `The language model declined this script (category: ${message.stop_details?.category ?? "unspecified"}).`,
        retryable: false,
        code: "refusal",
      });
    }
    if (message.stop_reason === "max_tokens") {
      throw new ProviderError({
        provider: "anthropic",
        message: "The language model output was truncated (max_tokens). Try a shorter script.",
        retryable: false,
        code: "max_tokens",
      });
    }

    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ProviderError({
        provider: "anthropic",
        message: "The language model returned invalid JSON.",
        retryable: true,
        code: "invalid_json",
      });
    }
    const parsed = args.schema.safeParse(json);
    if (!parsed.success) {
      throw new ProviderError({
        provider: "anthropic",
        message: `The language model output failed schema validation: ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        retryable: true,
        code: "schema_mismatch",
      });
    }
    return { data: parsed.data, usage, cost: anthropicCost(message.model, usage) };
  }
}
