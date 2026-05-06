import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import { parseFLPFile } from "../src/index.ts";
import { serializeFLPProject } from "../src/parser/flp-write.ts";
import {
  FAMILY_ORDER,
  GROUPS,
  classifyByPitchRange,
  classifyChannel,
  planReorganize,
  reorganizeProject,
} from "../src/reorganize/index.ts";

const CORPUS_DIR = resolve(import.meta.dir, "./corpus/re_base/fl25");

async function loadProject(name: string) {
  const buf = await Bun.file(resolve(CORPUS_DIR, name)).arrayBuffer();
  return parseFLPFile(buf);
}

function reparse(project: ReturnType<typeof parseFLPFile>) {
  const bytes = serializeFLPProject(project);
  return parseFLPFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

// --------------------------------------------------------------------------- //
// classifyChannel — same shape, kept since algo still uses it                 //
// --------------------------------------------------------------------------- //

describe("classifyChannel — keyword regex", () => {
  test("matches 'Kick' anywhere in name", () => {
    expect(classifyChannel("808 Kick", undefined)?.key).toBe("drums_hard");
    expect(classifyChannel("Kick Drum 01", undefined)?.key).toBe("drums_hard");
  });

  test("matches sample path even when name is generic", () => {
    expect(
      classifyChannel("Sampler", "/Library/Samples/909/Snare 01.wav")?.key,
    ).toBe("drums_hard");
  });

  test("hat → drums_soft + camelCase aware", () => {
    expect(classifyChannel("HiHat", undefined)?.key).toBe("drums_soft");
    expect(classifyChannel("Hatchet", undefined)).toBe(null);
  });

  test("'Lead Vox' → vocal (vocal precedes lead)", () => {
    expect(classifyChannel("Lead Vox", undefined)?.key).toBe("vocal");
  });

  test("returns null on truly unknown content", () => {
    expect(classifyChannel("Xqzfoo Plugin 17", undefined)).toBe(null);
  });
});

describe("classifyByPitchRange — MIDI pitch fallback", () => {
  function note(key: number) {
    return {
      position: 0,
      flags: 0,
      slide: false,
      channel_iid: 1,
      length: 96,
      key,
      group: 0,
      fine_pitch: 120,
      release: 64,
      midi_channel: 0,
      pan: 64,
      velocity: 100,
      mod_x: 128,
      mod_y: 128,
    };
  }

  test("avg < 48 → bass; bass_sketch Serum case (avg 44)", () => {
    expect(classifyByPitchRange([note(36), note(40), note(44)])?.key).toBe("bass");
    expect(classifyByPitchRange([note(44)])?.key).toBe("bass");
  });

  test("avg >= 48 → lead (any melodic range; pad is name-keyword only)", () => {
    expect(classifyByPitchRange([note(60), note(67)])?.key).toBe("lead");
    expect(classifyByPitchRange([note(72), note(80)])?.key).toBe("lead");
    expect(classifyByPitchRange([note(93), note(95)])?.key).toBe("lead"); // A6+ — was wrongly "pad"
  });

  test("empty → null", () => {
    expect(classifyByPitchRange([])).toBe(null);
  });
});

// --------------------------------------------------------------------------- //
// planReorganize — playlist-only behavior                                     //
// --------------------------------------------------------------------------- //

describe("planReorganize — empty/clipless project", () => {
  test("base_one_pattern.flp (no playlist clips) yields empty layout", async () => {
    // base_one_pattern has channels + a pattern but no clips on the playlist.
    // No clips → no lanes → no track mutations.
    const p = await loadProject("base_one_pattern.flp");
    const plan = planReorganize(p);
    expect(plan.tracks).toEqual([]);
    expect(plan.clipMoves).toEqual([]);
  });

  test("base_empty.flp (no channels at all) yields empty layout", async () => {
    const p = await loadProject("base_empty.flp");
    const plan = planReorganize(p);
    expect(plan.tracks).toEqual([]);
    expect(plan.clipMoves).toEqual([]);
  });
});

// --------------------------------------------------------------------------- //
// reorganizeProject — channels/inserts/patterns must stay byte-identical     //
// --------------------------------------------------------------------------- //

describe("reorganizeProject — never touches channels/inserts/patterns", () => {
  const FIXTURES = [
    "base_empty.flp",
    "base_one_channel.flp",
    "base_one_pattern.flp",
    "base_one_serum.flp",
    "base_one_insert.flp",
  ];

  test.each(FIXTURES)("%s: channel state byte-identical before/after", async (name) => {
    const p = await loadProject(name);
    const { project: mutated } = reorganizeProject(p);
    const re = reparse(mutated);

    // Every channel field that flpdiff surfaces must match.
    expect(re.channels.length).toBe(p.channels.length);
    for (let i = 0; i < p.channels.length; i++) {
      const before = p.channels[i]!;
      const after = re.channels[i]!;
      expect(after.iid).toBe(before.iid);
      expect(after.name).toBe(before.name);
      expect(after.kind).toBe(before.kind);
      expect(after.color).toEqual(before.color);
      expect(after.targetInsert).toBe(before.targetInsert);
      expect(after.sample_path).toBe(before.sample_path);
    }
  });

  test.each(FIXTURES)("%s: pattern state byte-identical before/after", async (name) => {
    const p = await loadProject(name);
    const { project: mutated } = reorganizeProject(p);
    const re = reparse(mutated);

    expect(re.patterns.length).toBe(p.patterns.length);
    for (let i = 0; i < p.patterns.length; i++) {
      const before = p.patterns[i]!;
      const after = re.patterns[i]!;
      expect(after.id).toBe(before.id);
      expect(after.name).toBe(before.name);
      expect(after.color).toEqual(before.color);
      expect(after.notes.length).toBe(before.notes.length);
    }
  });

  test.each(FIXTURES)("%s: clip count preserved", async (name) => {
    const p = await loadProject(name);
    const { project: mutated } = reorganizeProject(p);
    const re = reparse(mutated);

    const beforeClips = p.arrangements.reduce((acc, a) => acc + a.clips.length, 0);
    const afterClips = re.arrangements.reduce((acc, a) => acc + a.clips.length, 0);
    expect(afterClips).toBe(beforeClips);
  });
});

// --------------------------------------------------------------------------- //
// FAMILY_ORDER — sanity                                                       //
// --------------------------------------------------------------------------- //

describe("FAMILY_ORDER — fixed family sequence", () => {
  test("drums first, vocal before other; covers every GroupKey", () => {
    expect(FAMILY_ORDER[0]).toBe("drums_hard");
    expect(FAMILY_ORDER[1]).toBe("drums_soft");
    expect(FAMILY_ORDER.indexOf("vocal")).toBeLessThan(FAMILY_ORDER.indexOf("other"));
    // Every group from GROUPS plus 'other' is in FAMILY_ORDER.
    const groupKeys = new Set(Object.values(GROUPS).map((g) => g.key));
    groupKeys.add("other");
    for (const k of groupKeys) {
      expect(FAMILY_ORDER).toContain(k);
    }
  });
});
