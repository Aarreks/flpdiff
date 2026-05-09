import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFLPFile, getTempo } from "../src/parser/flp-project.ts";
import { serializeFLPProject } from "../src/parser/flp-write.ts";
import {
  setTempo,
  setPatternName,
  setChannelName,
  setInsertName,
  setTimeSignature,
  setChannelColor,
  setInsertColor,
  setPatternColor,
  setChannelRouting,
  setArrangementName,
  setTrackName,
  setTrackColor,
  setTrackGrouped,
  clonePattern,
  addClip,
  removeClip,
  moveClip,
  addPatternNote,
  setPatternNotes,
  removePatternNote,
  encodeNote,
  addPatternController,
  setPatternControllers,
  removePatternController,
  encodeController,
  createPattern,
  createChannel,
  setNativePluginParam,
  setPatternLength,
  transposePatternNotes,
  quantizePatternNotes,
  humanizeVelocities,
  humanizeTimings,
  reversePatternNotes,
  invertPatternNotes,
  setChannelVolume,
  setChannelPan,
  arrangeSong,
  MutationError,
} from "../src/mutations/index.ts";
import type { FLPProject } from "../src/parser/flp-project.ts";
import type { FLPEvent } from "../src/parser/event.ts";
import { buildArrangements } from "../src/parser/project-builder.ts";
import { buildProjectSummary } from "../src/summary.ts";
import { buildChannels } from "../src/parser/project-builder.ts";

const FIXTURE = join(import.meta.dir, "corpus/re_base/fl25/base_one_pattern.flp");

function loadProject(path: string) {
  const buf = readFileSync(path);
  return parseFLPFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function reparse(project: ReturnType<typeof loadProject>) {
  const bytes = serializeFLPProject(project);
  return parseFLPFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

describe("setTempo", () => {
  test("changes the modern 0x9C tempo event in place", () => {
    const project = loadProject(FIXTURE);
    const before = getTempo(project);
    expect(before).toBeGreaterThan(0);

    const mutated = setTempo(project, 145);
    expect(getTempo(mutated)).toBe(145);

    // Round-trip via the serializer to make sure the new tempo
    // survives a parse(serialize(parse(...))) cycle.
    const reparsed = reparse(mutated);
    expect(getTempo(reparsed)).toBe(145);
  });

  test("preserves all other events bit-exact", () => {
    const project = loadProject(FIXTURE);
    const mutated = setTempo(project, 145);

    expect(mutated.events.length).toBe(project.events.length);
    for (let i = 0; i < project.events.length; i++) {
      const orig = project.events[i]!;
      const next = mutated.events[i]!;
      if (orig.kind === "u32" && orig.opcode === 0x9c) {
        expect(next.kind).toBe("u32");
        if (next.kind === "u32") expect(next.value).toBe(145000);
        continue;
      }
      // every other event identical
      expect(next.kind).toBe(orig.kind);
      expect(next.opcode).toBe(orig.opcode);
    }
  });

  test("rejects non-positive bpm", () => {
    const project = loadProject(FIXTURE);
    expect(() => setTempo(project, 0)).toThrow(MutationError);
    expect(() => setTempo(project, -10)).toThrow(MutationError);
    expect(() => setTempo(project, NaN)).toThrow(MutationError);
  });

  test("INVALID_ARGS code on bad bpm", () => {
    const project = loadProject(FIXTURE);
    try {
      setTempo(project, 0);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MutationError);
      if (e instanceof MutationError) expect(e.code).toBe("INVALID_ARGS");
    }
  });

  test("source project is not mutated (returns new project)", () => {
    const project = loadProject(FIXTURE);
    const beforeBpm = getTempo(project);
    setTempo(project, 200);
    expect(getTempo(project)).toBe(beforeBpm);
  });
});

describe("setPatternName", () => {
  test("renames an existing pattern", () => {
    const project = loadProject(FIXTURE);
    const mutated = setPatternName(project, 1, "Verse-1");
    const reparsed = reparse(mutated);
    const pattern = reparsed.patterns.find((p) => p.id === 1);
    expect(pattern).toBeDefined();
    expect(pattern?.name).toBe("Verse-1");
  });

  test("rejects iid < 1 (FL is 1-indexed)", () => {
    const project = loadProject(FIXTURE);
    expect(() => setPatternName(project, 0, "x")).toThrow(MutationError);
    expect(() => setPatternName(project, -1, "x")).toThrow(MutationError);
  });

  test("rejects empty name", () => {
    const project = loadProject(FIXTURE);
    expect(() => setPatternName(project, 1, "")).toThrow(MutationError);
  });

  test("EVENT_NOT_FOUND when pattern doesn't exist", () => {
    const project = loadProject(FIXTURE);
    try {
      setPatternName(project, 999, "ghost");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MutationError);
      if (e instanceof MutationError) expect(e.code).toBe("EVENT_NOT_FOUND");
    }
  });
});

describe("setChannelName", () => {
  test("renames an existing channel by iid", () => {
    const project = loadProject(FIXTURE);
    const summaryBefore = buildProjectSummary(project);
    expect(summaryBefore.channels.length).toBeGreaterThan(0);
    const targetIid = summaryBefore.channels[0]!.iid;

    const mutated = setChannelName(project, targetIid, "Lead-Synth");
    const reparsed = reparse(mutated);
    const summary = buildProjectSummary(reparsed);
    const ch = summary.channels.find((c) => c.iid === targetIid);
    expect(ch?.name).toBe("Lead-Synth");
  });

  test("rejects iid < 0", () => {
    const project = loadProject(FIXTURE);
    expect(() => setChannelName(project, -1, "x")).toThrow(MutationError);
  });

  test("rejects empty name", () => {
    const project = loadProject(FIXTURE);
    expect(() => setChannelName(project, 0, "")).toThrow(MutationError);
  });

  test("EVENT_NOT_FOUND when channel iid doesn't exist", () => {
    const project = loadProject(FIXTURE);
    try {
      setChannelName(project, 9999, "ghost");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MutationError);
      if (e instanceof MutationError) expect(e.code).toBe("EVENT_NOT_FOUND");
    }
  });
});

describe("setInsertName", () => {
  test("renames mixer insert 1 (first non-master insert)", () => {
    const project = loadProject(FIXTURE);
    const mutated = setInsertName(project, 1, "Bass-Bus");
    const reparsed = reparse(mutated);
    const summary = buildProjectSummary(reparsed);
    expect(summary.inserts[1]?.name).toBe("Bass-Bus");
  });

  test("renames master (insert 0)", () => {
    const project = loadProject(FIXTURE);
    const mutated = setInsertName(project, 0, "MASTER-OUT");
    const reparsed = reparse(mutated);
    const summary = buildProjectSummary(reparsed);
    expect(summary.inserts[0]?.name).toBe("MASTER-OUT");
  });

  test("rejects index < 0", () => {
    const project = loadProject(FIXTURE);
    expect(() => setInsertName(project, -1, "x")).toThrow(MutationError);
  });

  test("EVENT_NOT_FOUND when insert index out of range", () => {
    const project = loadProject(FIXTURE);
    try {
      setInsertName(project, 999, "ghost");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MutationError);
      if (e instanceof MutationError) expect(e.code).toBe("EVENT_NOT_FOUND");
    }
  });
});

describe("setTimeSignature", () => {
  test("changes the project time signature", () => {
    const project = loadProject(FIXTURE);
    const mutated = setTimeSignature(project, 6, 8);
    const reparsed = reparse(mutated);
    expect(reparsed.metadata?.timeSignatureNumerator).toBe(6);
    expect(reparsed.metadata?.timeSignatureDenominator).toBe(8);
  });

  test("rejects non-power-of-2 denominator", () => {
    const project = loadProject(FIXTURE);
    expect(() => setTimeSignature(project, 4, 3)).toThrow(MutationError);
    expect(() => setTimeSignature(project, 4, 5)).toThrow(MutationError);
  });

  test("accepts all power-of-2 denominators in [1, 64]", () => {
    const project = loadProject(FIXTURE);
    for (const d of [1, 2, 4, 8, 16, 32, 64]) {
      const mutated = setTimeSignature(project, 4, d);
      const reparsed = reparse(mutated);
      expect(reparsed.metadata?.timeSignatureDenominator).toBe(d);
    }
  });

  test("rejects numerator < 1 or > 255", () => {
    const project = loadProject(FIXTURE);
    expect(() => setTimeSignature(project, 0, 4)).toThrow(MutationError);
    expect(() => setTimeSignature(project, 256, 4)).toThrow(MutationError);
  });
});

describe("setChannelColor", () => {
  test("sets a channel color (round-trip)", () => {
    const project = loadProject(FIXTURE);
    const iid = buildProjectSummary(project).channels[0]!.iid;
    const mutated = setChannelColor(project, iid, { r: 255, g: 100, b: 50 });
    const reparsed = reparse(mutated);
    const ch = buildProjectSummary(reparsed).channels.find((c) => c.iid === iid);
    expect(ch?.color).toEqual({ r: 255, g: 100, b: 50, a: 0 });
  });

  test("rejects invalid RGB", () => {
    const project = loadProject(FIXTURE);
    expect(() => setChannelColor(project, 0, { r: -1, g: 0, b: 0 })).toThrow(MutationError);
    expect(() => setChannelColor(project, 0, { r: 256, g: 0, b: 0 })).toThrow(MutationError);
  });

  test("EVENT_NOT_FOUND for missing channel iid", () => {
    const project = loadProject(FIXTURE);
    try {
      setChannelColor(project, 9999, { r: 0, g: 0, b: 0 });
      throw new Error("expected throw");
    } catch (e) {
      if (e instanceof MutationError) expect(e.code).toBe("EVENT_NOT_FOUND");
      else throw e;
    }
  });
});

describe("setInsertColor", () => {
  test("sets insert color round-trip", () => {
    const project = loadProject(FIXTURE);
    const mutated = setInsertColor(project, 1, { r: 12, g: 34, b: 56 });
    const reparsed = reparse(mutated);
    expect(buildProjectSummary(reparsed).inserts[1]?.color).toEqual({
      r: 12,
      g: 34,
      b: 56,
      a: 0,
    });
  });

  test("master (insert 0) color", () => {
    const project = loadProject(FIXTURE);
    const mutated = setInsertColor(project, 0, { r: 200, g: 200, b: 200 });
    const reparsed = reparse(mutated);
    expect(buildProjectSummary(reparsed).inserts[0]?.color).toEqual({
      r: 200,
      g: 200,
      b: 200,
      a: 0,
    });
  });

  test("EVENT_NOT_FOUND for out-of-range insert", () => {
    const project = loadProject(FIXTURE);
    try {
      setInsertColor(project, 9999, { r: 0, g: 0, b: 0 });
      throw new Error("expected throw");
    } catch (e) {
      if (e instanceof MutationError) expect(e.code).toBe("EVENT_NOT_FOUND");
      else throw e;
    }
  });
});

