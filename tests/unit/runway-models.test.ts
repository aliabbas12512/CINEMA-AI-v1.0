import { describe, expect, it } from "vitest";
import { RUNWAY_VIDEO_MODELS, RunwayVideoProvider } from "@/server/providers/adapters/runway";

describe("Runway video models", () => {
  it("offers gen4_turbo with 5/10 s clips at 1280x720", () => {
    expect(RUNWAY_VIDEO_MODELS).toContain("gen4_turbo");
    const p = new RunwayVideoProvider({ apiKey: "test-key", model: "gen4_turbo" });
    expect(p.capabilities.durations).toEqual([5, 10]);
    expect([p.capabilities.nativeWidth, p.capabilities.nativeHeight]).toEqual([1280, 720]);
  });
  it("rejects unsupported durations before calling the API", async () => {
    const p = new RunwayVideoProvider({ apiKey: "test-key", model: "gen4_turbo" });
    await expect(
      p.submit({ prompt: "x", durationSec: 7, aspect: "16:9", firstFrame: { data: Buffer.from([]), mimeType: "image/png", ext: "png" } } as never),
    ).rejects.toMatchObject({ retryable: false });
  });
});
