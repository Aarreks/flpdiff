import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import { parseFLPFile } from "../src/index.ts";
import { serializeFLPProject } from "../src/parser/flp-write.ts";
import {
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
// classifyChannel                                                              //
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

  test("hat → drums_soft (separate from kick/snare)", () => {
    expect(classifyChannel("HiHat", undefined)?.key).toBe("drums_soft");
    // word-boundary matching: 'Hatchet' should NOT match 'hat' (no word boundary inside)
    expect(classifyChannel("Hatchet", undefined)).toBe(null);
  });

  test("'808' classifies as bass", () => {
    // "808 Sub" matches "sub" first (more specific name → "Sub Bass").
    // Both group keys are 'bass', which is what matters.
    expect(classifyChannel("808 Sub", undefined)?.key).toBe("bass");
    expect(classifyChannel("808", undefined)?.key).toBe("bass");
    expect(classifyChannel("808", undefined)?.name).toBe("808");
  });

  test("vocal keywords map to vocal", () => {
    expect(classifyChannel("Lead Vox", undefined)?.key).toBe("vocal");
    expect(classifyChannel("Backing Vocal", undefined)?.key).toBe("vocal");
  });

  test("returns null on truly unknown content", () => {
    expect(classifyChannel("Xqzfoo Plugin 17", undefined)).toBe(null);
    expect(classifyChannel(undefined, undefined)).toBe(null);
    expect(classifyChannel("", "")).toBe(null);
  });
});

// --------------------------------------------------------------------------- //
// classifyByPitchRange                                                         //
// --------------------------------------------------------------------------- //