describe("setPatternColor", () => {
  test("sets pattern color round-trip", () => {
    const project = loadProject(FIXTURE);
    const mutated = setPatternColor(project, 1, { r: 222, g: 11, b: 99 });
    const reparsed = reparse(mutated);
    const p = reparsed.patterns.find((x) => x.id === 1);
    expect(p?.color).toEqual({ r: 222, g: 11, b: 99, a: 0 });
  });

  test("rejects iid < 1", () => {
    const project = loadProject(FIXTURE);
    expect(() => setPatternColor(project, 0, { r: 0, g: 0, b: 0 })).toThrow(MutationError);
  });
});

describe("setChannelRouting", () => {
  test("routes channel iid=0 to insert 3", () => {
    const project = loadProject(FIXTURE);
    const mutated = setChannelRouting(project, 0, 3);
    const reparsed = reparse(mutated);
    const ch = buildChannels(reparsed.events, reparsed.metadata).find((c) => c.iid === 0);
    expect(ch?.targetInsert).toBe(3);
  });

  test("unroutes via -1", () => {
    const project = loadProject(FIXTURE);
    const mutated = setChannelRouting(project, 0, -1);
    const reparsed = reparse(mutated);
    const ch = buildChannels(reparsed.events, reparsed.metadata).find((c) => c.iid === 0);
    expect(ch?.targetInsert).toBe(-1);
  });

  test("rejects out-of-range insert target", () => {
    const project = loadProject(FIXTURE);
    expect(() => setChannelRouting(project, 0, 128)).toThrow(MutationError);
    expect(() => setChannelRouting(project, 0, -2)).toThrow(MutationError);
  });
});

describe("setArrangementName", () => {
  test("renames the default arrangement", () => {
    const project = loadProject(FIXTURE);
    const mutated = setArrangementName(project, 0, "Verse-A");
    const reparsed = reparse(mutated);
    const channels = buildChannels(reparsed.events, reparsed.metadata);
    const arrs = buildArrangements(
      reparsed.events,
      channels,
      reparsed.patterns,
      reparsed.metadata,
    );
    expect(arrs[0]?.name).toBe("Verse-A");
  });

  test("EVENT_NOT_FOUND for missing arrangement", () => {
    const project = loadProject(FIXTURE);
    expect(() => setArrangementName(project, 99, "x")).toThrow(MutationError);
  });

  test("rejects empty name", () => {
    const project = loadProject(FIXTURE);
    expect(() => setArrangementName(project, 0, "")).toThrow(MutationError);
  });
});

describe("setTrackName", () => {
  test("names a previously-unnamed track", () => {
    const project = loadProject(FIXTURE);
    const mutated = setTrackName(project, 0, 0, "Drums");
    const reparsed = reparse(mutated);
    const channels = buildChannels(reparsed.events, reparsed.metadata);
    const arrs = buildArrangements(
      reparsed.events,
      channels,
      reparsed.patterns,
      reparsed.metadata,
    );
    expect(arrs[0]?.tracks[0]?.name).toBe("Drums");
  });

  test("renames different tracks independently", () => {
    let project = loadProject(FIXTURE);
    project = setTrackName(project, 0, 2, "Bass");
    project = setTrackName(project, 0, 5, "Lead");
    const reparsed = reparse(project);
    const channels = buildChannels(reparsed.events, reparsed.metadata);
    const arrs = buildArrangements(
      reparsed.events,
      channels,
      reparsed.patterns,
      reparsed.metadata,
    );
    expect(arrs[0]?.tracks[2]?.name).toBe("Bass");
    expect(arrs[0]?.tracks[5]?.name).toBe("Lead");
    expect(arrs[0]?.tracks[0]?.name).toBeUndefined();
  });

  test("EVENT_NOT_FOUND for out-of-range track index", () => {
    const project = loadProject(FIXTURE);
    expect(() => setTrackName(project, 0, 999_999, "x")).toThrow(MutationError);
  });
});

describe("setTrackColor", () => {
  test("changes a track's color (round-trip via 0xEE blob patch)", () => {
    const project = loadProject(FIXTURE);
    const mutated = setTrackColor(project, 0, 0, { r: 220, g: 50, b: 100 });
    const reparsed = reparse(mutated);
    const channels = buildChannels(reparsed.events, reparsed.metadata);
    const arrs = buildArrangements(
      reparsed.events,
      channels,
      reparsed.patterns,
      reparsed.metadata,
    );
    expect(arrs[0]?.tracks[0]?.color).toEqual({ r: 220, g: 50, b: 100, a: 0 });
  });

  test("preserves all other track-data bytes", () => {
    const project = loadProject(FIXTURE);
    const before = project.events.find(
      (e) => e.kind === "blob" && e.opcode === 0xee,
    );
    const mutated = setTrackColor(project, 0, 0, { r: 10, g: 20, b: 30 });
    const after = mutated.events.find((e) => e.kind === "blob" && e.opcode === 0xee);
    if (before?.kind !== "blob" || after?.kind !== "blob") throw new Error("expected blob");
    expect(after.payload.byteLength).toBe(before.payload.byteLength);
    // Bytes 0-3 (iid), 8+ (icon, enabled, height, locked, etc.) unchanged.
    for (let i = 0; i < 4; i++) expect(after.payload[i]).toBe(before.payload[i]!);
    for (let i = 8; i < before.payload.byteLength; i++) {
      expect(after.payload[i]).toBe(before.payload[i]!);
    }
  });

  test("EVENT_NOT_FOUND for missing track", () => {
    const project = loadProject(FIXTURE);
    expect(() => setTrackColor(project, 0, 99999, { r: 0, g: 0, b: 0 })).toThrow(MutationError);
  });
});

describe("setTrackGrouped", () => {
  test("toggles the grouped flag (round-trip via 0xEE byte 47)", () => {
    const project = loadProject(FIXTURE);
    const m = setTrackGrouped(project, 0, 1, true);
    const re = reparse(m);
    const channels = buildChannels(re.events, re.metadata);
    const arrs = buildArrangements(re.events, channels, re.patterns, re.metadata);
    expect(arrs[0]?.tracks[1]?.grouped).toBe(true);
  });

  test("can ungroup", () => {
    const project = loadProject(FIXTURE);
    const m1 = setTrackGrouped(project, 0, 2, true);
    const m2 = setTrackGrouped(m1, 0, 2, false);
    const re = reparse(m2);
    const channels = buildChannels(re.events, re.metadata);
    const arrs = buildArrangements(re.events, channels, re.patterns, re.metadata);
    expect(arrs[0]?.tracks[2]?.grouped === true).toBe(false);
  });

  test("rejects non-boolean", () => {
    const project = loadProject(FIXTURE);
    expect(() =>
      setTrackGrouped(project, 0, 0, "yes" as unknown as boolean),
    ).toThrow(MutationError);
  });
});

describe("clonePattern", () => {
  test("duplicates an existing pattern with new id + name", () => {
    const project = loadProject(FIXTURE);
    const before = project.patterns.length;
    const mutated = clonePattern(project, 1, "Verse-Copy");
    const reparsed = reparse(mutated);
    expect(reparsed.patterns.length).toBe(before + 1);
    const clone = reparsed.patterns.find((p) => p.name === "Verse-Copy");
    expect(clone).toBeDefined();
    expect(clone?.id).toBeGreaterThan(1);
  });

  test("default name when newName omitted", () => {
    const project = loadProject(FIXTURE);
    const mutated = clonePattern(project, 1);
    const reparsed = reparse(mutated);
    const clone = reparsed.patterns.find((p) => p.id !== 1 && (p.name ?? "").includes("copy"));
    expect(clone).toBeDefined();
  });

  test("clone has same notes as source", () => {
    const project = loadProject(FIXTURE);
    const src = project.patterns.find((p) => p.id === 1)!;
    const mutated = clonePattern(project, 1, "Twin");
    const reparsed = reparse(mutated);
    const clone = reparsed.patterns.find((p) => p.name === "Twin");
    expect(clone?.notes.length).toBe(src.notes.length);
  });

  test("EVENT_NOT_FOUND for missing source iid", () => {
    const project = loadProject(FIXTURE);
    expect(() => clonePattern(project, 9999)).toThrow(MutationError);
  });

  test("rejects iid < 1", () => {
    const project = loadProject(FIXTURE);
    expect(() => clonePattern(project, 0)).toThrow(MutationError);
  });
});

