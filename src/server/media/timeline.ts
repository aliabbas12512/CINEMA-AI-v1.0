/**
 * Pure timeline math. Scene length is driven by the REAL measured duration of
 * the generated Urdu narration/dialogue, so picture and sound stay in sync.
 */

export const LEAD_IN_SEC = 0.6;
export const LINE_GAP_SEC = 0.35;
export const TAIL_SEC = 0.8;
/** Max slow-down applied to a provider clip when it is shorter than its slot. */
export const MAX_SLOWDOWN = 1.2;

export type LineTiming = { id: string; durationSec: number };
export type ShotTimingInput = { id: string; plannedDurationSec: number };

export type ScheduledLine = { id: string; startOffsetSec: number; durationSec: number };
export type ScheduledShot = {
  id: string;
  startOffsetSec: number;
  timelineDurationSec: number;
  generationDurationSec: number;
  /** Seconds the last frame must be held because the scene outran clip capacity. */
  holdSec: number;
};

export type SceneSchedule = {
  durationSec: number;
  lines: ScheduledLine[];
  shots: ScheduledShot[];
  warnings: string[];
};

const round3 = (x: number) => Math.round(x * 1000) / 1000;

export function scheduleLines(lines: LineTiming[]): { lines: ScheduledLine[]; voiceSpanSec: number } {
  let offset = LEAD_IN_SEC;
  const out: ScheduledLine[] = [];
  for (const l of lines) {
    out.push({ id: l.id, startOffsetSec: round3(offset), durationSec: l.durationSec });
    offset += l.durationSec + LINE_GAP_SEC;
  }
  const voiceSpanSec = lines.length ? offset - LINE_GAP_SEC + TAIL_SEC : 0;
  return { lines: out, voiceSpanSec: round3(voiceSpanSec) };
}

/** Smallest supported duration >= needed, else the maximum supported. */
export function pickGenerationDuration(neededSec: number, supported: readonly number[]): number {
  if (supported.length === 0) throw new Error("Provider reports no supported durations");
  const sorted = [...supported].sort((a, b) => a - b);
  return sorted.find((d) => d >= neededSec - 1e-6) ?? (sorted[sorted.length - 1] as number);
}

/**
 * Allocate `total` seconds to shots proportionally to their planned length,
 * clamped to each shot's capacity (max provider duration x MAX_SLOWDOWN).
 */
export function allocateShots(
  shots: ShotTimingInput[],
  totalSec: number,
  supportedDurations: readonly number[],
): { shots: ScheduledShot[]; warnings: string[] } {
  const warnings: string[] = [];
  if (shots.length === 0) return { shots: [], warnings: ["scene has no shots"] };
  const maxDur = Math.max(...supportedDurations);
  const minDur = Math.min(...supportedDurations);
  const capacity = maxDur * MAX_SLOWDOWN;

  const alloc = new Array<number>(shots.length).fill(0);
  let remaining = totalSec;
  let open = shots.map((_, i) => i);
  // Water-filling: distribute proportionally, freeze shots that hit capacity, repeat.
  for (let guard = 0; guard < shots.length + 1 && remaining > 1e-6 && open.length; guard++) {
    const weight = open.reduce((s, i) => s + Math.max(0.1, shots[i]!.plannedDurationSec), 0);
    const next: number[] = [];
    let used = 0;
    for (const i of open) {
      const share = (remaining * Math.max(0.1, shots[i]!.plannedDurationSec)) / weight;
      const room = capacity - alloc[i]!;
      const add = Math.min(share, room);
      alloc[i]! += add;
      used += add;
      if (alloc[i]! < capacity - 1e-6) next.push(i);
    }
    remaining -= used;
    open = next;
  }

  let holdLast = 0;
  if (remaining > 1e-3) {
    holdLast = remaining;
    warnings.push(`scene needs ${remaining.toFixed(2)}s more than its shots can cover; holding last frame`);
  }

  let cursor = 0;
  const out: ScheduledShot[] = shots.map((s, i) => {
    let dur = alloc[i]!;
    if (dur < minDur / MAX_SLOWDOWN) dur = Math.max(dur, 0.5);
    const isLast = i === shots.length - 1;
    const timeline = round3(dur + (isLast ? holdLast : 0));
    const gen = pickGenerationDuration(dur, supportedDurations);
    const item: ScheduledShot = {
      id: s.id,
      startOffsetSec: round3(cursor),
      timelineDurationSec: timeline,
      generationDurationSec: gen,
      holdSec: isLast ? round3(holdLast) : 0,
    };
    cursor += timeline;
    return item;
  });
  return { shots: out, warnings };
}

export function scheduleScene(args: {
  lines: LineTiming[];
  shots: ShotTimingInput[];
  supportedDurations: readonly number[];
}): SceneSchedule {
  const { lines, voiceSpanSec } = scheduleLines(args.lines);
  const plannedSum = args.shots.reduce((s, x) => s + x.plannedDurationSec, 0);
  const durationSec = round3(Math.max(voiceSpanSec, plannedSum, 1));
  const { shots, warnings } = allocateShots(args.shots, durationSec, args.supportedDurations);
  const covered = shots.reduce((s, x) => s + x.timelineDurationSec, 0);
  return { durationSec: round3(covered > 0 ? covered : durationSec), lines, shots, warnings };
}
