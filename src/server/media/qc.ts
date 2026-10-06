import { stat } from "node:fs/promises";
import { ffmpeg, ffprobe } from "./ffmpeg";
import { probe, type ProbeInfo } from "./probe";

/**
 * Automated quality control using FFprobe / FFmpeg detectors.
 */

export type QcResult = { check: string; passed: boolean; severity: "error" | "warning" | "info"; details?: Record<string, unknown> };

export async function blackRatio(path: string, durationSec: number): Promise<number> {
  const { stderr } = await ffmpeg(["-i", path, "-vf", "blackdetect=d=0.1:pix_th=0.10", "-an", "-f", "null", "-"]);
  let black = 0;
  for (const m of stderr.matchAll(/black_duration:(\d+(?:\.\d+)?)/g)) black += Number(m[1]);
  return durationSec > 0 ? Math.min(1, black / durationSec) : 0;
}

export async function longestFreeze(path: string, durationSec: number): Promise<number> {
  const { stderr } = await ffmpeg(["-i", path, "-vf", "freezedetect=n=0.003:d=1", "-an", "-f", "null", "-"]);
  let longest = 0;
  for (const m of stderr.matchAll(/freeze_duration:\s*(\d+(?:\.\d+)?)/g)) longest = Math.max(longest, Number(m[1]));
  // A freeze still running at EOF has a start but no end: it lasts until the end of the media.
  const starts = [...stderr.matchAll(/freeze_start:\s*(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(/freeze_end:\s*(\d+(?:\.\d+)?)/g)].length;
  if (starts.length > ends) {
    const openStart = starts[starts.length - 1] ?? 0;
    longest = Math.max(longest, Math.max(0, durationSec - openStart));
  }
  return longest;
}

/** QC for one downloaded provider clip. Failure => shot is marked for regeneration. */
export async function qcShotClip(path: string, expectedMinSec: number): Promise<{ results: QcResult[]; info?: ProbeInfo }> {
  const results: QcResult[] = [];
  const size = (await stat(path)).size;
  if (size === 0) return { results: [{ check: "zero_byte", passed: false, severity: "error" }] };
  let info: ProbeInfo;
  try {
    info = await probe(path);
  } catch (err) {
    return { results: [{ check: "decodable", passed: false, severity: "error", details: { error: (err as Error).message } }] };
  }
  results.push({ check: "decodable", passed: true, severity: "info" });
  const hasVideo = !!info.video && info.video.width > 0;
  results.push({ check: "has_video_stream", passed: hasVideo, severity: "error" });
  if (!hasVideo) return { results, info };
  results.push({
    check: "duration",
    passed: info.durationSec >= expectedMinSec * 0.8,
    severity: "error",
    details: { actual: info.durationSec, expectedMin: expectedMinSec },
  });
  results.push({
    check: "resolution",
    passed: Math.min(info.video!.width, info.video!.height) >= 360,
    severity: "error",
    details: { width: info.video!.width, height: info.video!.height },
  });
  const br = await blackRatio(path, info.durationSec);
  results.push({ check: "black_frames", passed: br < 0.9, severity: "error", details: { blackRatio: br } });
  const fr = await longestFreeze(path, info.durationSec);
  const frozenWhole = info.durationSec > 0 && fr >= info.durationSec * 0.9;
  results.push({ check: "frozen_frames", passed: !frozenWhole, severity: "error", details: { longestFreezeSec: fr } });
  return { results, info };
}

export async function qcAudioFile(path: string, expectedMinSec: number): Promise<QcResult[]> {
  const size = (await stat(path)).size;
  if (size === 0) return [{ check: "zero_byte", passed: false, severity: "error" }];
  try {
    const info = await probe(path);
    return [
      { check: "has_audio_stream", passed: !!info.audio, severity: "error" },
      { check: "duration", passed: info.durationSec >= expectedMinSec, severity: "error", details: { actual: info.durationSec } },
    ];
  } catch (err) {
    return [{ check: "decodable", passed: false, severity: "error", details: { error: (err as Error).message } }];
  }
}

export type FinalExpectations = {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  expectSubtitleStream: boolean;
};

/** QC for the final render. Any failed "error" check blocks delivery. */
export async function qcFinal(path: string, exp: FinalExpectations): Promise<{ results: QcResult[]; info?: ProbeInfo }> {
  const results: QcResult[] = [];
  const size = (await stat(path)).size;
  if (size === 0) return { results: [{ check: "zero_byte", passed: false, severity: "error" }] };
  let info: ProbeInfo;
  try {
    info = await probe(path);
  } catch (err) {
    return { results: [{ check: "decodable", passed: false, severity: "error", details: { error: (err as Error).message } }] };
  }
  const v = info.video;
  const a = info.audio;
  results.push({ check: "video_codec_h264", passed: v?.codec === "h264", severity: "error", details: { codec: v?.codec } });
  results.push({ check: "pixel_format", passed: v?.pixFmt === "yuv420p", severity: "error", details: { pixFmt: v?.pixFmt } });
  results.push({ check: "audio_codec_aac", passed: a?.codec === "aac", severity: "error", details: { codec: a?.codec } });
  results.push({
    check: "resolution",
    passed: v?.width === exp.width && v?.height === exp.height,
    severity: "error",
    details: { width: v?.width, height: v?.height, expected: `${exp.width}x${exp.height}` },
  });
  results.push({
    check: "frame_rate",
    passed: !!v && Math.abs(v.fps - exp.fps) < 0.01,
    severity: "error",
    details: { fps: v?.fps },
  });
  results.push({
    check: "duration",
    passed: Math.abs(info.durationSec - exp.durationSec) <= 0.5,
    severity: "error",
    details: { actual: info.durationSec, expected: exp.durationSec },
  });
  if (exp.expectSubtitleStream) {
    results.push({ check: "subtitle_stream", passed: info.subtitleStreams > 0, severity: "error" });
  }
  // A/V sync: compare stream durations.
  const { stdout } = await ffprobe(["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", path]);
  const streams = (JSON.parse(stdout) as { streams: Array<{ codec_type: string; duration?: string }> }).streams;
  const vd = Number(streams.find((s) => s.codec_type === "video")?.duration ?? NaN);
  const ad = Number(streams.find((s) => s.codec_type === "audio")?.duration ?? NaN);
  results.push({
    check: "av_sync",
    passed: Number.isFinite(vd) && Number.isFinite(ad) && Math.abs(vd - ad) <= 0.25,
    severity: "error",
    details: { videoSec: vd, audioSec: ad },
  });
  const br = await blackRatio(path, info.durationSec);
  results.push({ check: "black_frames", passed: br < 0.15, severity: br < 0.4 ? "warning" : "error", details: { blackRatio: br } });
  const fr = await longestFreeze(path, info.durationSec);
  results.push({
    check: "frozen_frames",
    passed: fr < 8,
    severity: "warning",
    details: { longestFreezeSec: fr },
  });
  return { results, info };
}

export function blocking(results: QcResult[]): QcResult[] {
  return results.filter((r) => !r.passed && r.severity === "error");
}
