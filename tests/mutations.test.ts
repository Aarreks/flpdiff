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
  clonePattern,
  addClip,
  removeClip,
  moveClip,
  MutationError,
} from "../src/mutations/index.ts";
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