describe("addClip / removeClip / moveClip", () => {
  test("addClip places a pattern clip on a specific track + position", () => {
    const project = loadProject(FIXTURE);
    const m = addClip(project, 0, {
      kind: "pattern",
      ref_id: 1,
      track_index: 2,
      position_ticks: 384,
      length_ticks: 384,
    });
    const reparsed = reparse(m);
    const channels = buildChannels(reparsed.events, reparsed.metadata);
    const arrs = buildArrangements(
      reparsed.events,
      channels,
      reparsed.patterns,
      reparsed.metadata,
    );
    const clips = arrs[0]!.clips;
    expect(clips.length).toBe(1);
    expect(clips[0]!.position).toBe(384);
    expect(clips[0]!.length).toBe(384);
    expect(clips[0]!.item_index).toBe(1 + 20480); // pattern_base
    expect(clips[0]!.track_rvidx).toBe(499 - 2); // un-reversed track 2
  });

  test("addClip multiple appends to same blob", () => {
    let p = loadProject(FIXTURE);
    p = addClip(p, 0, { kind: "pattern", ref_id: 1, track_index: 0, position_ticks: 0, length_ticks: 96 });
    p = addClip(p, 0, { kind: "pattern", ref_id: 1, track_index: 1, position_ticks: 96, length_ticks: 96 });
    p = addClip(p, 0, { kind: "pattern", ref_id: 1, track_index: 2, position_ticks: 192, length_ticks: 96 });
    const re = reparse(p);
    const channels = buildChannels(re.events, re.metadata);
    const arrs = buildArrangements(re.events, channels, re.patterns, re.metadata);
    expect(arrs[0]!.clips.length).toBe(3);
  });

  test("removeClip drops matching record by track + position", () => {
    let p = loadProject(FIXTURE);
    p = addClip(p, 0, { kind: "pattern", ref_id: 1, track_index: 0, position_ticks: 0, length_ticks: 96 });
    p = addClip(p, 0, { kind: "pattern", ref_id: 1, track_index: 1, position_ticks: 0, length_ticks: 96 });
    p = removeClip(p, 0, { track_index: 0, position_ticks: 0 });
    const re = reparse(p);
    const channels = buildChannels(re.events, re.metadata);
    const arrs = buildArrangements(re.events, channels, re.patterns, re.metadata);
    expect(arrs[0]!.clips.length).toBe(1);
    expect(arrs[0]!.clips[0]!.track_rvidx).toBe(499 - 1); // track 1 survived
  });

  test("removeClip throws EVENT_NOT_FOUND when no match", () => {
    const p = loadProject(FIXTURE);
    expect(() => removeClip(p, 0, { track_index: 99 })).toThrow(MutationError);
  });

  test("moveClip patches track in place", () => {
    let p = loadProject(FIXTURE);
    p = addClip(p, 0, { kind: "pattern", ref_id: 1, track_index: 0, position_ticks: 100, length_ticks: 96 });
    p = moveClip(p, 0, { track_index: 0, position_ticks: 100 }, { track_index: 7 });
    const re = reparse(p);
    const channels = buildChannels(re.events, re.metadata);
    const arrs = buildArrangements(re.events, channels, re.patterns, re.metadata);
    expect(arrs[0]!.clips[0]!.track_rvidx).toBe(499 - 7);
    expect(arrs[0]!.clips[0]!.position).toBe(100); // position unchanged
  });

  test("moveClip patches both track + position", () => {
    let p = loadProject(FIXTURE);
    p = addClip(p, 0, { kind: "pattern", ref_id: 1, track_index: 0, position_ticks: 0, length_ticks: 96 });
    p = moveClip(p, 0, { track_index: 0, position_ticks: 0 }, { track_index: 5, position_ticks: 192 });
    const re = reparse(p);
    const channels = buildChannels(re.events, re.metadata);
    const arrs = buildArrangements(re.events, channels, re.patterns, re.metadata);
    expect(arrs[0]!.clips[0]!.track_rvidx).toBe(499 - 5);
    expect(arrs[0]!.clips[0]!.position).toBe(192);
  });

  test("moveClip rejects empty destination", () => {
    const p = loadProject(FIXTURE);
    expect(() => moveClip(p, 0, { track_index: 0 }, {})).toThrow(MutationError);
  });

  test("clip placement validates ticks + index ranges", () => {
    const p = loadProject(FIXTURE);
    expect(() =>
      addClip(p, 0, { kind: "pattern", ref_id: 1, track_index: 0, position_ticks: -1, length_ticks: 1 }),
    ).toThrow(MutationError);
    expect(() =>
      addClip(p, 0, { kind: "pattern", ref_id: 1, track_index: 500, position_ticks: 0, length_ticks: 1 }),
    ).toThrow(MutationError);
    expect(() =>
      addClip(p, 0, { kind: "pattern", ref_id: 0, track_index: 0, position_ticks: 0, length_ticks: 1 }),
    ).toThrow(MutationError);
  });
});

describe("serializer + mutation = round-trip identity for unchanged FLPs", () => {
  test("setTempo to same bpm produces byte-identical output", () => {
    const original = readFileSync(FIXTURE);
    const project = parseFLPFile(
      original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength),
    );
    const sameTempo = getTempo(project)!;
    const noOp = setTempo(project, sameTempo);
    const bytes = serializeFLPProject(noOp);

    expect(bytes.byteLength).toBe(original.byteLength);
    for (let i = 0; i < bytes.byteLength; i++) {
      if (bytes[i] !== original[i]) {
        throw new Error(`byte mismatch at offset ${i}: ${bytes[i]} vs ${original[i]}`);
      }
    }
  });
});

// --------------------------------------------------------------------------- //
// F2.1 — Pattern notes encoder (0xE0)                                          //
// --------------------------------------------------------------------------- //

const NOTE_FLAG_SLIDE = 0x08;

function noteAt(opts: {
  position: number;
  channel_iid: number;
  length: number;
  key: number;
  velocity?: number;
  flags?: number;
}) {
  return {
    position: opts.position,
    channel_iid: opts.channel_iid,
    length: opts.length,
    key: opts.key,
    flags: opts.flags ?? 0,
    slide: false,
    group: 0,
    fine_pitch: 120,
    release: 64,
    midi_channel: 0,
    pan: 64,
    velocity: opts.velocity ?? 100,
    mod_x: 128,
    mod_y: 128,
  };
}

describe("encodeNote — pure record encoder", () => {
  test("encodes a 24-byte record byte-exact (round-trip via decodeNotes)", () => {
    // Take a known-valid note from the parsed fixture; encode it; concat
    // with itself; decode; expect both copies match the input exactly.
    const project = loadProject(FIXTURE);
    const pattern = project.patterns.find((p) => p.id === 1);
    expect(pattern?.notes.length).toBeGreaterThan(0);
    const original = pattern!.notes[0]!;

    const blob = encodeNote(original);
    expect(blob.byteLength).toBe(24);

    // Two-record blob to make sure the encoder is offset-friendly.
    const doubled = new Uint8Array(48);
    doubled.set(blob, 0);
    doubled.set(blob, 24);
    // Re-decode by going through the public model decoder.
    // The decode helper isn't re-exported from mutations/, so reach
    // into the model directly.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { decodeNotes } = require("../src/model/pattern.ts") as {
      decodeNotes: (p: Uint8Array) => unknown[];
    };
    const decoded = decodeNotes(doubled);
    expect(decoded.length).toBe(2);
    expect(decoded[0]).toEqual(original);
    expect(decoded[1]).toEqual(original);
  });

  test("rejects key out of range [0, 131]", () => {
    expect(() => encodeNote(noteAt({ position: 0, channel_iid: 0, length: 96, key: -1 }))).toThrow(
      MutationError,
    );
    expect(() =>
      encodeNote(noteAt({ position: 0, channel_iid: 0, length: 96, key: 132 })),
    ).toThrow(MutationError);
  });

  test("rejects negative position or length", () => {
    expect(() =>
      encodeNote(noteAt({ position: -1, channel_iid: 0, length: 96, key: 60 })),
    ).toThrow(MutationError);
    expect(() => encodeNote(noteAt({ position: 0, channel_iid: 0, length: -1, key: 60 }))).toThrow(
      MutationError,
    );
  });

  test("rejects channel_iid out of u16 range", () => {
    expect(() =>
      encodeNote(noteAt({ position: 0, channel_iid: -1, length: 96, key: 60 })),
    ).toThrow(MutationError);
    expect(() =>
      encodeNote(noteAt({ position: 0, channel_iid: 70000, length: 96, key: 60 })),
    ).toThrow(MutationError);
  });
});

describe("addPatternNote", () => {
  test("appends a note to an existing pattern (round-trip via serialize)", () => {
    const project = loadProject(FIXTURE);
    const before = project.patterns.find((p) => p.id === 1);
    expect(before).toBeDefined();
    const baselineCount = before!.notes.length;

    const newNote = noteAt({
      position: 96, // beat 1 at PPQ=96
      channel_iid: 1,
      length: 48,
      key: 67, // G3
      velocity: 110,
    });
    const mutated = addPatternNote(project, 1, newNote);
    const reparsed = reparse(mutated);
    const pattern = reparsed.patterns.find((p) => p.id === 1)!;

    expect(pattern.notes.length).toBe(baselineCount + 1);
    const last = pattern.notes[pattern.notes.length - 1]!;
    expect(last.position).toBe(96);
    expect(last.channel_iid).toBe(1);
    expect(last.length).toBe(48);
    expect(last.key).toBe(67);
    expect(last.velocity).toBe(110);
  });

  test("creating a 0xE0 event for an unrelated pattern does NOT corrupt this one", () => {
    // Simulates "add note to pattern that already has notes"; the
    // encoder must not drop existing notes.
    const project = loadProject(FIXTURE);
    const baseline = project.patterns.find((p) => p.id === 1)!.notes.slice();

    const note = noteAt({ position: 192, channel_iid: 1, length: 24, key: 72 });
    const mutated = addPatternNote(project, 1, note);
    const reparsed = reparse(mutated);
    const pattern = reparsed.patterns.find((p) => p.id === 1)!;

    expect(pattern.notes.length).toBe(baseline.length + 1);
    // Existing notes preserved (compare by position+key+channel_iid; full-eq
    // comparison would also work because we don't touch them).
    for (const original of baseline) {
      expect(
        pattern.notes.some(
          (n) =>
            n.position === original.position &&
            n.key === original.key &&
            n.channel_iid === original.channel_iid,
        ),
      ).toBe(true);
    }
  });

  test("preserves slide-flag round-trip", () => {
    const project = loadProject(FIXTURE);
    const note = {
      ...noteAt({ position: 0, channel_iid: 1, length: 48, key: 60 }),
      flags: NOTE_FLAG_SLIDE,
    };
    const mutated = addPatternNote(project, 1, note);
    const reparsed = reparse(mutated);
    const pattern = reparsed.patterns.find((p) => p.id === 1)!;
    const slideNote = pattern.notes.find((n) => (n.flags & NOTE_FLAG_SLIDE) !== 0);
    expect(slideNote).toBeDefined();
    expect(slideNote?.slide).toBe(true);
  });

  test("EVENT_NOT_FOUND when pattern id doesn't exist", () => {
    const project = loadProject(FIXTURE);
    const note = noteAt({ position: 0, channel_iid: 0, length: 48, key: 60 });
    expect(() => addPatternNote(project, 999, note)).toThrow(MutationError);
    try {
      addPatternNote(project, 999, note);
      throw new Error("expected throw");
    } catch (e) {
      if (e instanceof MutationError) expect(e.code).toBe("EVENT_NOT_FOUND");
    }
  });

  test("rejects iid < 1 (FL is 1-indexed for patterns)", () => {
    const project = loadProject(FIXTURE);
    const note = noteAt({ position: 0, channel_iid: 0, length: 48, key: 60 });
    expect(() => addPatternNote(project, 0, note)).toThrow(MutationError);
    expect(() => addPatternNote(project, -1, note)).toThrow(MutationError);
  });

  test("source project not mutated", () => {
    const project = loadProject(FIXTURE);
    const beforeCount = project.patterns.find((p) => p.id === 1)!.notes.length;
    addPatternNote(project, 1, noteAt({ position: 0, channel_iid: 1, length: 48, key: 60 }));
    expect(project.patterns.find((p) => p.id === 1)!.notes.length).toBe(beforeCount);
  });
});

