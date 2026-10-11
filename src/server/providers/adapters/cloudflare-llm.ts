import { z } from "zod";
import { ProviderError, isRetryableStatus, parseRetryAfter, toProviderError } from "../errors";
import type { CostInfo, LlmProvider, LlmUsage, ProviderInfo, ValidationResult } from "../types";

/**
 * Cloudflare Workers AI text generation with JSON Mode (REST) - the free
 * alternative to Anthropic for script analysis and scene planning.
 *
 * Verified against Cloudflare's official docs source (cloudflare/cloudflare-docs):
 *   POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{model}
 *   input  { messages, max_tokens (default 256), temperature,
 *            response_format: { type: "json_schema", json_schema } }   (JSON Mode, no streaming)
 *   output { result: { response, usage: { prompt_tokens, completion_tokens } } }
 *   JSON Mode models include @cf/meta/llama-3.3-70b-instruct-fp8-fast (context window 24,000).
 *   A schema the model cannot satisfy returns the error "JSON Mode couldn't be met".
 * Pricing (platform/pricing), llama-3.3-70b-instruct-fp8-fast:
 *   26,668 neurons per M input tokens, 204,805 neurons per M output tokens;
 *   10,000 Neurons/day free on every account (shared with image generation).
 *
 * Quality note: this model is weaker than Claude at Urdu writing and long
 * structured plans; output is still re-validated with Zod and by the
 * pipeline's own validators, never trusted blindly.
 */

export const CLOUDFLARE_LLM_MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"] as const;
type CfLlmModel = (typeof CLOUDFLARE_LLM_MODELS)[number];

const LIMITS: Record<CfLlmModel, { context: number; neuronsPerMIn: number; neuronsPerMOut: number }> = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { context: 24_000, neuronsPerMIn: 26_668, neuronsPerMOut: 204_805 },
};

/** Conservative token estimate (Urdu/Arabic script tokenizes densely). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

type RunResponse = {
  success?: boolean;
  result?: { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  errors?: Array<{ code?: number; message?: string }>;
};

export class CloudflareLlmProvider implements LlmProvider {
  readonly info: ProviderInfo;
  private readonly url: string;

  constructor(private readonly opts: { accountId: string; apiToken: string; model?: string }) {
    const model = (opts.model ?? CLOUDFLARE_LLM_MODELS[0]) as CfLlmModel;
    if (!(CLOUDFLARE_LLM_MODELS as readonly string[]).includes(model)) {
      throw new Error(`Unsupported Cloudflare LLM model ${model} (supported: ${CLOUDFLARE_LLM_MODELS.join(", ")})`);
    }
    if (!/^[a-f0-9]{32}$/i.test(opts.accountId)) throw new Error("CLOUDFLARE_ACCOUNT_ID must be the 32-character account id");
    this.info = { id: "cloudflare", displayName: "Cloudflare Workers AI (free tier LLM)", capability: "llm", model };
    this.url = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/ai/run/${model}`;
  }

  private get model(): CfLlmModel {
    return this.info.model as CfLlmModel;
  }

  private async run(body: Record<string, unknown>, timeoutMs: number): Promise<NonNullable<RunResponse["result"]>> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ProviderError({ provider: "cloudflare", message: `Cloudflare request failed: ${(err as Error).message}`, retryable: true, cause: err });
    }
    const json = (await res.json().catch(() => null)) as RunResponse | null;
    if (!res.ok || !json?.success || !json.result) {
      const e = json?.errors?.[0];
      const jsonModeFailed = /JSON Mode couldn't be met/i.test(e?.message ?? "");
      throw new ProviderError({
        provider: "cloudflare",
        message: `Cloudflare Workers AI HTTP ${res.status}${e?.message ? `: ${e.message}` : ""}`,
        retryable: jsonModeFailed || isRetryableStatus(res.status),
        status: res.status,
        code: jsonModeFailed ? "invalid_json" : e?.code !== undefined ? String(e.code) : undefined,
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      });
    }
    return json.result;
  }

  async validate(): Promise<ValidationResult> {
    try {
      await this.run(
        {
          messages: [{ role: "user", content: 'Reply with the JSON object {"ok": true}.' }],
          max_tokens: 16,
          response_format: { type: "json_object" },
        },
        30_000,
      );
      return { ok: true, message: `Model ${this.model} answered (free tier; weaker Urdu than Claude).` };
    } catch (err) {
      return { ok: false, message: toProviderError("cloudflare", err).message };
    }
  }

  async generateStructured<S extends z.ZodType>(args: {
    schema: S;
    system: string;
    prompt: string;
    maxTokens?: number;
    effort?: "low" | "medium" | "high";
  }): Promise<{ data: z.infer<S>; usage: LlmUsage; cost?: CostInfo }> {
    const jsonSchema = z.toJSONSchema(args.schema, { target: "draft-7", unrepresentable: "any" });
    const system = `${args.system}\n\nRespond with ONE JSON object only (no prose, no markdown) that validates against this JSON Schema:\n${JSON.stringify(jsonSchema)}`;
    const limits = LIMITS[this.model];
    const inputEstimate = estimateTokens(system) + estimateTokens(args.prompt) + 64;
    const room = limits.context - inputEstimate;
    if (room < 1024) {
      throw new ProviderError({
        provider: "cloudflare",
        message: `The script is too long for ${this.model} (context ${limits.context} tokens). Use a shorter script or the Anthropic provider.`,
        retryable: false,
        code: "context_length",
      });
    }
    const maxTokens = Math.min(args.maxTokens ?? 8192, room);

    const result = await this.run(
      {
        messages: [
          { role: "system", content: system },
          { role: "user", content: args.prompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.4,
        response_format: { type: "json_schema", json_schema: jsonSchema },
      },
      600_000,
    );

    const usage: LlmUsage = {
      inputTokens: result.usage?.prompt_tokens ?? 0,
      outputTokens: result.usage?.completion_tokens ?? 0,
    };
    const neurons = (usage.inputTokens * limits.neuronsPerMIn + usage.outputTokens * limits.neuronsPerMOut) / 1_000_000;
    const cost: CostInfo = { amount: Math.round(neurons * 100) / 100, unit: "neurons" };

    // JSON Mode returns the object itself; plain text is parsed defensively.
    let json: unknown = result.response;
    if (typeof json === "string") {
      const text = json.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      try {
        json = JSON.parse(text);
      } catch {
        throw new ProviderError({
          provider: "cloudflare",
          message:
            usage.outputTokens >= maxTokens
              ? "The language model output was truncated. Try a shorter script."
              : "The language model returned invalid JSON.",
          retryable: usage.outputTokens < maxTokens,
          code: usage.outputTokens >= maxTokens ? "max_tokens" : "invalid_json",
        });
      }
    }
    const parsed = args.schema.safeParse(json);
    if (!parsed.success) {
      throw new ProviderError({
        provider: "cloudflare",
        message: `The language model output failed schema validation: ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        retryable: true,
        code: "schema_mismatch",
      });
    }
    return { data: parsed.data, usage, cost };
  }
}
