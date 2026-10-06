import { afterEach, describe, expect, it } from "vitest";
import { getEnv, resetEnvCache } from "@/server/env";

const KEYS = ["SPEECH_KEY", "SPEECH_REGION", "VOICE_PROVIDER", "VOICE_PROVIDER_API_KEY", "AZURE_SPEECH_REGION", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "IMAGE_PROVIDER", "VIDEO_PROVIDER"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvCache();
});

describe("environment", () => {
  it("defaults video to the no-cost ffmpeg_motion provider (Runway optional)", () => {
    for (const k of KEYS) delete process.env[k];
    resetEnvCache();
    const env = getEnv();
    expect(env.VIDEO_PROVIDER).toBe("ffmpeg_motion");
    expect(env.IMAGE_PROVIDER).toBe("none");
    expect(env.VOICE_PROVIDER).toBe("none");
  });
  it("SPEECH_KEY / SPEECH_REGION select Azure; empty values count as unset", () => {
    process.env.SPEECH_KEY = "k";
    process.env.SPEECH_REGION = "eastus";
    process.env.VOICE_PROVIDER = "";
    process.env.CLOUDFLARE_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
    process.env.CLOUDFLARE_API_TOKEN = "t";
    resetEnvCache();
    const env = getEnv();
    expect(env.VOICE_PROVIDER).toBe("azure");
    expect(env.VOICE_PROVIDER_API_KEY).toBe("k");
    expect(env.AZURE_SPEECH_REGION).toBe("eastus");
    expect(env.IMAGE_PROVIDER).toBe("cloudflare");
  });
  it("an explicit provider choice wins over aliases", () => {
    process.env.SPEECH_KEY = "k";
    process.env.VOICE_PROVIDER = "none";
    resetEnvCache();
    expect(getEnv().VOICE_PROVIDER).toBe("none");
  });
});
