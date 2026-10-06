import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffmpeg, n } from "@/server/media/ffmpeg";
import { ProviderError } from "../errors";
import type {
  GenerationResult,
  ProviderInfo,
  SubmitResult,
  TaskStatus,
  ValidationResult,
  VideoCapabilities,
  VideoProvider,
  VideoRequest,
} from "../types";
import { SyncTaskStore } from "./sync-task";

/**
 * Local video provider: renders real camera motion (push-in, pull-out, pan,
 * crane, orbit) over the shot's AI keyframe with FFmpeg's zoompan filter.
 *
 * - No account, network or payment: lets the whole pipeline produce a real,
 *   watchable film today.
 * - It is NOT generative motion: characters do not move; the camera does.
 *   The UI/provider name says so. Swap VIDEO_PROVIDER to a generative
 *   provider (e.g. runway) later without changing anything else.
 */

export type MotionKind = "push_in" | "pull_out" | "pan_right" | "pan_left" | "crane_up" | "tilt_down" | "orbit" | "drift";

/** Choose a motivated move from the planner's camera description. */
export function motionFor(camera: string | undefined, seed = 0): MotionKind {
  const c = (camera ?? "").toLowerCase();
  if (/orbit/.test(c)) return "orbit";
  if (/crane|high_angle|rise|rising/.test(c)) return "crane_up";
  if (/tilt.?down|descend/.test(c)) return "tilt_down";
  if (/establishing|aerial|wide|pull.?out|reveal/.test(c)) return "pull_out";
  if (/tracking|pan|pov|over_the_shoulder|follow/.test(c)) return seed % 2 === 0 ? "pan_right" : "pan_left";
  if (/dolly|push|close_up|extreme_close_up|low_angle|zoom/.test(c)) return "push_in";
  return "drift";
}

/** zoompan expressions; `p` = eased progress 0..1 over the clip. */
export function motionExpressions(kind: MotionKind, frames: number): { z: string; x: string; y: string } {
  const last = Math.max(1, frames - 1);
  const p = `(on/${last})*(on/${last})*(3-2*(on/${last}))`; // smoothstep easing
  const cx = "iw/2-(iw/zoom/2)";
  const cy = "ih/2-(ih/zoom/2)";
  switch (kind) {
    case "push_in":
      return { z: `1.0+0.20*${p}`, x: cx, y: cy };
    case "pull_out":
      return { z: `1.20-0.20*${p}`, x: cx, y: cy };
    case "pan_right":
      return { z: "1.18", x: `(iw-iw/zoom)*${p}`, y: cy };
    case "pan_left":
      return { z: "1.18", x: `(iw-iw/zoom)*(1-${p})`, y: cy };
    case "crane_up":
      return { z: "1.18", x: cx, y: `(ih-ih/zoom)*(1-${p})` };
    case "tilt_down":
      return { z: "1.18", x: cx, y: `(ih-ih/zoom)*${p}` };
    case "orbit":
      return { z: `1.10+0.08*${p}`, x: `(iw-iw/zoom)*(0.15+0.7*${p})`, y: `(ih-ih/zoom)*(0.5-0.2*sin(PI*${p}))` };
    case "drift":
      return { z: `1.06+0.10*${p}`, x: `(iw-iw/zoom)*(0.4+0.2*${p})`, y: cy };
  }
}

const DURATIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export class FfmpegMotionVideoProvider implements VideoProvider {
  readonly info: ProviderInfo = {
    id: "ffmpeg_motion",
    displayName: "FFmpeg camera motion (local, no generative motion)",
    capability: "video",
    model: "zoompan-v1",
  };
  readonly capabilities: VideoCapabilities = {
    durations: DURATIONS,
    maxPromptLength: 100_000,
    supportsNegativePrompt: false,
    nativeWidth: 1920,
    nativeHeight: 1080,
  };
  private readonly store = new SyncTaskStore("ffmpeg_motion");

  constructor(private readonly opts: { fps?: number } = {}) {}

  async validate(): Promise<ValidationResult> {
    try {
      const { stdout } = await ffmpeg(["-filters"]);
      if (!/zoompan/.test(stdout)) return { ok: false, message: "This FFmpeg build has no zoompan filter." };
      return { ok: true, message: "FFmpeg with zoompan available (local camera-motion renderer, no cost)." };
    } catch (err) {
      return { ok: false, message: `FFmpeg not available: ${(err as Error).message}` };
    }
  }

  async render(req: VideoRequest): Promise<GenerationResult> {
    if (!DURATIONS.includes(req.durationSec)) {
      throw new ProviderError({ provider: "ffmpeg_motion", message: `Unsupported duration ${req.durationSec}s`, retryable: false });
    }
    const fps = this.opts.fps ?? 24;
    const [w, h] = req.aspect === "9:16" ? [1080, 1920] : [1920, 1080];
    const frames = Math.round(req.durationSec * fps);
    const kind = motionFor(req.camera, req.seed ?? 0);
    const e = motionExpressions(kind, frames);
    const dir = await mkdtemp(path.join(os.tmpdir(), "afs-motion-"));
    try {
      const input = path.join(dir, `frame.${req.firstFrame.ext || "png"}`);
      const out = path.join(dir, "clip.mp4");
      await writeFile(input, req.firstFrame.data);
      // Upscale 2x before zoompan to keep sub-pixel motion smooth.
      const vf = [
        `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase:flags=lanczos`,
        `crop=${w * 2}:${h * 2}`,
        `zoompan=z='${e.z}':x='${e.x}':y='${e.y}':d=${frames}:s=${w}x${h}:fps=${fps}`,
        "setsar=1",
        "format=yuv420p",
      ].join(",");
      await ffmpeg(["-i", input, "-vf", vf, "-frames:v", String(frames), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", String(fps), "-an", out], {
        timeoutMs: 10 * 60_000,
      });
      const data = await readFile(out);
      return {
        data,
        mimeType: "video/mp4",
        ext: "mp4",
        cost: { amount: 0, unit: "usd" },
        meta: { motion: kind, seconds: n(req.durationSec, 1) },
      };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError({ provider: "ffmpeg_motion", message: `Motion render failed: ${(err as Error).message}`, retryable: false, cause: err });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async submit(req: VideoRequest): Promise<SubmitResult> {
    const result = await this.render(req);
    return { externalId: this.store.put(result), estimatedCost: result.cost };
  }

  async getStatus(externalId: string): Promise<TaskStatus> {
    return this.store.status(externalId);
  }

  async download(status: TaskStatus): Promise<GenerationResult> {
    return this.store.take(status);
  }

  async cancel(externalId: string): Promise<void> {
    this.store.drop(externalId);
  }
}
