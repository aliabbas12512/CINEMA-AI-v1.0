import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpeg } from "@/server/media/ffmpeg";
import { probe } from "@/server/media/probe";
import { qcShotClip } from "@/server/media/qc";
import { FfmpegMotionVideoProvider, motionFor, type MotionKind } from "@/server/providers/adapters/ffmpeg-motion";
import { imageSize } from "@/server/providers/adapters/cloudflare-image";

let dir = "";
let keyframe: Buffer;

describe("ffmpeg_motion video provider (real FFmpeg)", () => {
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "afs-motion-test-"));
    const img = path.join(dir, "kf.png");
    // A detailed still (like an AI keyframe): mandelbrot gives texture everywhere.
    await ffmpeg(["-f", "lavfi", "-i", "mandelbrot=size=1344x768", "-frames:v", "1", img]);
    keyframe = await readFile(img);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("maps planner camera language to motivated moves", () => {
    expect(motionFor("establishing; slow aerial reveal")).toBe("pull_out");
    expect(motionFor("close_up; dolly in")).toBe("push_in");
    expect(motionFor("orbit; circling")).toBe("orbit");
    expect(motionFor("crane; rising")).toBe("crane_up");
    expect(motionFor("tracking; follow", 0)).toBe("pan_right");
    expect(motionFor("tracking; follow", 1)).toBe("pan_left");
    expect(motionFor("medium; static")).toBe("drift");
  });

  const cases: Array<[string, MotionKind]> = [
    ["close_up; dolly in", "push_in"],
    ["establishing", "pull_out"],
    ["tracking", "pan_right"],
    ["crane", "crane_up"],
    ["orbit", "orbit"],
    ["medium; static", "drift"],
  ];
  for (const [camera, kind] of cases) {
    it(`renders a real ${kind} clip that passes shot QC`, async () => {
      const p = new FfmpegMotionVideoProvider();
      const sub = await p.submit({ prompt: "x", firstFrame: { data: keyframe, mimeType: "image/png", ext: "png" }, durationSec: 4, aspect: "16:9", camera });
      const st = await p.getStatus(sub.externalId);
      expect(st.state).toBe("succeeded");
      const out = await p.download(st);
      expect(out.meta?.motion).toBe(kind);
      const file = path.join(dir, `${kind}.mp4`);
      await writeFile(file, out.data);
      const info = await probe(file);
      expect(info.video?.width).toBe(1920);
      expect(info.video?.height).toBe(1080);
      expect(info.durationSec).toBeCloseTo(4, 1);
      const qc = await qcShotClip(file, 3.6);
      expect(qc.results.filter((r) => !r.passed)).toEqual([]);
    });
  }

  it("supports vertical output and rejects unsupported durations", async () => {
    const p = new FfmpegMotionVideoProvider();
    const out = await p.render({ prompt: "x", firstFrame: { data: keyframe, mimeType: "image/png", ext: "png" }, durationSec: 2, aspect: "9:16" });
    const file = path.join(dir, "v.mp4");
    await writeFile(file, out.data);
    expect((await probe(file)).video).toMatchObject({ width: 1080, height: 1920 });
    await expect(p.render({ prompt: "x", firstFrame: { data: keyframe, mimeType: "image/png", ext: "png" }, durationSec: 30, aspect: "16:9" })).rejects.toThrow(/Unsupported duration/);
    expect((await p.validate()).ok).toBe(true);
    expect((await p.getStatus("unknown")).state).toBe("failed");
  });

  it("reads PNG/JPEG dimensions for Cloudflare neuron accounting", async () => {
    expect(imageSize(keyframe)).toMatchObject({ width: 1344, height: 768, mime: "image/png" });
    const jpg = path.join(dir, "kf.jpg");
    await ffmpeg(["-i", path.join(dir, "kf.png"), jpg]);
    expect(imageSize(await readFile(jpg))).toMatchObject({ width: 1344, height: 768, mime: "image/jpeg" });
    expect(imageSize(Buffer.from("nope"))).toBeNull();
  });
});