describe("setPatternNotes", () => {
  test("replaces all notes on a pattern (round-trip)", () => {
    const project = loadProject(FIXTURE);
    const replacement = [
      noteAt({ position: 0, channel_iid: 1, length: 48, key: 60 }),
      noteAt({ position: 96, channel_iid: 1, length: 48, key: 64 }),
      noteAt({ position: 192, channel_iid: 1, length: 48, key: 67 }),
    ];
    const mutated = setPatternNotes(project, 1, replacement);
    const reparsed = reparse(mutated);
    const pattern = reparsed.patterns.find((p) => p.id === 1)!;

    expect(pattern.notes.length).toBe(3);
    const positions = pattern.notes.map((n) => n.position).sort((a, b) => a - b);
    expect(positions).toEqual([0, 96, 192]);
    const keys = pattern.notes.map((n) => n.key).sort((a, b) => a - b);
    expect(keys).toEqual([60, 64, 67]);
  });

  test("clearing notes (empty array) removes all 0xE0 events from the pattern", () => {
    const project = loadProject(FIXTURE);
    const mutated = setPatternNotes(project, 1, []);
    const reparsed = reparse(mutated);
    const pattern = reparsed.patterns.find((p) => p.id === 1)!;
    expect(pattern.notes.length).toBe(0);
  });

  test("EVENT_NOT_FOUND on unknown pattern", () => {
    const project = loadProject(FIXTURE);
    expect(() => setPatternNotes(project, 999, [])).toThrow(MutationError);
  });

  test("source project not mutated", () => {
    const project = loadProject(FIXTURE);
    const beforeCount = project.patterns.find((p) => p.id === 1)!.notes.length;
    setPatternNotes(project, 1, []);
    expect(project.patterns.find((p) => p.id === 1)!.notes.length).toBe(beforeCount);
  });
});

describe("removePatternNote", () => {
  test("removes by index (round-trip)", () => {
    const project = loadProject(FIXTURE);
    // Seed three notes via setPatternNotes so we have a known-shape baseline.
    const seeded = setPatternNotes(project, 1, [
      noteAt({ position: 0, channel_iid: 1, length: 48, key: 60 }),
      noteAt({ position: 96, channel_iid: 1, length: 48, key: 64 }),
      noteAt({ position: 192, channel_iid: 1, length: 48, key: 67 }),
    ]);
    const mutated = removePatternNote(seeded, 1, 1); // remove middle (key=64)
    const reparsed = reparse(mutated);
    const pattern = reparsed.patterns.find((p) => p.id === 1)!;

    expect(pattern.notes.length).toBe(2);
    const keys = pattern.notes.map((n) => n.key).sort((a, b) => a - b);
    expect(keys).toEqual([60, 67]);
  });

  test("removes by predicate (e.g., all notes with key < 65)", () => {
    const project = loadProject(FIXTURE);
    const seeded = setPatternNotes(project, 1, [
      noteAt({ position: 0, channel_iid: 1, length: 48, key: 48 }),
      noteAt({ position: 96, channel_iid: 1, length: 48, key: 60 }),
      noteAt({ position: 192, channel_iid: 1, length: 48, key: 72 }),
    ]);
    const mutated = removePatternNote(seeded, 1, (n) => n.key < 65);
    const reparsed = reparse(mutated);
    const pattern = reparsed.patterns.find((p) => p.id === 1)!;

    expect(pattern.notes.length).toBe(1);
    expect(pattern.notes[0]!.key).toBe(72);
  });

  test("rejects out-of-range index", () => {
    const project = loadProject(FIXTURE);
    expect(() => removePatternNote(project, 1, -1)).toThrow(MutationError);
    expect(() => removePatternNote(project, 1, 9999)).toThrow(MutationError);
  });

  test("EVENT_NOT_FOUND on unknown pattern id", () => {
    const project = loadProject(FIXTURE);
    expect(() => removePatternNote(project, 999, 0)).toThrow(MutationError);
  });

  test("source project not mutated", () => {
    const project = loadProject(FIXTURE);
    const beforeCount = project.patterns.find((p) => p.id === 1)!.notes.length;
    removePatternNote(project, 1, 0);
    expect(project.patterns.find((p) => p.id === 1)!.notes.length).toBe(beforeCount);
  });
});

// --------------------------------------------------------------------------- //
// F2.2 — Pattern controllers (0xDF)                                            //
// --------------------------------------------------------------------------- //

function ctrl(opts: {
  position: number;
  channel: number;
  value: number;
  flags?: number;
}) {
  return {
    position: opts.position,
    channel: opts.channel,
    value: opts.value,
    flags: opts.flags ?? 0,
  };
}

describe("encodeController — pure record encoder", () => {
  test("encodes a 12-byte record byte-exact (round-trip via decodeControllers)", () => {
    const c = ctrl({ position: 96, channel: 3, value: 0.5, flags: 0 });
    const blob = encodeController(c);
    expect(blob.byteLength).toBe(12);

    // Two-record blob to make sure the encoder is offset-friendly.
    const doubled = new Uint8Array(24);
    doubled.set(blob, 0);
    doubled.set(blob, 12);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { decodeControllers } = require("../src/model/pattern.ts") as {
      decodeControllers: (p: Uint8Array) => unknown[];
    };
    const decoded = decodeControllers(doubled) as Array<{
      position: number;
      channel: number;
      value: number;
      flags: number;
    }>;
    expect(decoded.length).toBe(2);
    for (const d of decoded) {
      expect(d.position).toBe(96);
      expect(d.channel).toBe(3);
      expect(d.flags).toBe(0);
      // Float32 round-trip: 0.5 is exact.
      expect(d.value).toBe(0.5);
    }
  });

  test("preserves arbitrary float32 value (within float32 precision)", () => {
    const c = ctrl({ position: 0, channel: 0, value: 0.123456 });
    const blob = encodeController(c);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { decodeControllers } = require("../src/model/pattern.ts") as {
      decodeControllers: (p: Uint8Array) => unknown[];
    };
    const decoded = decodeControllers(blob) as Array<{ value: number }>;
    expect(Math.abs(decoded[0]!.value - 0.123456)).toBeLessThan(1e-6);
  });

  test("rejects negative position or out-of-u32 range", () => {
    expect(() => encodeController(ctrl({ position: -1, channel: 0, value: 0.5 }))).toThrow(
      MutationError,
    );
    expect(() =>
      encodeController(ctrl({ position: 0xffffffff + 1, channel: 0, value: 0.5 })),
    ).toThrow(MutationError);
  });

  test("rejects out-of-u8 channel", () => {
    expect(() => encodeController(ctrl({ position: 0, channel: -1, value: 0.5 }))).toThrow(
      MutationError,
    );
    expect(() => encodeController(ctrl({ position: 0, channel: 256, value: 0.5 }))).toThrow(
      MutationError,
    );
  });

  test("rejects non-finite value", () => {
    expect(() => encodeController(ctrl({ position: 0, channel: 0, value: NaN }))).toThrow(
      MutationError,
    );
    expect(() =>
      encodeController(ctrl({ position: 0, channel: 0, value: Infinity })),
    ).toThrow(MutationError);
  });
});

describe("addPatternController", () => {
  test("appends a controller to an existing pattern (round-trip via serialize)", () => {
    const project = loadProject(FIXTURE);
    const before = project.patterns.find((p) => p.id === 1);
    const baselineCount = before!.controllers.length;

    const newCtrl = ctrl({ position: 96, channel: 1, value: 0.75, flags: 0 });
    const mutated = addPatternController(project, 1, newCtrl);
    const reparsed = reparse(mutated);
    const pattern = reparsed.patterns.find((p) => p.id === 1)!;

    expect(pattern.controllers.length).toBe(baselineCount + 1);
    const last = pattern.controllers[pattern.controllers.length - 1]!;
    expect(last.position).toBe(96);
    expect(last.channel).toBe(1);
    expect(last.value).toBe(0.75);
  });

  test("EVENT_NOT_FOUND when pattern id doesn't exist", () => {
    const project = loadProject(FIXTURE);
    expect(() => addPatternController(project, 999, ctrl({ position: 0, channel: 0, value: 0 }))).toThrow(
      MutationError,
    );
  });

  test("rejects pattern id < 1", () => {
    const project = loadProject(FIXTURE);
    expect(() => addPatternController(project, 0, ctrl({ position: 0, channel: 0, value: 0 }))).toThrow(
      MutationError,
    );
  });

  test("source project not mutated", () => {
    const project = loadProject(FIXTURE);
    const beforeCount = project.patterns.find((p) => p.id === 1)!.controllers.length;
    addPatternController(project, 1, ctrl({ position: 0, channel: 0, value: 0.5 }));
    expect(project.patterns.find((p) => p.id === 1)!.controllers.length).toBe(beforeCount);
  });
});

describe("setPatternControllers", () => {
  test("replaces all controllers on a pattern (round-trip)", () => {
    const project = loadProject(FIXTURE);
    const replacement = [
      ctrl({ position: 0, channel: 1, value: 0.0 }),
      ctrl({ position: 96, channel: 1, value: 0.5 }),
      ctrl({ position: 192, channel: 1, value: 1.0 }),
    ];
    const mutated = setPatternControllers(project, 1, replacement);
    const reparsed = reparse(mutated);
    const pattern = reparsed.patterns.find((p) => p.id === 1)!;

    expect(pattern.controllers.length).toBe(3);
    const positions = pattern.controllers.map((c) => c.position).sort((a, b) => a - b);
    expect(positions).toEqual([0, 96, 192]);
    const values = pattern.controllers.map((c) => c.value).sort((a, b) => a - b);
    expect(values).toEqual([0.0, 0.5, 1.0]);
  });

  test("clearing controllers (empty array) drops all 0xDF events", () => {
    const project = loadProject(FIXTURE);
    // Seed something then clear.
    const seeded = setPatternControllers(project, 1, [
      ctrl({ position: 0, channel: 1, value: 0.5 }),
    ]);
    const cleared = setPatternControllers(seeded, 1, []);
    const reparsed = reparse(cleared);
    const pattern = reparsed.patterns.find((p) => p.id === 1)!;
    expect(pattern.controllers.length).toBe(0);
  });

  test("EVENT_NOT_FOUND on unknown pattern", () => {
    const project = loadProject(FIXTURE);
    expect(() => setPatternControllers(project, 999, [])).toThrow(MutationError);
  });

  test("source project not mutated", () => {
    const project = loadProject(FIXTURE);
    const beforeCount = project.patterns.find((p) => p.id === 1)!.controllers.length;
    setPatternControllers(project, 1, [ctrl({ position: 0, channel: 0, value: 0.5 })]);
    expect(project.patterns.find((p) => p.id === 1)!.controllers.length).toBe(beforeCount);
  });

  test("notes on the pattern are not disturbed by controller mutations", () => {
    const project = loadProject(FIXTURE);
    const noteCountBefore = project.patterns.find((p) => p.id === 1)!.notes.length;
    const mutated = setPatternControllers(project, 1, [
      ctrl({ position: 0, channel: 1, value: 0.5 }),
    ]);
    const reparsed = reparse(mutated);
    const pattern = reparsed.patterns.find((p) => p.id === 1)!;
    expect(pattern.notes.length).toBe(noteCountBefore);
    expect(pattern.controllers.length).toBe(1);
  });
});

