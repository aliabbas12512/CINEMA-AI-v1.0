import { z } from "zod";
import { ffmpeg, n } from "./ffmpeg";

/**
 * FFmpeg audio processing: per-scene voice tracks, music/SFX beds, final mix
 * with sidechain ducking, two-pass EBU R128 loudness normalization and a true
 * peak limiter (no clipping).
 */

export const SAMPLE_RATE = 48000;
const FMT = `aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;

export type PlacedClip = { path: string; startSec: number; gainDb?: number; maxDurationSec?: number };

function wavOut(out: string): string[] {
  return ["-c:a", "pcm_s16le", "-ar", String(SAMPLE_RATE), "-ac", "2", out];
}

export async function silence(durationSec: number, out: string): Promise<void> {
  await ffmpeg(["-f", "lavfi", "-t", n(durationSec), "-i", `anullsrc=r=${SAMPLE_RATE}:cl=stereo`, ...wavOut(out)]);
}

/** Place clips on a silent bed of exact duration. */
export async function placeClips(clips: PlacedClip[], durationSec: number, out: string): Promise<void> {
  if (clips.length === 0) return silence(durationSec, out);
  const args: string[] = [];
  const parts: string[] = [];
  clips.forEach((c, i) => {
    args.push("-i", c.path);
    const ms = Math.max(0, Math.round(c.startSec * 1000));
    const trim = c.maxDurationSec ? `,atrim=0:${n(c.maxDurationSec)}` : "";
    const gain = c.gainDb ? `,volume=${n(c.gainDb, 2)}dB` : "";
    parts.push(`[${i}:a]${FMT}${trim}${gain},adelay=${ms}|${ms}[a${i}]`);
  });
  const inputs = clips.map((_, i) => `[a${i}]`).join("");
  const graph =
    `${parts.join(";")};${inputs}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,` +
    `apad=whole_dur=${n(durationSec)},atrim=0:${n(durationSec)}[out]`;
  await ffmpeg([...args, "-filter_complex", graph, "-map", "[out]", ...wavOut(out)]);
}

/** Loop/trim a music cue to the scene length with gentle fades. */
export async function musicBed(path: string, durationSec: number, out: string): Promise<void> {
  const fade = Math.min(2, durationSec / 4);
  const graph =
    `[0:a]${FMT},atrim=0:${n(durationSec)},apad=whole_dur=${n(durationSec)},` +
    `afade=t=in:st=0:d=${n(fade)},afade=t=out:st=${n(Math.max(0, durationSec - fade))}:d=${n(fade)}[out]`;
  await ffmpeg(["-stream_loop", "-1", "-i", path, "-filter_complex", graph, "-map", "[out]", "-t", n(durationSec), ...wavOut(out)]);
}

export async function concatAudio(paths: string[], out: string): Promise<void> {
  if (paths.length === 0) throw new Error("concatAudio requires at least one input");
  if (paths.length === 1) {
    await ffmpeg(["-i", paths[0]!, "-af", FMT, ...wavOut(out)]);
    return;
  }
  const args = paths.flatMap((p) => ["-i", p]);
  const inputs = paths.map((_, i) => `[${i}:a]${FMT}[c${i}]`).join(";");
  const graph = `${inputs};${paths.map((_, i) => `[c${i}]`).join("")}concat=n=${paths.length}:v=0:a=1[out]`;
  await ffmpeg([...args, "-filter_complex", graph, "-map", "[out]", ...wavOut(out)]);
}

const LoudnormSchema = z.object({
  input_i: z.string(),
  input_tp: z.string(),
  input_lra: z.string(),
  input_thresh: z.string(),
  target_offset: z.string(),
});

export type Loudness = { integratedLufs: number; truePeakDb: number; lra: number; thresh: number; offset: number };

function parseLoudnorm(stderr: string): Loudness {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("loudnorm produced no measurement");
  const j = LoudnormSchema.parse(JSON.parse(stderr.slice(start, end + 1)));
  return {
    integratedLufs: Number(j.input_i),
    truePeakDb: Number(j.input_tp),
    lra: Number(j.input_lra),
    thresh: Number(j.input_thresh),
    offset: Number(j.target_offset),
  };
}

export const LOUDNESS_TARGET = { I: -16, TP: -1.5, LRA: 11 } as const;

export async function measureLoudness(path: string): Promise<Loudness> {
  const { stderr } = await ffmpeg([
    "-i",
    path,
    "-af",
    `loudnorm=I=${LOUDNESS_TARGET.I}:TP=${LOUDNESS_TARGET.TP}:LRA=${LOUDNESS_TARGET.LRA}:print_format=json`,
    "-f",
    "null",
    "-",
  ]);
  return parseLoudnorm(stderr);
}

/**
 * Final mix: dialogue/narration on top, music ducked under speech via
 * sidechain compression, SFX/ambience bed, then two-pass loudness
 * normalization and a limiter at -1 dBFS.
 */
export async function mixFinal(args: { voice: string; music: string; sfx: string; durationSec: number; out: string }): Promise<Loudness> {
  const pre = `${args.out}.premix.wav`;
  const graph =
    `[0:a]${FMT},asplit=2[vo][vsc];` +
    `[1:a]${FMT},volume=-13dB[mu];` +
    `[mu][vsc]sidechaincompress=threshold=0.015:ratio=10:attack=15:release=450:makeup=1[duck];` +
    `[2:a]${FMT},volume=-5dB[fx];` +
    `[vo][duck][fx]amix=inputs=3:normalize=0:duration=first:dropout_transition=0,` +
    `atrim=0:${n(args.durationSec)}[out]`;
  await ffmpeg(["-i", args.voice, "-i", args.music, "-i", args.sfx, "-filter_complex", graph, "-map", "[out]", ...wavOut(pre)]);

  const m = await measureLoudness(pre);
  const silent = !Number.isFinite(m.integratedLufs) || m.integratedLufs < -70;
  const norm = silent
    ? "anull"
    : `loudnorm=I=${LOUDNESS_TARGET.I}:TP=${LOUDNESS_TARGET.TP}:LRA=${LOUDNESS_TARGET.LRA}:` +
      `measured_I=${n(m.integratedLufs, 2)}:measured_TP=${n(m.truePeakDb, 2)}:measured_LRA=${n(m.lra, 2)}:` +
      `measured_thresh=${n(m.thresh, 2)}:offset=${n(m.offset, 2)}:linear=true`;
  await ffmpeg([
    "-i",
    pre,
    "-af",
    `${norm},alimiter=limit=0.89:level=false,${FMT}`,
    "-t",
    n(args.durationSec),
    ...wavOut(args.out),
  ]);
  return silent ? m : measureLoudness(args.out);
}

/** Extract [start, start+duration) of an audio file. */
export async function cutAudio(path: string, startSec: number, durationSec: number, out: string): Promise<void> {
  await ffmpeg(["-ss", n(startSec), "-t", n(durationSec), "-i", path, "-af", FMT, ...wavOut(out)]);
}
