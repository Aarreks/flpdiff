import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFLPFile, getTempo } from "../src/parser/flp-project.ts";
import { serializeFLPProject } from "../src/parser/flp-write.ts";
import { setTempo, setPatternName, MutationError } from "../src/mutations/index.ts";

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
