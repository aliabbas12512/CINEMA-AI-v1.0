import { spawn } from "node:child_process";
import { getEnv } from "@/server/env";

/**
 * Safe FFmpeg / FFprobe execution.
 *
 * - Always spawn() with an argument array - never a shell - so no user string
 *   can be interpreted as a command.
 * - Inputs are files we created inside our own work directory; user text
 *   (e.g. subtitles) only ever reaches FFmpeg through files, never argv.
 */

export class FfmpegError extends Error {
  constructor(
    message: string,
    public readonly stderrTail: string,
    public readonly exitCode: number | null,
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

export type RunResult = { stdout: string; stderr: string };

function assertSafeArgs(args: readonly string[]): void {
  for (const a of args) {
    if (typeof a !== "string") throw new Error("FFmpeg argument must be a string");
    if (a.includes("\0")) throw new Error("FFmpeg argument contains NUL byte");
  }
}

function run(bin: string, args: readonly string[], opts: { timeoutMs?: number; maxBuffer?: number } = {}): Promise<RunResult> {
  assertSafeArgs(args);
  const maxBuffer = opts.maxBuffer ?? 32 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < maxBuffer) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
      if (stderr.length > maxBuffer) stderr = stderr.slice(-maxBuffer / 2);
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(new FfmpegError(`${bin} failed to start: ${err.message}`, "", null));
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = stderr.split("\n").slice(-25).join("\n");
        reject(new FfmpegError(`${bin} exited with ${code ?? signal}`, tail, code));
      }
    });
  });
}

export function ffmpeg(args: readonly string[], opts?: { timeoutMs?: number }): Promise<RunResult> {
  const env = getEnv();
  return run(env.FFMPEG_PATH, ["-hide_banner", "-nostdin", "-y", ...args], { timeoutMs: opts?.timeoutMs ?? 30 * 60_000 });
}

export function ffprobe(args: readonly string[]): Promise<RunResult> {
  const env = getEnv();
  return run(env.FFPROBE_PATH, ["-hide_banner", ...args], { timeoutMs: 120_000 });
}

/** Number formatting for filter graphs: fixed precision, never exponent notation. */
export function n(x: number, digits = 3): string {
  if (!Number.isFinite(x)) throw new Error(`Non-finite number in FFmpeg graph: ${x}`);
  return x.toFixed(digits);
}
