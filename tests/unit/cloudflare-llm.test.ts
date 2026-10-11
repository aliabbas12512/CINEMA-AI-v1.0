import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CloudflareLlmProvider } from "@/server/providers/adapters/cloudflare-llm";

// Isolated adapter test: the Workers AI HTTP endpoint is stubbed with recorded-shape responses.
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const schema = z.object({ title: z.string(), scenes: z.array(z.object({ n: z.number() })) });

function stubFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("Cloudflare Workers AI LLM adapter", () => {
  it("sends JSON Mode with the Zod-derived schema and validates the object response", async () => {
    const fn = stubFetch({ success: true, result: { response: { title: "Zain", scenes: [{ n: 1 }] }, usage: { prompt_tokens: 1000, completion_tokens: 500 } } });
    const llm = new CloudflareLlmProvider({ accountId: ACCOUNT, apiToken: "t" });
    const out = await llm.generateStructured({ schema, system: "sys", prompt: "story", maxTokens: 4000 });
    expect(out.data).toEqual({ title: "Zain", scenes: [{ n: 1 }] });
    expect(out.usage).toEqual({ inputTokens: 1000, outputTokens: 500 });
    expect(out.cost?.unit).toBe("neurons");
    expect(out.cost?.amount).toBeCloseTo((1000 * 26668 + 500 * 204805) / 1e6, 1);
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`);
    const body = JSON.parse(String(init.body));
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.properties.title.type).toBe("string");
    expect(body.max_tokens).toBe(4000);
  });

  it("parses a JSON string response and rejects schema mismatches as retryable", async () => {
    stubFetch({ success: true, result: { response: '```json\n{"title":"x","scenes":[{"n":2}]}\n```' } });
    const llm = new CloudflareLlmProvider({ accountId: ACCOUNT, apiToken: "t" });
    expect((await llm.generateStructured({ schema, system: "s", prompt: "p" })).data.scenes[0]!.n).toBe(2);
    stubFetch({ success: true, result: { response: { title: 5 } } });
    await expect(llm.generateStructured({ schema, system: "s", prompt: "p" })).rejects.toMatchObject({ code: "schema_mismatch", retryable: true });
  });

  it("maps 'JSON Mode couldn't be met' to a retryable invalid_json error and refuses over-long input", async () => {
    stubFetch({ success: false, errors: [{ code: 5006, message: "JSON Mode couldn't be met" }] }, 400);
    const llm = new CloudflareLlmProvider({ accountId: ACCOUNT, apiToken: "t" });
    await expect(llm.generateStructured({ schema, system: "s", prompt: "p" })).rejects.toMatchObject({ code: "invalid_json", retryable: true });
    await expect(llm.generateStructured({ schema, system: "s", prompt: "x".repeat(60_000) })).rejects.toMatchObject({ code: "context_length", retryable: false });
  });
});