describe("removePatternController", () => {
  test("removes by index (round-trip)", () => {
    const project = loadProject(FIXTURE);
    const seeded = setPatternControllers(project, 1, [
      ctrl({ position: 0, channel: 1, value: 0.0 }),
      ctrl({ position: 96, channel: 1, value: 0.5 }),
      ctrl({ position: 192, channel: 1, value: 1.0 }),
    ]);
    const mutated = removePatternController(seeded, 1, 1);
    const reparsed = reparse(mutated);
    const pattern = reparsed.patterns.find((p) => p.id === 1)!;

    expect(pattern.controllers.length).toBe(2);
    const positions = pattern.controllers.map((c) => c.position).sort((a, b) => a - b);
    expect(positions).toEqual([0, 192]);
  });

  test("removes by predicate (channel == 2)", () => {
    const project = loadProject(FIXTURE);
    const seeded = setPatternControllers(project, 1, [
      ctrl({ position: 0, channel: 1, value: 0.5 }),
      ctrl({ position: 96, channel: 2, value: 0.5 }),
      ctrl({ position: 192, channel: 2, value: 0.5 }),
      ctrl({ position: 288, channel: 1, value: 0.5 }),
    ]);
    const mutated = removePatternController(seeded, 1, (c) => c.channel === 2);
    const reparsed = reparse(mutated);
    const pattern = reparsed.patterns.find((p) => p.id === 1)!;

    expect(pattern.controllers.length).toBe(2);
    expect(pattern.controllers.every((c) => c.channel === 1)).toBe(true);
  });

  test("rejects out-of-range index", () => {
    const project = loadProject(FIXTURE);
    expect(() => removePatternController(project, 1, -1)).toThrow(MutationError);
    expect(() => removePatternController(project, 1, 9999)).toThrow(MutationError);
  });

  test("EVENT_NOT_FOUND on unknown pattern id", () => {
    const project = loadProject(FIXTURE);
    expect(() => removePatternController(project, 999, 0)).toThrow(MutationError);
  });
});

// --------------------------------------------------------------------------- //
// F2.3 — Pattern + channel creation                                            //
// --------------------------------------------------------------------------- //

