import { describe, expect, it } from "vitest";
import { buildCues, toSrt, toVtt, validateCues } from "@/server/media/subtitles";
import { allocateShots, LEAD_IN_SEC, LINE_GAP_SEC, MAX_SLOWDOWN, pickGenerationDuration, scheduleScene, TAIL_SEC } from "@/server/media/timeline";

describe("timeline scheduling from real audio", () => {
  it("places lines sequentially with lead-in and gaps", () => {
    const s = scheduleScene({
      lines: [
        { id: "a", durationSec: 3 },
        { id: "b", durationSec: 2 },
      ],
      shots: [{ id: "s1", plannedDurationSec: 2 }],
      supportedDurations: [4, 6, 8],
    });
    expect(s.lines[0]!.startOffsetSec).toBeCloseTo(LEAD_IN_SEC);
    expect(s.lines[1]!.startOffsetSec).toBeCloseTo(LEAD_IN_SEC + 3 + LINE_GAP_SEC);
    const voiceSpan = LEAD_IN_SEC + 3 + LINE_GAP_SEC + 2 + TAIL_SEC;
    expect(s.durationSec).toBeCloseTo(voiceSpan, 2);
  });

  it("scene is never shorter than its voice and shots cover it exactly", () => {
    const s = scheduleScene({
      lines: [{ id: "a", durationSec: 20 }],
      shots: [
        { id: "1", plannedDurationSec: 5 },
        { id: "2", plannedDurationSec: 5 },
        { id: "3", plannedDurationSec: 5 },
      ],
      supportedDurations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
    const covered = s.shots.reduce((x, y) => x + y.timelineDurationSec, 0);
    expect(covered).toBeCloseTo(s.durationSec, 2);
    expect(s.durationSec).toBeGreaterThanOrEqual(20);
    for (const sh of s.shots) expect(sh.generationDurationSec).toBeGreaterThanOrEqual(sh.timelineDurationSec - 1e-6);
  });

  it("caps shots at provider capacity and holds the last frame for any remainder", () => {
    const r = allocateShots([{ id: "1", plannedDurationSec: 4 }], 15, [4, 6, 8]);
    expect(r.shots[0]!.generationDurationSec).toBe(8);
    expect(r.shots[0]!.holdSec).toBeCloseTo(15 - 8 * MAX_SLOWDOWN, 2);
    expect(r.warnings[0]).toMatch(/holding last frame/);
  });

  it("quantizes to provider-supported durations", () => {
    expect(pickGenerationDuration(4.2, [4, 6, 8])).toBe(6);
    expect(pickGenerationDuration(3, [4, 6, 8])).toBe(4);
    expect(pickGenerationDuration(12, [4, 6, 8])).toBe(8);
  });
});

describe("subtitles", () => {
  it("builds SRT/VTT from timed lines, splitting long text without overlaps", () => {
    const long = "This is a long narration line that goes on. It has several sentences! And it must be split into readable cues for the viewer.";
    const cues = buildCues([
      { startSec: 0.6, endSec: 2.4, text: "سلام دوستو۔" },
      { startSec: 2.75, endSec: 12, text: long },
    ]);
    expect(cues.length).toBeGreaterThan(2);
    expect(validateCues(cues, 12)).toEqual([]);
    const srt = toSrt(cues);
    expect(srt).toContain("00:00:00,600 --> 00:00:02,400");
    expect(srt).toContain("سلام دوستو۔");
    expect(toVtt(cues).startsWith("WEBVTT\n\n")).toBe(true);
    expect(toVtt(cues)).toContain("00:00:00.600 --> 00:00:02.400");
    for (const c of cues) for (const row of c.text.split("\n")) expect(row.length).toBeLessThanOrEqual(42 + 20);
  });
  it("strips markup characters and detects bad timing", () => {
    const cues = buildCues([{ startSec: 0, endSec: 1, text: "<script>x</script> {y}" }]);
    const body = toSrt(cues).split("\n").filter((l) => !l.includes("-->"));
    expect(body.join("\n")).not.toMatch(/[<>{}]/);
    expect(validateCues([{ index: 1, startSec: 0, endSec: 20, text: "x" }], 10)[0]).toMatch(/after media end/);
  });
});
