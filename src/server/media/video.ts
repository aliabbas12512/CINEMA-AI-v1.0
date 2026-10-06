import { writeFile } from "node:fs/promises";
import { ffmpeg, n } from "./ffmpeg";
import { MAX_SLOWDOWN } from "./timeline";

/**
 * FFmpeg video processing. Every shot is normalized to an exact frame count
 * at the project resolution/fps so the concatenated picture matches the audio
 * timeline frame-accurately.
 */

export type NormalizeArgs = {
  input: string;
  out: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  sourceDurationSec: number;
  fadeInSec?: number;
  fadeOutSec?: number;
};

export async function normalizeClip(a: NormalizeArgs): Promise<void> {
  if (a.frames <= 0) throw new Error("normalizeClip: frames must be positive");
  const target = a.frames / a.fps;
  const filters: string[] = [];
  // Slow down a short clip (bounded), then hold the last frame for any remainder.
  if (a.sourceDurationSec > 0 && a.sourceDurationSec < target) {
    const factor = Math.min(MAX_SLOWDOWN, target / a.sourceDurationSec);
    if (factor > 1.001) filters.push(`setpts=${n(factor, 4)}*PTS`);
  }
  filters.push(
    `scale=${a.width}:${a.height}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${a.width}:${a.height}`,
    "setsar=1",
    `fps=${a.fps}`,
    `tpad=stop_mode=clone:stop_duration=${n(target + 1)}`,
    `trim=end_frame=${a.frames}`,
    "setpts=PTS-STARTPTS",
  );
  if (a.fadeInSec && a.fadeInSec > 0) filters.push(`fade=t=in:st=0:d=${n(a.fadeInSec)}`);
  if (a.fadeOutSec && a.fadeOutSec > 0) filters.push(`fade=t=out:st=${n(Math.max(0, target - a.fadeOutSec))}:d=${n(a.fadeOutSec)}`);
  filters.push("format=yuv420p");
  await ffmpeg([
    "-i",
    a.input,
    "-an",
    "-vf",
    filters.join(","),
    "-frames:v",
    String(a.frames),
    "-r",
    String(a.fps),
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-video_track_timescale",
    String(a.fps * 1000),
    a.out,
  ]);
}

function concatListLine(p: string): string {
  // Paths are server-generated; still escape quotes per concat demuxer rules.
  return `file '${p.replace(/'/g, "'\\''")}'`;
}

export async function concatVideos(paths: string[], listPath: string, out: string): Promise<void> {
  if (paths.length === 0) throw new Error("concatVideos requires inputs");
  await writeFile(listPath, paths.map(concatListLine).join("\n") + "\n", "utf8");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", out]);
}

export type MuxArgs = {
  video: string;
  audio: string;
  out: string;
  durationSec: number;
  softSubtitle?: { path: string; language: "urd" | "eng" };
  burnSubtitlePath?: string;
};

/** Escape a path for use inside an FFmpeg filter argument (subtitles=...). */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/\[/g, "\\[").replace(/\]/g, "\\]").replace(/,/g, "\\,");
}

export async function mux(a: MuxArgs): Promise<void> {
  const args = ["-i", a.video, "-i", a.audio];
  if (a.softSubtitle) args.push("-i", a.softSubtitle.path);
  args.push("-map", "0:v:0", "-map", "1:a:0");
  if (a.softSubtitle) args.push("-map", "2:s:0");
  if (a.burnSubtitlePath) {
    args.push(
      "-vf",
      `subtitles='${escapeFilterPath(a.burnSubtitlePath)}':force_style='FontSize=22,Outline=2,Shadow=0,MarginV=40'`,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
    );
  } else {
    args.push("-c:v", "copy");
  }
  args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
  if (a.softSubtitle) args.push("-c:s", "mov_text", "-metadata:s:s:0", `language=${a.softSubtitle.language}`);
  args.push("-t", n(a.durationSec), "-movflags", "+faststart", a.out);
  await ffmpeg(args);
}

export async function thumbnail(video: string, atSec: number, out: string): Promise<void> {
  await ffmpeg(["-ss", n(atSec), "-i", video, "-frames:v", "1", "-vf", "scale=1280:-2:flags=lanczos", "-q:v", "3", out]);
}

/** Small 480p preview of a scene for the project page. */
export async function scenePreview(video: string, audio: string, out: string): Promise<void> {
  await ffmpeg([
    "-i",
    video,
    "-i",
    audio,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-vf",
    "scale=-2:480:flags=bicubic",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "26",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-shortest",
    "-movflags",
    "+faststart",
    out,
  ]);
}