describe("createPattern", () => {
  test("creates a new pattern with id = max(existing) + 1 (round-trip)", () => {
    const project = loadProject(FIXTURE);
    const beforeIds = project.patterns.map((p) => p.id);
    const beforeMax = beforeIds.length > 0 ? Math.max(...beforeIds) : 0;

    const { project: mutated, id } = createPattern(project, { name: "NewVerse" });
    expect(id).toBe(beforeMax + 1);

    const reparsed = reparse(mutated);
    const created = reparsed.patterns.find((p) => p.id === id);
    expect(created).toBeDefined();
    expect(created?.name).toBe("NewVerse");
    expect(created?.notes.length).toBe(0);
    expect(created?.controllers.length).toBe(0);
  });

  test("default name is empty string when not supplied", () => {
    const project = loadProject(FIXTURE);
    const { project: mutated, id } = createPattern(project);
    const reparsed = reparse(mutated);
    const created = reparsed.patterns.find((p) => p.id === id);
    expect(created).toBeDefined();
    // Empty name reads back as "" via decodeTextEvent (or undefined if FL
    // strips). Accept either as long as it's not garbage.
    expect(["", undefined]).toContain(created?.name);
  });

  test("preserves existing patterns (notes, controllers, color)", () => {
    const project = loadProject(FIXTURE);
    const before = project.patterns.find((p) => p.id === 1)!;
    const beforeNoteCount = before.notes.length;

    const { project: mutated } = createPattern(project, { name: "added" });
    const reparsed = reparse(mutated);
    const original = reparsed.patterns.find((p) => p.id === 1)!;
    expect(original.notes.length).toBe(beforeNoteCount);
    expect(original.name).toBe(before.name);
  });

  test("subsequent addPatternNote on the new pattern works", () => {
    const project = loadProject(FIXTURE);
    const { project: withPattern, id } = createPattern(project, { name: "melody" });
    const note = noteAt({ position: 0, channel_iid: 1, length: 96, key: 60 });
    const { project: withNote } = { project: addPatternNote(withPattern, id, note) };
    const reparsed = reparse(withNote);
    const created = reparsed.patterns.find((p) => p.id === id)!;
    expect(created.notes.length).toBe(1);
    expect(created.notes[0]!.key).toBe(60);
  });

  test("rejects non-string name", () => {
    const project = loadProject(FIXTURE);
    expect(() => createPattern(project, { name: 123 as unknown as string })).toThrow(
      MutationError,
    );
  });

  test("rejects oversize name", () => {
    const project = loadProject(FIXTURE);
    const huge = "x".repeat(257);
    expect(() => createPattern(project, { name: huge })).toThrow(MutationError);
  });

  test("source project not mutated", () => {
    const project = loadProject(FIXTURE);
    const beforeCount = project.patterns.length;
    createPattern(project, { name: "added" });
    expect(project.patterns.length).toBe(beforeCount);
  });

  test("two consecutive creates yield distinct ids", () => {
    const project = loadProject(FIXTURE);
    const { project: p1, id: id1 } = createPattern(project, { name: "a" });
    const { project: p2, id: id2 } = createPattern(p1, { name: "b" });
    expect(id2).toBe(id1 + 1);
    const reparsed = reparse(p2);
    const ids = reparsed.patterns.map((p) => p.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });
});

describe("createChannel", () => {
  test("creates a sampler channel with iid = max(existing) + 1 (round-trip)", () => {
    const project = loadProject(FIXTURE);
    const beforeIids = project.channels.map((c) => c.iid);
    const beforeMax = beforeIids.length > 0 ? Math.max(...beforeIids) : -1;

    const { project: mutated, iid } = createChannel(project, { name: "MySynth" });
    expect(iid).toBe(beforeMax + 1);

    const reparsed = reparse(mutated);
    const created = reparsed.channels.find((c) => c.iid === iid);
    expect(created).toBeDefined();
    expect(created?.name).toBe("MySynth");
    expect(created?.kind).toBe("sampler");
  });

  test("kind=instrument yields instrument-classified channel", () => {
    const project = loadProject(FIXTURE);
    const { project: mutated, iid } = createChannel(project, { name: "Plug", kind: "instrument" });
    const reparsed = reparse(mutated);
    const created = reparsed.channels.find((c) => c.iid === iid);
    expect(created?.kind).toBe("instrument");
  });

  test("kind=automation yields automation-classified channel", () => {
    const project = loadProject(FIXTURE);
    const { project: mutated, iid } = createChannel(project, {
      name: "VolAuto",
      kind: "automation",
    });
    const reparsed = reparse(mutated);
    const created = reparsed.channels.find((c) => c.iid === iid);
    expect(created?.kind).toBe("automation");
  });

  test("preserves existing channels", () => {
    const project = loadProject(FIXTURE);
    const beforeKick = project.channels.find((c) => c.name === "Kick");
    expect(beforeKick).toBeDefined();

    const { project: mutated } = createChannel(project, { name: "Newchan" });
    const reparsed = reparse(mutated);
    const kick = reparsed.channels.find((c) => c.name === "Kick");
    expect(kick).toBeDefined();
    expect(kick!.iid).toBe(beforeKick!.iid);
  });

  test("rejects unknown kind", () => {
    const project = loadProject(FIXTURE);
    expect(() =>
      createChannel(project, { name: "x", kind: "synthesizer" as never }),
    ).toThrow(MutationError);
  });

  test("rejects non-string name", () => {
    const project = loadProject(FIXTURE);
    expect(() => createChannel(project, { name: 5 as unknown as string })).toThrow(MutationError);
  });

  test("source project not mutated", () => {
    const project = loadProject(FIXTURE);
    const beforeCount = project.channels.length;
    createChannel(project, { name: "added" });
    expect(project.channels.length).toBe(beforeCount);
  });

  test("two consecutive creates yield distinct iids", () => {
    const project = loadProject(FIXTURE);
    const { project: p1, iid: iid1 } = createChannel(project, { name: "a" });
    const { project: p2, iid: iid2 } = createChannel(p1, { name: "b" });
    expect(iid2).toBe(iid1 + 1);
  });

  test("subsequent setChannelColor on the new channel works", () => {
    const project = loadProject(FIXTURE);
    const { project: withChan, iid } = createChannel(project, { name: "Colored" });
    const colored = setChannelColor(withChan, iid, { r: 255, g: 100, b: 50 });
    const reparsed = reparse(colored);
    const c = reparsed.channels.find((x) => x.iid === iid);
    expect(c?.color).toBeDefined();
    expect(c?.color?.r).toBe(255);
  });
});

// --------------------------------------------------------------------------- //
// F2.4 — Native plugin params (Fruity Parametric EQ 2 prototype)              //
// --------------------------------------------------------------------------- //

function utf16leNul(s: string): Uint8Array {
  const out = new Uint8Array((s.length + 1) * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++) view.setUint16(i * 2, s.charCodeAt(i), true);
  return out;
}

/**
 * Build a synthetic FLPProject containing two mixer slots with EQ 2:
 *  - Insert 1, Slot 0: Fruity parametric EQ 2 (354-byte zero blob)
 *  - Insert 2, Slot 3: Fruity Parametric EQ 2 (354-byte zero blob)
 * Master (insert 0) is empty.
 */
function makeEQ2Project(): FLPProject {
  const eq2A = new Uint8Array(354);
  const eq2B = new Uint8Array(354);
  const events: FLPEvent[] = [
    { kind: "blob", opcode: 0xec, payload: new Uint8Array(0) }, // INSERT_FLAGS opens mixer
    { kind: "blob", opcode: 0x93, payload: new Uint8Array(4) }, // master closes (insert 0 → 1)
    { kind: "u16", opcode: 0x62, value: 0 }, // insert 1, slot 0
    { kind: "blob", opcode: 0xcb, payload: utf16leNul("Fruity parametric EQ 2") },
    { kind: "blob", opcode: 0xd5, payload: eq2A },
    { kind: "blob", opcode: 0x93, payload: new Uint8Array(4) }, // insert 1 closes
    { kind: "u16", opcode: 0x62, value: 3 }, // insert 2, slot 3
    { kind: "blob", opcode: 0xcb, payload: utf16leNul("Fruity Parametric EQ 2") },
    { kind: "blob", opcode: 0xd5, payload: eq2B },
    { kind: "blob", opcode: 0x93, payload: new Uint8Array(4) }, // insert 2 closes
  ];
  return {
    header: { format: 0, n_channels: 0, ppq: 96 },
    events,
    metadata: {} as never,
    channels: [],
    inserts: [],
    patterns: [],
    arrangements: [],
    insertRouting: [],
  };
}

function readU16LE(buf: Uint8Array, offset: number): number {
  return buf[offset]! | (buf[offset + 1]! << 8);
}

describe("setNativePluginParam — Fruity Parametric EQ 2", () => {
  test("patches band 1 freq at byte 0x20 (uint16 LE = round(v * 0xFFFF))", () => {
    const project = makeEQ2Project();
    const mutated = setNativePluginParam(
      project,
      { kind: "mixer_slot", insertIndex: 1, slotIndex: 0 },
      { kind: "band", band: 1, field: "freq" },
      0.5,
    );
    // Find the EQ2 blob that we mutated.
    const ev = mutated.events.find(
      (e, i) => e.opcode === 0xd5 && i === 4,
    )!;
    if (ev.kind !== "blob") throw new Error("expected blob");
    expect(ev.payload.byteLength).toBe(354);
    const raw = readU16LE(ev.payload, 0x20);
    // round(0.5 * 0xFFFF) = 32768 = 0x8000
    expect(raw).toBe(0x8000);
  });

  test("patches main level at byte 0x90", () => {
    const project = makeEQ2Project();
    const mutated = setNativePluginParam(
      project,
      { kind: "mixer_slot", insertIndex: 1, slotIndex: 0 },
      { kind: "main_level" },
      0.75,
    );
    const ev = mutated.events[4]!;
    if (ev.kind !== "blob") throw new Error("expected blob");
    expect(readU16LE(ev.payload, 0x90)).toBe(Math.round(0.75 * 0xffff));
  });

  test("patches band 7 width at byte 0x3c + 6*4 = 0x54", () => {
    const project = makeEQ2Project();
    const mutated = setNativePluginParam(
      project,
      { kind: "mixer_slot", insertIndex: 1, slotIndex: 0 },
      { kind: "band", band: 7, field: "width" },
      0.3,
    );
    const ev = mutated.events[4]!;
    if (ev.kind !== "blob") throw new Error("expected blob");
    expect(readU16LE(ev.payload, 0x54)).toBe(Math.round(0.3 * 0xffff));
  });

  test("finds plugin at insert N slot 0 even when no preceding 0x62 marker", () => {
    // Regression: FL omits the 0x62 NEW_SLOT marker for the FIRST
    // plugin in an insert — events appear directly after OP_INSERT_FLAGS.
    // findPluginStateEvent must default curSlotIdx=0 per insert.
    // Before fix: EVENT_NOT_FOUND because curSlotIdx stayed at -1.
    const eq2 = new Uint8Array(354);
    const project: FLPProject = {
      header: { format: 0, n_channels: 0, ppq: 96 },
      events: [
        { kind: "blob", opcode: 0xec, payload: new Uint8Array(0) }, // INSERT_FLAGS opens master (insert 0)
        { kind: "blob", opcode: 0x93, payload: new Uint8Array(4) }, // master closes -> insert 1
        { kind: "blob", opcode: 0xec, payload: new Uint8Array(0) }, // INSERT_FLAGS opens insert 1
        { kind: "blob", opcode: 0xcb, payload: utf16leNul("Fruity Parametric EQ 2") }, // name in slot 0 (no 0x62 yet)
        { kind: "blob", opcode: 0xd5, payload: eq2 },                                  // state in slot 0
        { kind: "u16", opcode: 0x62, value: 0 }, // NEW_SLOT 0 closes the implicit slot
        { kind: "blob", opcode: 0x93, payload: new Uint8Array(4) }, // insert 1 closes
      ],
      metadata: {} as never,
      channels: [],
      inserts: [],
      patterns: [],
      arrangements: [],
      insertRouting: [],
    };
    const mutated = setNativePluginParam(
      project,
      { kind: "mixer_slot", insertIndex: 1, slotIndex: 0 },
      { kind: "main_level" },
      0.5,
    );
    const ev = mutated.events[4]!;
    if (ev.kind !== "blob") throw new Error("expected blob");
    expect(readU16LE(ev.payload, 0x90)).toBe(0x8000);
  });

  test("targets the correct slot when multiple EQ 2 instances exist", () => {
    const project = makeEQ2Project();
    // Patch insert 2 / slot 3, NOT insert 1 / slot 0.
    const mutated = setNativePluginParam(
      project,
      { kind: "mixer_slot", insertIndex: 2, slotIndex: 3 },
      { kind: "band", band: 1, field: "freq" },
      0.5,
    );
    // Slot at insert 1 (events[4]) should be UNTOUCHED.
    const evA = mutated.events[4]!;
    if (evA.kind !== "blob") throw new Error("expected blob");
    expect(readU16LE(evA.payload, 0x20)).toBe(0); // baseline zero blob

    // Slot at insert 2 (events[8]) should be patched.
    const evB = mutated.events[8]!;
    if (evB.kind !== "blob") throw new Error("expected blob");
    expect(readU16LE(evB.payload, 0x20)).toBe(0x8000);
  });

  test("source project not mutated", () => {
    const project = makeEQ2Project();
    setNativePluginParam(
      project,
      { kind: "mixer_slot", insertIndex: 1, slotIndex: 0 },
      { kind: "main_level" },
      0.5,
    );
    const ev = project.events[4]!;
    if (ev.kind !== "blob") throw new Error("expected blob");
    expect(readU16LE(ev.payload, 0x90)).toBe(0);
  });

  test("rejects normalizedValue outside [0, 1]", () => {
    const project = makeEQ2Project();
    const ref = { kind: "main_level" } as const;
    const scope = { kind: "mixer_slot", insertIndex: 1, slotIndex: 0 } as const;
    expect(() => setNativePluginParam(project, scope, ref, -0.01)).toThrow(MutationError);
    expect(() => setNativePluginParam(project, scope, ref, 1.01)).toThrow(MutationError);
    expect(() => setNativePluginParam(project, scope, ref, NaN)).toThrow(MutationError);
  });

  test("rejects unknown band number", () => {
    const project = makeEQ2Project();
    expect(() =>
      setNativePluginParam(
        project,
        { kind: "mixer_slot", insertIndex: 1, slotIndex: 0 },
        { kind: "band", band: 0, field: "freq" },
        0.5,
      ),
    ).toThrow(MutationError);
    expect(() =>
      setNativePluginParam(
        project,
        { kind: "mixer_slot", insertIndex: 1, slotIndex: 0 },
        { kind: "band", band: 8, field: "freq" },
        0.5,
      ),
    ).toThrow(MutationError);
  });

  test("EVENT_NOT_FOUND when scope has no plugin state event", () => {
    const project = makeEQ2Project();
    expect(() =>
      setNativePluginParam(
        project,
        { kind: "mixer_slot", insertIndex: 99, slotIndex: 0 },
        { kind: "main_level" },
        0.5,
      ),
    ).toThrow(MutationError);
  });

  test("UNSUPPORTED_PLUGIN for non-EQ2 plugin", () => {
    const project = makeEQ2Project();
    // Replace the plugin name on insert 1 / slot 0 with something unknown.
    const newEvents = [...project.events];
    newEvents[3] = { kind: "blob", opcode: 0xcb, payload: utf16leNul("Unknown Plugin Name") };
    const altered: FLPProject = { ...project, events: newEvents };
    expect(() =>
      setNativePluginParam(
        altered,
        { kind: "mixer_slot", insertIndex: 1, slotIndex: 0 },
        { kind: "main_level" },
        0.5,
      ),
    ).toThrow(MutationError);
  });

  test("UNSUPPORTED_PLUGIN when EQ 2 blob is too small (missing param slots)", () => {
    const project = makeEQ2Project();
    // Shrink the EQ2 blob to 100 bytes (below the 0x92 minimum) — reject.
    const newEvents = [...project.events];
    newEvents[4] = { kind: "blob", opcode: 0xd5, payload: new Uint8Array(100) };
    const altered: FLPProject = { ...project, events: newEvents };
    expect(() =>
      setNativePluginParam(
        altered,
        { kind: "mixer_slot", insertIndex: 1, slotIndex: 0 },
        { kind: "main_level" },
        0.5,
      ),
    ).toThrow(MutationError);
  });

  test("accepts older FL save's 350-byte EQ 2 blob (only trailing state differs)", () => {
    const project = makeEQ2Project();
    // FL 25.2.4 emits 354 bytes; older FL saves 350. Both have the same
    // parameter offsets up to 0x91; only the trailing opaque state differs.
    const newEvents = [...project.events];
    newEvents[4] = { kind: "blob", opcode: 0xd5, payload: new Uint8Array(350) };
    const altered: FLPProject = { ...project, events: newEvents };
    const mutated = setNativePluginParam(
      altered,
      { kind: "mixer_slot", insertIndex: 1, slotIndex: 0 },
      { kind: "band", band: 1, field: "freq" },
      0.5,
    );
    const ev = mutated.events[4]!;
    if (ev.kind !== "blob") throw new Error("expected blob");
    expect(ev.payload.byteLength).toBe(350);
    expect(readU16LE(ev.payload, 0x20)).toBe(0x8000);
  });
});

// --------------------------------------------------------------------------- //
// 4-byte field types (u32 / f32 / i32_bipolar) — exercised through real      //
// plugin layouts (Reeverb 2 stereo separation, scale=64).                    //
// --------------------------------------------------------------------------- //

function readI32LE(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getInt32(offset, true);
}

function makeReeverb2Project(): FLPProject {
  // Canonical Reeverb 2 user-saved blob is 66 bytes; param 9 (Stereo
  // separation) lives at offset 0x28 as a 4-byte slot.
  const blob = new Uint8Array(66);
  const events: FLPEvent[] = [
    { kind: "blob", opcode: 0xec, payload: new Uint8Array(0) },
    { kind: "blob", opcode: 0x93, payload: new Uint8Array(4) },
    { kind: "u16", opcode: 0x62, value: 0 }, // insert 1, slot 0
    { kind: "blob", opcode: 0xcb, payload: utf16leNul("Fruity Reeverb 2") },
    { kind: "blob", opcode: 0xd5, payload: blob },
    { kind: "blob", opcode: 0x93, payload: new Uint8Array(4) },
  ];
  return {
    header: { format: 0, n_channels: 0, ppq: 96 },
    events,
    metadata: {} as never,
    channels: [],
    inserts: [],
    patterns: [],
    arrangements: [],
    insertRouting: [],
  };
}

describe("setNativePluginParam — i32_bipolar field type", () => {
  test("Reeverb 2 stereo separation (scale=64): 0.5 -> 0", () => {
    const project = makeReeverb2Project();
    const mutated = setNativePluginParam(
      project,
      { kind: "mixer_slot", insertIndex: 1, slotIndex: 0 },
      { kind: "param", index: 9 },
      0.5,
    );
    const ev = mutated.events[4]!;
    if (ev.kind !== "blob") throw new Error("expected blob");
    expect(readI32LE(ev.payload, 0x28)).toBe(0);
  });

  test("Reeverb 2 stereo separation: 0.0 -> -64", () => {
    const project = makeReeverb2Project();
    const mutated = setNativePluginParam(
      project,
      { kind: "mixer_slot", insertIndex: 1, slotIndex: 0 },
      { kind: "param", index: 9 },
      0.0,
    );
    const ev = mutated.events[4]!;
    if (ev.kind !== "blob") throw new Error("expected blob");
    expect(readI32LE(ev.payload, 0x28)).toBe(-64);
    // -64 LE = c0 ff ff ff
    expect(ev.payload[0x28]).toBe(0xc0);
    expect(ev.payload[0x29]).toBe(0xff);
    expect(ev.payload[0x2a]).toBe(0xff);
    expect(ev.payload[0x2b]).toBe(0xff);
  });

  test("Reeverb 2 stereo separation: 1.0 -> +64", () => {
    const project = makeReeverb2Project();
    const mutated = setNativePluginParam(
      project,
      { kind: "mixer_slot", insertIndex: 1, slotIndex: 0 },
      { kind: "param", index: 9 },
      1.0,
    );
    const ev = mutated.events[4]!;
    if (ev.kind !== "blob") throw new Error("expected blob");
    expect(readI32LE(ev.payload, 0x28)).toBe(64);
  });

  test("Reeverb 2 stereo separation: 0.25 -> -32 (linear interp)", () => {
    const project = makeReeverb2Project();
    const mutated = setNativePluginParam(
      project,
      { kind: "mixer_slot", insertIndex: 1, slotIndex: 0 },
      { kind: "param", index: 9 },
      0.25,
    );
    const ev = mutated.events[4]!;
    if (ev.kind !== "blob") throw new Error("expected blob");
    expect(readI32LE(ev.payload, 0x28)).toBe(-32);
  });

  test("does not touch surrounding bytes (4-byte slot is bounded)", () => {
    const project = makeReeverb2Project();
    const mutated = setNativePluginParam(
      project,
      { kind: "mixer_slot", insertIndex: 1, slotIndex: 0 },
      { kind: "param", index: 9 },
      0.75,
    );
    const ev = mutated.events[4]!;
    if (ev.kind !== "blob") throw new Error("expected blob");
    expect(ev.payload[0x27]).toBe(0);
    expect(ev.payload[0x2c]).toBe(0);
  });
});

// --------------------------------------------------------------------------- //
// F6.1 — Note transformations + pattern length writer                          //
// --------------------------------------------------------------------------- //

function makePatternProject(notes: Array<Partial<{
  position: number; length: number; key: number; channel_iid: number; velocity: number;
}>>, opts: { patternLength?: number; channelIid?: number } = {}): FLPProject {
  const ch = opts.channelIid ?? 1;
  const fullNotes = notes.map((n) => ({
    position: n.position ?? 0,
    channel_iid: n.channel_iid ?? ch,
    length: n.length ?? 96,
    key: n.key ?? 60,
    flags: 0,
    slide: false,
    group: 0,
    fine_pitch: 120,
    release: 64,
    midi_channel: 0,
    pan: 64,
    velocity: n.velocity ?? 100,
    mod_x: 128,
    mod_y: 128,
  }));
  const project = loadProject(FIXTURE);
  let next = setPatternNotes(project, 1, fullNotes);
  if (opts.patternLength !== undefined) {
    next = setPatternLength(next, 1, opts.patternLength);
  }
  return next;
}

function notesIn(project: FLPProject, patternId: number) {
  const reparsed = reparse(project);
  return reparsed.patterns.find((p) => p.id === patternId)?.notes ?? [];
}

describe("setPatternLength", () => {
  test("inserts a 0xA4 event when none exists", () => {
    const project = loadProject(FIXTURE);
    const mutated = setPatternLength(project, 1, 384);
    const reparsed = reparse(mutated);
    const p = reparsed.patterns.find((x) => x.id === 1)!;
    expect(p.length).toBe(384);
  });

  test("replaces existing 0xA4 in-place", () => {
    const project = setPatternLength(loadProject(FIXTURE), 1, 384);
    const mutated = setPatternLength(project, 1, 768);
    const reparsed = reparse(mutated);
    expect(reparsed.patterns.find((p) => p.id === 1)?.length).toBe(768);
  });

  test("rejects unknown pattern id", () => {
    expect(() => setPatternLength(loadProject(FIXTURE), 999, 384)).toThrow(MutationError);
  });

  test("rejects bad ticks", () => {
    expect(() => setPatternLength(loadProject(FIXTURE), 1, -1)).toThrow(MutationError);
    expect(() => setPatternLength(loadProject(FIXTURE), 1, 0xffffffff + 1)).toThrow(MutationError);
  });
});

describe("transposePatternNotes", () => {
  test("shifts every note's key by N semitones", () => {
    const project = makePatternProject([
      { position: 0, key: 60 },
      { position: 96, key: 64 },
      { position: 192, key: 67 },
    ]);
    const mutated = transposePatternNotes(project, 1, 12);
    const notes = notesIn(mutated, 1);
    expect(notes.map((n) => n.key)).toEqual([72, 76, 79]);
  });

  test("clamps to [0, 131] at boundaries", () => {
    const project = makePatternProject([{ position: 0, key: 0 }, { position: 96, key: 131 }]);
    const down = transposePatternNotes(project, 1, -10);
    expect(notesIn(down, 1).map((n) => n.key)).toEqual([0, 121]); // 0 clamped, 131-10=121
    const up = transposePatternNotes(project, 1, 10);
    expect(notesIn(up, 1).map((n) => n.key)).toEqual([10, 131]); // 0+10=10, 131 clamped
  });

  test("channel filter restricts which notes shift", () => {
    const project = makePatternProject([
      { channel_iid: 1, key: 60 },
      { channel_iid: 2, key: 60 },
    ]);
    const mutated = transposePatternNotes(project, 1, 7, 1);
    const byCh = Object.fromEntries(notesIn(mutated, 1).map((n) => [n.channel_iid, n.key]));
    expect(byCh[1]).toBe(67);
    expect(byCh[2]).toBe(60); // untouched
  });

  test("does NOT auto-grow pattern length (pure pitch op)", () => {
    const project = setPatternLength(makePatternProject([{ position: 0, key: 60 }]), 1, 384);
    const mutated = transposePatternNotes(project, 1, 12);
    expect(reparse(mutated).patterns.find((p) => p.id === 1)?.length).toBe(384);
  });

  test("rejects non-integer semitones", () => {
    expect(() => transposePatternNotes(loadProject(FIXTURE), 1, 1.5)).toThrow(MutationError);
  });
});

describe("quantizePatternNotes", () => {
  test("snaps positions to grid (full strength)", () => {
    const project = makePatternProject([
      { position: 5, length: 96 },
      { position: 100, length: 96 },
      { position: 191, length: 96 },
    ]);
    const mutated = quantizePatternNotes(project, 1, 96, 1.0);
    expect(notesIn(mutated, 1).map((n) => n.position).sort((a, b) => a - b)).toEqual([0, 96, 192]);
  });

  test("strength=0.5 moves halfway to grid", () => {
    const project = makePatternProject([{ position: 20, length: 96 }]);
    const mutated = quantizePatternNotes(project, 1, 96, 0.5);
    expect(notesIn(mutated, 1)[0]!.position).toBe(10); // halfway from 20 to 0
  });

  test("auto-grows pattern length when notes extend past current", () => {
    const project = setPatternLength(
      makePatternProject([{ position: 0, length: 384 }]),
      1,
      384,
    );
    const mutated = quantizePatternNotes(project, 1, 192, 1.0);
    // note at 0 stays; length 384 → end tick 384 → fits exactly. add a
    // second case where we move a note past the boundary.
    const project2 = setPatternLength(
      makePatternProject([{ position: 350, length: 96 }]),
      1,
      384,
    );
    const mutated2 = quantizePatternNotes(project2, 1, 96, 1.0);
    // position snaps to 384 (nearest 96 mult); length 96; end tick = 480.
    // pattern length should auto-grow to 480 (rounded up to next beat = 480 = 5*96).
    const len2 = reparse(mutated2).patterns.find((p) => p.id === 1)?.length ?? 0;
    expect(len2).toBeGreaterThanOrEqual(480);
    void mutated;
  });

  test("rejects invalid grid or strength", () => {
    expect(() => quantizePatternNotes(loadProject(FIXTURE), 1, 0)).toThrow(MutationError);
    expect(() => quantizePatternNotes(loadProject(FIXTURE), 1, 96, -0.1)).toThrow(MutationError);
    expect(() => quantizePatternNotes(loadProject(FIXTURE), 1, 96, 1.1)).toThrow(MutationError);
  });
});

describe("humanizeVelocities", () => {
  test("range=0 is a no-op", () => {
    const project = makePatternProject([{ velocity: 100 }, { velocity: 80 }]);
    const mutated = humanizeVelocities(project, 1, 0);
    expect(notesIn(mutated, 1).map((n) => n.velocity)).toEqual([100, 80]);
  });

  test("deterministic with seed; values stay in [1, 127]", () => {
    const project = makePatternProject(
      Array.from({ length: 20 }, () => ({ velocity: 100 })),
    );
    const a = humanizeVelocities(project, 1, 30, 42);
    const b = humanizeVelocities(project, 1, 30, 42);
    const va = notesIn(a, 1).map((n) => n.velocity);
    const vb = notesIn(b, 1).map((n) => n.velocity);
    expect(va).toEqual(vb);
    for (const v of va) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(127);
    }
    // At least some notes should be different from baseline (seeded RNG).
    const changes = va.filter((v) => v !== 100).length;
    expect(changes).toBeGreaterThan(10);
  });

  test("rejects negative range", () => {
    expect(() => humanizeVelocities(loadProject(FIXTURE), 1, -1)).toThrow(MutationError);
  });
});

