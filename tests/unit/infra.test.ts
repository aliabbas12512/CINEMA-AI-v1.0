import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSsml, escapeXml } from "@/server/providers/adapters/azure-voice";
import { anthropicCost } from "@/server/providers/adapters/anthropic-llm";
import { isRetryableStatus, parseRetryAfter, ProviderError, ProviderNotConfiguredError, toProviderError } from "@/server/providers/errors";
import { assertPublicHttpsUrl, isPrivateAddress } from "@/server/http/safe-fetch";
import { computeDelay, mapLimit, withRetry } from "@/server/pipeline/retry";
import { LocalStorage } from "@/server/storage/local";
import { assertValidKey, storageKey } from "@/server/storage/types";
import { escapeFilterPath } from "@/server/media/video";
import { hashPassword, verifyPassword } from "@/server/auth/password";

const PID = "11111111-2222-3333-4444-555555555555";

describe("retry logic", () => {
  it("retries retryable errors with exponential backoff, then succeeds", async () => {
    const delays: number[] = [];
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new ProviderError({ provider: "x", message: "503", retryable: true, status: 503 });
        return "ok";
      },
      { maxRetries: 3, baseDelayMs: 100, sleep: async (ms) => void delays.push(ms), random: () => 1 },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });
  it("does not retry permanent errors and stops at MAX_RETRIES", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new ProviderError({ provider: "x", message: "401", retryable: false, status: 401 });
      }, { maxRetries: 3, baseDelayMs: 1, sleep: async () => undefined }),
    ).rejects.toThrow("401");
    expect(calls).toBe(1);
    calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new ProviderError({ provider: "x", message: "429", retryable: true });
      }, { maxRetries: 2, baseDelayMs: 1, sleep: async () => undefined }),
    ).rejects.toThrow();
    expect(calls).toBe(3);
  });
  it("honours Retry-After and classifies HTTP statuses", () => {
    const e = new ProviderError({ provider: "x", message: "429", retryable: true, retryAfterMs: 30_000 });
    expect(computeDelay(1, { maxRetries: 3, baseDelayMs: 100 }, e)).toBe(30_000);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(parseRetryAfter("7")).toBe(7000);
    expect(toProviderError("p", { status: 503, message: "busy" }).retryable).toBe(true);
    expect(toProviderError("p", { status: 422, message: "bad" }).retryable).toBe(false);
    expect(new ProviderNotConfiguredError("video").message).toBe("Video generation provider is not configured.");
  });
  it("mapLimit stops scheduling after the first failure and waits for in-flight work", async () => {
    const started: number[] = [];
    let inflight = 0;
    let maxInflight = 0;
    await expect(
      mapLimit([0, 1, 2, 3, 4, 5], 2, async (i) => {
        started.push(i);
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 20));
        inflight--;
        if (i === 1) throw new Error("boom");
        return i;
      }),
    ).rejects.toThrow("boom");
    expect(maxInflight).toBe(2);
    expect(inflight).toBe(0);
    expect(started.length).toBeLessThan(6);
  });
});

describe("security helpers", () => {
  it("SSRF guard rejects private, loopback, metadata and non-https URLs", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1", "0.0.0.0"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    await expect(assertPublicHttpsUrl("http://example.com/x")).rejects.toThrow(/non-https/);
    await expect(assertPublicHttpsUrl("https://169.254.169.254/latest")).rejects.toThrow(/private/);
    await expect(assertPublicHttpsUrl("https://user:pw@example.com")).rejects.toThrow(/credentials/);
  });
  it("SSML is escaped so script text cannot inject markup", () => {
    const ssml = buildSsml({
      text: `ok</prosody><voice name="evil">& "x"`,
      locale: "ur-PK",
      voice: { providerVoiceId: "ur-PK-AsadNeural", settings: { pitch: "+5%", rate: "-4%" } },
    });
    expect(ssml).toContain("&lt;/prosody&gt;&lt;voice name=&quot;evil&quot;&gt;&amp;");
    expect(ssml).toContain('<voice name="ur-PK-AsadNeural">');
    expect(ssml).toContain('pitch="+5%"');
    const bad = buildSsml({ text: "x", locale: "ur-PK", voice: { providerVoiceId: "ur-PK-UzmaNeural", settings: { pitch: '"/><x' } } });
    expect(bad).toContain('pitch="+0%"');
    expect(() => buildSsml({ text: "x", locale: "ur-PK", voice: { providerVoiceId: "x\"><evil", settings: {} } })).toThrow();
    expect(escapeXml("<&>")).toBe("&lt;&amp;&gt;");
  });
  it("FFmpeg filter paths are escaped", () => {
    expect(escapeFilterPath("/a/b:c'd,[e]")).toBe("/a/b\\:c\\'d\\,\\[e\\]");
  });
  it("passwords are hashed with scrypt and verified in constant time", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("storage", () => {
  it("only accepts server-generated keys under projects/{uuid}/{folder}/", () => {
    expect(storageKey(PID, "shots", "video-1.mp4")).toBe(`projects/${PID}/shots/video-1.mp4`);
    const k = storageKey(PID, "final", "../../etc/passwd");
    expect(k.startsWith(`projects/${PID}/final/`)).toBe(true);
    expect(k).not.toContain("..");
    expect(() => assertValidKey(`projects/${PID}/shots/../../x`)).toThrow();
    expect(() => assertValidKey("etc/passwd")).toThrow();
  });
  it("local driver round-trips data with byte ranges", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "afs-store-"));
    try {
      const s = new LocalStorage(dir);
      const key = storageKey(PID, "audio", "a.wav");
      await s.put(key, Buffer.from("0123456789"), "audio/wav");
      expect((await s.stat(key))?.size).toBe(10);
      const chunks: Buffer[] = [];
      for await (const c of await s.getStream(key, { start: 2, end: 5 })) chunks.push(c as Buffer);
      expect(Buffer.concat(chunks).toString()).toBe("2345");
      await s.delete(key);
      expect(await s.stat(key)).toBeNull();
      expect(await s.signedUrl()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("cost tracking", () => {
  it("computes LLM cost only for models with documented prices", () => {
    expect(anthropicCost("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 100_000 })).toEqual({ amount: 6, unit: "usd" });
    expect(anthropicCost("some-unknown-model", { inputTokens: 1, outputTokens: 1 })).toBeUndefined();
  });
});