describe("classifyByPitchRange — MIDI pitch fallback", () => {
  function makeNote(key: number) {
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

  test("avg < 48 → bass", () => {
    expect(classifyByPitchRange([makeNote(36), makeNote(40), makeNote(44)])?.key).toBe("bass");
  });

  test("48 <= avg < 72 → lead", () => {
    expect(classifyByPitchRange([makeNote(60), makeNote(64), makeNote(67)])?.key).toBe("lead");
  });

  test("avg >= 72 → pad", () => {
    expect(classifyByPitchRange([makeNote(72), makeNote(80), makeNote(88)])?.key).toBe("pad");
  });

  test("empty notes → null", () => {
    expect(classifyByPitchRange([])).toBe(null);
  });

  test("matches the bass_sketch Serum case (avg key 44)", () => {
    // Single note at key 44 (G2) — the classic bass fundamental on
    // bass_sketch.flp's Serum channel. Should bucket as bass.
    expect(classifyByPitchRange([makeNote(44)])?.key).toBe("bass");
  });
});

// --------------------------------------------------------------------------- //
// planReorganize                                                               //
// --------------------------------------------------------------------------- //

describe("planReorganize — base_one_pattern.flp", () => {
  test("plans a channel mutation per enabled channel", async () => {
    const p = await loadProject("base_one_pattern.flp");
    const plan = planReorganize(p);
    const enabledCount = p.channels.filter((c) => c.enabled !== false).length;
    expect(plan.channels.length).toBe(enabledCount);
    expect(plan.inserts.length).toBe(enabledCount);
    // Sequential inserts 1..N — no zero, no gaps.
    expect(plan.channels.map((c) => c.target_insert)).toEqual(
      Array.from({ length: enabledCount }, (_, i) => i + 1),
    );
  });

  test("classifies the 909 Kick sample path correctly", async () => {
    const p = await loadProject("base_one_pattern.flp");
    const plan = planReorganize(p);
    // base_one_pattern's lone channel has sample_path containing
    // "909 Kick.wav" — must classify as drums_hard / Kick.
    const kickMutation = plan.channels.find((c) => /Kick/i.test(c.name));
    expect(kickMutation).toBeDefined();
    expect(kickMutation!.rgb).toEqual(GROUPS["kick"]!.rgb);
  });

  test("uses palette colors only", async () => {
    const p = await loadProject("base_one_pattern.flp");
    const plan = planReorganize(p);
    const paletteRgbs = new Set(Object.values(GROUPS).map((g) => `${g.rgb.r},${g.rgb.g},${g.rgb.b}`));
    for (const ch of plan.channels) {
      expect(paletteRgbs.has(`${ch.rgb.r},${ch.rgb.g},${ch.rgb.b}`)).toBe(true);
    }
    for (const ins of plan.inserts) {
      expect(paletteRgbs.has(`${ins.rgb.r},${ins.rgb.g},${ins.rgb.b}`)).toBe(true);
    }
  });

  test("preserveExistingNames=true keeps already-semantic channel names", async () => {
    const p = await loadProject("base_one_pattern.flp");
    // base_one_pattern's iid=1 channel name from FL is "Kick". Custom
    // (not in DEFAULT_NAME_RE), so preserveExisting keeps it.
    const plan = planReorganize(p, { preserveExistingNames: true });
    const kickPlan = plan.channels.find((c) => c.iid === 1);
    expect(kickPlan?.name).toBe("Kick");
  });

  test("preserveExistingNames=false canonicalises to group name", async () => {
    const p = await loadProject("base_one_pattern.flp");
    const plan = planReorganize(p, { preserveExistingNames: false });
    const kickPlan = plan.channels.find((c) => c.iid === 1);
    expect(kickPlan?.name).toBe("Kick");
  });
});

// --------------------------------------------------------------------------- //
// reorganizeProject — full round-trip via serializer                           //
// --------------------------------------------------------------------------- //

describe("reorganizeProject — serialize → reparse → invariants hold", () => {
  test("base_one_pattern: enabled channels routed to distinct inserts != Master", async () => {
    const p = await loadProject("base_one_pattern.flp");
    const { project: mutated, mutationsApplied } = reorganizeProject(p, {
      preserveExistingNames: false,
    });
    expect(mutationsApplied).toBeGreaterThan(0);

    const re = reparse(mutated);
    const enabled = re.channels.filter((c) => c.enabled !== false);
    const targets = enabled.map((c) => c.targetInsert);
    // Each enabled channel got a routing.
    for (const t of targets) {
      expect(typeof t).toBe("number");
      expect(t).toBeGreaterThan(0); // not Master (insert 0)
    }
    expect(new Set(targets).size).toBe(targets.length); // distinct
  });

  test("clip count + per-pattern note count preserved", async () => {
    const p = await loadProject("base_one_pattern.flp");
    const beforeNotesByPattern = new Map(p.patterns.map((pp) => [pp.id, pp.notes.length]));
    const beforeClips = p.arrangements.reduce((acc, a) => acc + a.clips.length, 0);

    const { project: mutated } = reorganizeProject(p);
    const re = reparse(mutated);

    const afterNotesByPattern = new Map(re.patterns.map((pp) => [pp.id, pp.notes.length]));
    const afterClips = re.arrangements.reduce((acc, a) => acc + a.clips.length, 0);

    expect(afterNotesByPattern).toEqual(beforeNotesByPattern);
    expect(afterClips).toBe(beforeClips);
  });

  test("colors come from palette (RGB compare; alpha may differ)", async () => {
    const p = await loadProject("base_one_pattern.flp");
    const { project: mutated } = reorganizeProject(p);
    const re = reparse(mutated);

    const paletteRgb = new Set(
      Object.values(GROUPS).map((g) => (g.rgb.r << 16) | (g.rgb.g << 8) | g.rgb.b),
    );
    for (const ch of re.channels) {
      if (ch.color === undefined || ch.enabled === false) continue;
      const rgb = (ch.color.r << 16) | (ch.color.g << 8) | ch.color.b;
      // FL emits a default gray (0x414548) on fresh sampler channels; if
      // the channel had a default the algorithm overrides to a palette
      // color, so any non-zero color here must be palette.
      if (rgb !== 0) {
        expect(paletteRgb.has(rgb)).toBe(true);
      }
    }
  });
});

// --------------------------------------------------------------------------- //
// Round-trip safety on every fl25 fixture                                      //
// --------------------------------------------------------------------------- //

describe("reorganizeProject — corpus round-trip safety", () => {
  const FIXTURES = [
    "base_empty.flp",
    "base_one_channel.flp",
    "base_one_pattern.flp",
    "base_one_serum.flp",
    "base_one_insert.flp",
  ];

  test.each(FIXTURES)("%s reorganizes + reparses without error", async (name) => {
    const p = await loadProject(name);
    const { project: mutated } = reorganizeProject(p);
    // Just exercising the full path — no exception from serializer.
    const re = reparse(mutated);
    expect(re.channels.length).toBe(p.channels.length);
    expect(re.patterns.length).toBe(p.patterns.length);
  });
});