describe("humanizeTimings", () => {
  test("deterministic with seed; positions clamp to >= 0", () => {
    const project = makePatternProject([
      { position: 5, length: 96 },
      { position: 200, length: 96 },
    ]);
    const a = humanizeTimings(project, 1, 20, 7);
    const b = humanizeTimings(project, 1, 20, 7);
    expect(notesIn(a, 1).map((n) => n.position)).toEqual(notesIn(b, 1).map((n) => n.position));
    for (const n of notesIn(a, 1)) expect(n.position).toBeGreaterThanOrEqual(0);
  });

  test("auto-grows pattern length if a note shifts past current", () => {
    const project = setPatternLength(
      makePatternProject([{ position: 380, length: 96 }]),
      1,
      384,
    );
    // Force a positive jitter via a seed that pushes the note further right.
    // Sweep a few seeds until we find one that grows the pattern.
    for (let s = 1; s < 100; s++) {
      const mutated = humanizeTimings(project, 1, 50, s);
      const len = reparse(mutated).patterns.find((p) => p.id === 1)?.length ?? 0;
      const notes = notesIn(mutated, 1);
      const endTick = notes[0]!.position + notes[0]!.length;
      if (endTick > 384) {
        expect(len).toBeGreaterThanOrEqual(endTick);
        return;
      }
    }
    throw new Error("no seed pushed the note past pattern length");
  });
});

