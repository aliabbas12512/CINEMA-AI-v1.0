import { z } from "zod";
import { ffprobe } from "./ffmpeg";

const StreamSchema = z.object({
  index: z.number(),
  codec_type: z.string(),
  codec_name: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  pix_fmt: z.string().optional(),
  r_frame_rate: z.string().optional(),
  sample_rate: z.string().optional(),
  channels: z.number().optional(),
  duration: z.string().optional(),
});

const ProbeSchema = z.object({
  streams: z.array(StreamSchema).default([]),
  format: z
    .object({
      format_name: z.string().optional(),
      duration: z.string().optional(),
      size: z.string().optional(),
      bit_rate: z.string().optional(),
    })
    .default({}),
});

export type ProbeInfo = {
  formatName: string;
  durationSec: number;
  sizeBytes: number;
  video?: { codec: string; width: number; height: number; fps: number; pixFmt?: string };
  audio?: { codec: string; sampleRate: number; channels: number };
  subtitleStreams: number;
};

function parseRate(r: string | undefined): number {
  if (!r) return 0;
  const [a, b] = r.split("/").map(Number);
  if (!a || !b) return 0;
  return a / b;
}

export async function probe(filePath: string): Promise<ProbeInfo> {
  const { stdout } = await ffprobe(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath]);
  const data = ProbeSchema.parse(JSON.parse(stdout));
  const v = data.streams.find((s) => s.codec_type === "video" && s.codec_name !== "png" && s.codec_name !== "mjpeg");
  const img = data.streams.find((s) => s.codec_type === "video");
  const a = data.streams.find((s) => s.codec_type === "audio");
  const vs = v ?? img;
  return {
    formatName: data.format.format_name ?? "unknown",
    durationSec: Number(data.format.duration ?? vs?.duration ?? a?.duration ?? 0) || 0,
    sizeBytes: Number(data.format.size ?? 0) || 0,
    video: vs
      ? {
          codec: vs.codec_name ?? "unknown",
          width: vs.width ?? 0,
          height: vs.height ?? 0,
          fps: parseRate(vs.r_frame_rate),
          pixFmt: vs.pix_fmt,
        }
      : undefined,
    audio: a
      ? { codec: a.codec_name ?? "unknown", sampleRate: Number(a.sample_rate ?? 0), channels: a.channels ?? 0 }
      : undefined,
    subtitleStreams: data.streams.filter((s) => s.codec_type === "subtitle").length,
  };
}
