import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Media } from "@/server/providers/types";
import { ffmpeg } from "./ffmpeg";

/**
 * Convert media into a base64 data URI under a byte limit (Runway accepts
 * data URIs up to 5MB). Oversized images are re-encoded to JPEG with FFmpeg.
 */
export async function toDataUri(media: Media, maxBytes = 4.5 * 1024 * 1024): Promise<string> {
  let m = media;
  if (m.data.byteLength > maxBytes && m.mimeType.startsWith("image/")) {
    m = await shrinkImage(m, maxBytes);
  }
  if (m.data.byteLength > maxBytes) {
    throw new Error(`Media too large for inline upload (${m.data.byteLength} bytes)`);
  }
  return `data:${m.mimeType};base64,${m.data.toString("base64")}`;
}

async function shrinkImage(media: Media, maxBytes: number): Promise<Media> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "afs-img-"));
  try {
    const input = path.join(dir, `in.${media.ext}`);
    await writeFile(input, media.data);
    for (const [maxDim, q] of [
      [1920, 3],
      [1600, 5],
      [1280, 7],
    ] as const) {
      const out = path.join(dir, `out-${maxDim}.jpg`);
      await ffmpeg([
        "-i",
        input,
        "-vf",
        `scale='min(${maxDim},iw)':'min(${maxDim},ih)':force_original_aspect_ratio=decrease`,
        "-q:v",
        String(q),
        "-frames:v",
        "1",
        out,
      ]);
      const data = await readFile(out);
      if (data.byteLength <= maxBytes) return { data, mimeType: "image/jpeg", ext: "jpg" };
    }
    throw new Error("Unable to shrink image below the inline size limit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function extFromMime(mime: string | null | undefined, fallback: string): string {
  if (!mime) return fallback;
  const m = mime.split(";")[0]?.trim().toLowerCase();
  switch (m) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "video/mp4":
      return "mp4";
    case "video/quicktime":
      return "mov";
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return "wav";
    default:
      return fallback;
  }
}

export function mimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "mp4":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    case "srt":
      return "application/x-subrip";
    case "vtt":
      return "text/vtt";
    default:
      return "application/octet-stream";
  }
}