describe("reversePatternNotes", () => {
  test("mirrors positions about pattern length", () => {
    const project = setPatternLength(
      makePatternProject([
        { position: 0, length: 96 },
        { position: 192, length: 96 },
      ]),
      1,
      384,
    );
    const mutated = reversePatternNotes(project, 1);
    const positions = notesIn(mutated, 1).map((n) => n.position).sort((a, b) => a - b);
    // pos=0 len=96   -> 384 - 0 - 96 = 288
    // pos=192 len=96 -> 384 - 192 - 96 = 96
    expect(positions).toEqual([96, 288]);
  });

  test("falls back to notesEndTick when no 0xA4 set", () => {
    const project = makePatternProject([
      { position: 0, length: 96 },
      { position: 96, length: 96 },
    ]);
    // Pattern length defaults to 0 (FL "use project default") — fallback
    // axis = max(position+length) = 192.
    const mutated = reversePatternNotes(project, 1);
    const positions = notesIn(mutated, 1).map((n) => n.position).sort((a, b) => a - b);
    expect(positions).toEqual([0, 96]);
  });

  test("empty pattern is a no-op", () => {
    const project = loadProject(FIXTURE); // base has 1 note, drop it
    const empty = setPatternNotes(project, 1, []);
    const mutated = reversePatternNotes(empty, 1);
    expect(notesIn(mutated, 1)).toHaveLength(0);
  });
});

describe("invertPatternNotes", () => {
  test("mirrors keys about axisKey (default 60)", () => {
    const project = makePatternProject([
      { key: 55 }, // -> 65
      { key: 60 }, // -> 60 (axis)
      { key: 67 }, // -> 53
    ]);
    const mutated = invertPatternNotes(project, 1);
    expect(notesIn(mutated, 1).map((n) => n.key).sort((a, b) => a - b)).toEqual([53, 60, 65]);
  });

  test("custom axis key", () => {
    const project = makePatternProject([{ key: 70 }]);
    const mutated = invertPatternNotes(project, 1, 72);
    expect(notesIn(mutated, 1)[0]!.key).toBe(74); // 2*72 - 70
  });

  test("clamps to [0, 131] at boundaries", () => {
    const project = makePatternProject([{ key: 130 }]);
    const mutated = invertPatternNotes(project, 1, 60);
    // 2*60 - 130 = -10 → clamp to 0
    expect(notesIn(mutated, 1)[0]!.key).toBe(0);
  });

  test("rejects axisKey out of range", () => {
    expect(() => invertPatternNotes(loadProject(FIXTURE), 1, -1)).toThrow(MutationError);
    expect(() => invertPatternNotes(loadProject(FIXTURE), 1, 200)).toThrow(MutationError);
  });
});

// --------------------------------------------------------------------------- //
// F6.2 — Channel volume + pan (0xDB Levels blob)                              //
// --------------------------------------------------------------------------- //

function readChannelLevels(project: FLPProject, iid: number): { vol: number; pan: number } {
  const reparsed = reparse(project);
  const ch = reparsed.channels.find((c) => c.iid === iid);
  if (!ch?.levels) throw new Error(`channel ${iid} has no levels`);
  return { vol: ch.levels.volume, pan: ch.levels.pan };
}

describe("setChannelVolume", () => {
  test("0.5 normalized -> 6400 raw (0.5 * 12800)", () => {
    const project = loadProject(FIXTURE);
    const mutated = setChannelVolume(project, 1, 0.5);
    expect(readChannelLevels(mutated, 1).vol).toBe(6400);
  });

  test("0.0 -> 0; 1.0 -> 12800 (boundaries)", () => {
    const project = loadProject(FIXTURE);
    expect(readChannelLevels(setChannelVolume(project, 1, 0), 1).vol).toBe(0);
    expect(readChannelLevels(setChannelVolume(project, 1, 1), 1).vol).toBe(12800);
  });

  test("preserves pan + other levels fields", () => {
    const project = loadProject(FIXTURE);
    const before = readChannelLevels(project, 1);
    const mutated = setChannelVolume(project, 1, 0.3);
    const after = readChannelLevels(mutated, 1);
    expect(after.pan).toBe(before.pan);
  });

  test("rejects out-of-range value", () => {
    expect(() => setChannelVolume(loadProject(FIXTURE), 1, -0.1)).toThrow(MutationError);
    expect(() => setChannelVolume(loadProject(FIXTURE), 1, 1.5)).toThrow(MutationError);
  });

  test("rejects unknown channel iid", () => {
    expect(() => setChannelVolume(loadProject(FIXTURE), 999, 0.5)).toThrow(MutationError);
  });
});

describe("setChannelPan", () => {
  test("center (0.0) -> 0 raw", () => {
    const project = loadProject(FIXTURE);
    expect(readChannelLevels(setChannelPan(project, 1, 0), 1).pan).toBe(0);
  });

  test("full left (-1.0) -> -6400; full right (+1.0) -> +6400", () => {
    const project = loadProject(FIXTURE);
    expect(readChannelLevels(setChannelPan(project, 1, -1), 1).pan).toBe(-6400);
    expect(readChannelLevels(setChannelPan(project, 1, +1), 1).pan).toBe(6400);
  });

  test("preserves volume", () => {
    const project = loadProject(FIXTURE);
    const before = readChannelLevels(project, 1);
    const mutated = setChannelPan(project, 1, 0.5);
    expect(readChannelLevels(mutated, 1).vol).toBe(before.vol);
  });

  test("rejects out-of-range value", () => {
    expect(() => setChannelPan(loadProject(FIXTURE), 1, -1.1)).toThrow(MutationError);
    expect(() => setChannelPan(loadProject(FIXTURE), 1, 1.1)).toThrow(MutationError);
    expect(() => setChannelPan(loadProject(FIXTURE), 1, NaN)).toThrow(MutationError);
  });
});

// --------------------------------------------------------------------------- //
// F6.5 — arrangeSong (composite over addClip)                                 //
// --------------------------------------------------------------------------- //

describe("arrangeSong", () => {
  test("lays 3 sections sequentially (4 bars each, PPQ=96, 4/4)", () => {
    const project = loadProject(FIXTURE);
    const mutated = arrangeSong(project, 0, [
      { pattern_id: 1, bars: 4 },
      { pattern_id: 1, bars: 4 },
      { pattern_id: 1, bars: 4 },
    ]);
    const reparsed = reparse(mutated);
    const arr = buildArrangements(
      reparsed.events,
      reparsed.channels,
      reparsed.patterns,
      reparsed.metadata,
    )[0]!;
    expect(arr.clips.length).toBeGreaterThanOrEqual(3);
    // Sections at 0, 1536, 3072 (4 bars * 4 beats * 96 ppq = 1536 ticks each).
    const positions = arr.clips
      .filter((c) => c.item_index >= 20480) // PATTERN_BASE filter
      .map((c) => c.position)
      .sort((a, b) => a - b);
    expect(positions).toContain(0);
    expect(positions).toContain(1536);
    expect(positions).toContain(3072);
  });

  test("respects explicit position_ticks override", () => {
    const project = loadProject(FIXTURE);
    const mutated = arrangeSong(project, 0, [
      { pattern_id: 1, bars: 2, position_ticks: 768 },
    ]);
    const reparsed = reparse(mutated);
    const arr = buildArrangements(
      reparsed.events,
      reparsed.channels,
      reparsed.patterns,
      reparsed.metadata,
    )[0]!;
    const positions = arr.clips
      .filter((c) => c.item_index >= 20480)
      .map((c) => c.position);
    expect(positions).toContain(768);
  });

  test("rejects empty structure", () => {
    expect(() => arrangeSong(loadProject(FIXTURE), 0, [])).toThrow(MutationError);
  });

  test("rejects bad section data", () => {
    expect(() =>
      arrangeSong(loadProject(FIXTURE), 0, [{ pattern_id: 0, bars: 4 }]),
    ).toThrow(MutationError);
    expect(() =>
      arrangeSong(loadProject(FIXTURE), 0, [{ pattern_id: 1, bars: 0 }]),
    ).toThrow(MutationError);
  });

  test("custom beats_per_bar (3/4 → 3 beats per bar)", () => {
    const project = loadProject(FIXTURE);
    const mutated = arrangeSong(
      project,
      0,
      [
        { pattern_id: 1, bars: 2 },
        { pattern_id: 1, bars: 2 },
      ],
      { beats_per_bar: 3 },
    );
    const reparsed = reparse(mutated);
    const arr = buildArrangements(
      reparsed.events,
      reparsed.channels,
      reparsed.patterns,
      reparsed.metadata,
    )[0]!;
    // Section 1 at 0; section 2 at 2*3*96 = 576 ticks (not 768).
    const positions = arr.clips
      .filter((c) => c.item_index >= 20480)
      .map((c) => c.position)
      .sort((a, b) => a - b);
    expect(positions).toContain(0);
    expect(positions).toContain(576);
  });
});
