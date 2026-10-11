import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { concatAudio, measureLoudness, mixFinal, musicBed, placeClips } from "@/server/media/audio";
import { ffmpeg } from "@/server/media/ffmpeg";
import { probe } from "@/server/media/probe";
import { qcFinal, qcShotClip } from "@/server/media/qc";
import { concatVideos, mux, normalizeClip, thumbnail } from "@/server/media/video";

const dir = path.resolve("tmp/test-media");

async function tone(out: string, freq: number, sec: number) {
  await ffmpeg(["-f", "lavfi", "-i", `sine=frequency=${freq}:sample_rate=44100:duration=${sec}`, "-c:a", "pcm_s16le", out]);
}
async function clip(out: string, sec: number, src = "testsrc2") {
  await ffmpeg(["-f", "lavfi", "-i", `${src}=size=1280x720:rate=24:duration=${sec}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
}

describe("FFmpeg media pipeline (real ffmpeg)", () => {
  beforeAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("normalizes clips to exact frame counts, concatenates, mixes and muxes a valid file", async () => {
    const a = path.join(dir, "a.mp4");
    const b = path.join(dir, "b.mp4");
    await clip(a, 4);
    await clip(b, 3);
    const na = path.join(dir, "na.mp4");
    const nb = path.join(dir, "nb.mp4");
    // b is 3s but its slot is 4.5s: slowed + held, must still be exact.
    await normalizeClip({ input: a, out: na, width: 1920, height: 1080, fps: 24, frames: 96, sourceDurationSec: 4, fadeInSec: 0.3 });
    await normalizeClip({ input: b, out: nb, width: 1920, height: 1080, fps: 24, frames: 108, sourceDurationSec: 3, fadeOutSec: 0.3 });
    const pa = await probe(na);
    expect(pa.video?.width).toBe(1920);
    expect(pa.durationSec).toBeCloseTo(4, 1);
    const video = path.join(dir, "video.mp4");
    await concatVideos([na, nb], path.join(dir, "list.txt"), video);
    const pv = await probe(video);
    expect(pv.durationSec).toBeCloseTo(8.5, 1);

    const v1 = path.join(dir, "v1.wav");
    const v2 = path.join(dir, "v2.wav");
    await tone(v1, 440, 2);
    await tone(v2, 660, 1.5);
    const voice = path.join(dir, "voice.wav");
    await placeClips([{ path: v1, startSec: 0.6 }, { path: v2, startSec: 3.2 }], 8.5, voice);
    const m = path.join(dir, "m.wav");
    await tone(m, 220, 3);
    const music = path.join(dir, "music.wav");
    await musicBed(m, 8.5, music); // loops a 3s cue to 8.5s
    expect((await probe(music)).durationSec).toBeCloseTo(8.5, 1);
    const sfx = path.join(dir, "sfx.wav");
    await placeClips([], 8.5, sfx);
    const mixed = path.join(dir, "mix.wav");
    const loud = await mixFinal({ voice, music, sfx, durationSec: 8.5, out: mixed });
    expect(loud.truePeakDb).toBeLessThanOrEqual(-0.9);
    expect(loud.integratedLufs).toBeGreaterThan(-19);
    expect(loud.integratedLufs).toBeLessThan(-13);

    const srt = path.join(dir, "subs.srt");
    await (await import("node:fs/promises")).writeFile(srt, "1\n00:00:00,600 --> 00:00:02,600\nسلام\n");
    const final = path.join(dir, "final.mp4");
    await mux({ video, audio: mixed, out: final, durationSec: 8.5, softSubtitle: { path: srt, language: "urd" } });
    const qc = await qcFinal(final, { width: 1920, height: 1080, fps: 24, durationSec: 8.5, expectSubtitleStream: true });
    const failed = qc.results.filter((r) => !r.passed && r.severity === "error");
    expect(failed).toEqual([]);
    // Burned-in Urdu subtitles render through libass without breaking the output.
    const burned = path.join(dir, "burned.mp4");
    await mux({ video, audio: mixed, out: burned, durationSec: 8.5, burnSubtitlePath: srt });
    const pb = await probe(burned);
    expect(pb.video?.codec).toBe("h264");
    expect(pb.durationSec).toBeCloseTo(8.5, 1);
    await thumbnail(final, 1, path.join(dir, "thumb.jpg"));
    expect((await probe(path.join(dir, "thumb.jpg"))).video?.width).toBe(1280);

    const cat = path.join(dir, "cat.wav");
    await concatAudio([v1, v2], cat);
    expect((await probe(cat)).durationSec).toBeCloseTo(3.5, 1);
    expect((await measureLoudness(cat)).integratedLufs).toBeLessThan(0);
  });

  it("QC rejects black and frozen clips and accepts real motion", async () => {
    const black = path.join(dir, "black.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "color=c=black:s=1280x720:r=24:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", black]);
    const r1 = await qcShotClip(black, 3);
    expect(r1.results.find((r) => r.check === "black_frames")?.passed).toBe(false);

    const frozen = path.join(dir, "frozen.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "color=c=0x406080:s=1280x720:r=24:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", frozen]);
    const r2 = await qcShotClip(frozen, 4);
    expect(r2.results.find((r) => r.check === "frozen_frames")?.passed).toBe(false);

    const good = path.join(dir, "good.mp4");
    await clip(good, 3);
    const r3 = await qcShotClip(good, 3);
    expect(r3.results.every((r) => r.passed)).toBe(true);

    const empty = path.join(dir, "empty.mp4");
    await (await import("node:fs/promises")).writeFile(empty, "");
    expect((await qcShotClip(empty, 1)).results[0]?.check).toBe("zero_byte");
  });
});
