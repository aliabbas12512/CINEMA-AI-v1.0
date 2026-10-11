/**
 * Subtitle generation from FINAL timed lines (real audio placement), never
 * from an earlier script draft.
 */

export type TimedText = { startSec: number; endSec: number; text: string };
export type Cue = { index: number; startSec: number; endSec: number; text: string };

const MAX_CHARS_PER_CUE = 84;
const MAX_CHARS_PER_ROW = 42;

function wrap(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const rows: string[] = [];
  let row = "";
  for (const w of words) {
    if ((row + " " + w).trim().length > MAX_CHARS_PER_ROW && row) {
      rows.push(row);
      row = w;
    } else row = (row + " " + w).trim();
  }
  if (row) rows.push(row);
  return rows.join("\n");
}

function splitText(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_CHARS_PER_CUE) return clean ? [clean] : [];
  // Prefer sentence boundaries (English . ! ? and Urdu ۔ ؟), then words.
  const sentences = clean.split(/(?<=[.!?۔؟])\s+/);
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    const pieces = s.length > MAX_CHARS_PER_CUE ? splitWords(s) : [s];
    for (const p of pieces) {
      if ((cur + " " + p).trim().length > MAX_CHARS_PER_CUE && cur) {
        chunks.push(cur);
        cur = p;
      } else cur = (cur + " " + p).trim();
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function splitWords(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of s.split(" ")) {
    if ((cur + " " + w).trim().length > MAX_CHARS_PER_CUE && cur) {
      out.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) out.push(cur);
  return out;
}

/** Turn timed lines into cues, splitting long lines proportionally by length. */
export function buildCues(items: TimedText[]): Cue[] {
  const cues: Cue[] = [];
  const sorted = [...items].filter((i) => i.text.trim() && i.endSec > i.startSec).sort((a, b) => a.startSec - b.startSec);
  for (const item of sorted) {
    const chunks = splitText(item.text);
    const totalChars = chunks.reduce((s, c) => s + c.length, 0) || 1;
    let t = item.startSec;
    const span = item.endSec - item.startSec;
    chunks.forEach((c, i) => {
      const end = i === chunks.length - 1 ? item.endSec : t + (span * c.length) / totalChars;
      cues.push({ index: 0, startSec: t, endSec: end, text: wrap(c) });
      t = end;
    });
  }
  // Ensure no overlaps and renumber.
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!;
    const next = cues[i + 1];
    if (next && c.endSec > next.startSec) c.endSec = next.startSec;
    c.index = i + 1;
  }
  return cues.filter((c) => c.endSec - c.startSec >= 0.2).map((c, i) => ({ ...c, index: i + 1 }));
}

function ts(sec: number, sep: "," | "."): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const p = (v: number, l = 2) => String(v).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(r, 3)}`;
}

/** Strip characters that could be interpreted as markup by players. */
function sanitize(text: string): string {
  return text.replace(/[<>{}]/g, "").replace(/\r/g, "");
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c) => `${c.index}\n${ts(c.startSec, ",")} --> ${ts(c.endSec, ",")}\n${sanitize(c.text)}\n`).join("\n");
}

export function toVtt(cues: Cue[]): string {
  const body = cues.map((c) => `${c.index}\n${ts(c.startSec, ".")} --> ${ts(c.endSec, ".")}\n${sanitize(c.text)}\n`).join("\n");
  return `WEBVTT\n\n${body}`;
}

export function validateCues(cues: Cue[], mediaDurationSec: number): string[] {
  const problems: string[] = [];
  let prevEnd = 0;
  for (const c of cues) {
    if (c.startSec < prevEnd - 1e-3) problems.push(`cue ${c.index} overlaps previous cue`);
    if (c.endSec <= c.startSec) problems.push(`cue ${c.index} has non-positive duration`);
    if (c.endSec > mediaDurationSec + 0.5) problems.push(`cue ${c.index} ends after media end`);
    prevEnd = c.endSec;
  }
  return problems;
}
