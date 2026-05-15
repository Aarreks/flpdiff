import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import {
  parseFLPFile,
  formatArrangementSummary,
  decodeClips,
  decodeTimeMarkerPosition,
  decodeTrackData,
  type Arrangement,
} from "../src/index.ts";
import { setTrackGrouped, setTrackName } from "../src/mutations/index.ts";
import { serializeFLPProject } from "../src/parser/flp-write.ts";

const CORPUS_DIR = resolve(import.meta.dir, "./corpus/re_base/fl25");

async function arrangementsOf(name: string): Promise<Arrangement[]> {
  const buf = await Bun.file(resolve(CORPUS_DIR, name)).arrayBuffer();
  return parseFLPFile(buf).arrangements;
}

const ALL_FIXTURES = [
  "base_empty.flp",
  "base_one_channel.flp",
  "base_one_insert.flp",
  "base_one_pattern.flp",
  "base_one_serum.flp",
];

/**
 * Oracle values from Python's `flp-info`: every FL 25 base fixture
 * reports "Arrangements: 1 (500 tracks, 0 clips)". The default
 * arrangement is named "Arrangement" and carries 500 track slots
 * even though only a handful might carry clips.
 */
describe("Arrangement extraction — oracle parity", () => {
  test.each(ALL_FIXTURES)("%s: 1 arrangement, 500 tracks, name='Arrangement'", async (name) => {
    const arrangements = await arrangementsOf(name);
    expect(arrangements.length).toBe(1);
    expect(arrangements[0]!.id).toBe(0);
    expect(arrangements[0]!.name).toBe("Arrangement");
    expect(arrangements[0]!.tracks.length).toBe(500);
  });
});

describe("formatArrangementSummary", () => {
  const fakeTracks = (n: number) => Array.from({ length: n }, (_, i) => ({ index: i }));
  test("1 arrangement with 500 tracks", () => {
    const arr: Arrangement[] = [{ id: 0, name: "Main", tracks: fakeTracks(500), clips: [], timemarkers: [] }];
    expect(formatArrangementSummary(arr)).toBe("1 arrangement (500 tracks)");
  });

  test("2 arrangements each with 500 tracks", () => {
    const arr: Arrangement[] = [
      { id: 0, tracks: fakeTracks(500), clips: [], timemarkers: [] },
      { id: 1, tracks: fakeTracks(500), clips: [], timemarkers: [] },
    ];
    expect(formatArrangementSummary(arr)).toBe("2 arrangements (500 + 500 tracks)");
  });

  test("empty list", () => {
    expect(formatArrangementSummary([])).toBe("0 arrangements");
  });
});

describe("Clip decoding — no fixture yet has 0xE9, so all five report empty clips[]", () => {
  test.each(ALL_FIXTURES)("%s: arrangement[0].clips is an empty array", async (name) => {
    const [arrangement] = await insertsOfViaArr(name);
    expect(arrangement).toBeDefined();
    expect(arrangement!.clips).toEqual([]);
  });

  async function insertsOfViaArr(name: string): Promise<Arrangement[]> {
    const buf = await Bun.file(resolve(CORPUS_DIR, name)).arrayBuffer();
    return parseFLPFile(buf).arrangements;
  }
});

describe("TimeMarkers — no fixture emits any, so all arrangements report []", () => {
  test.each(ALL_FIXTURES)("%s: arrangement[0].timemarkers is []", async (name) => {
    const buf = await Bun.file(resolve(CORPUS_DIR, name)).arrayBuffer();
    const arrangement = parseFLPFile(buf).arrangements[0]!;
    expect(arrangement.timemarkers).toEqual([]);
  });
});

describe("decodeTimeMarkerPosition — SIGNATURE_BIT split", () => {
  test("plain marker (no high bit)", () => {
    expect(decodeTimeMarkerPosition(96)).toEqual({ kind: "marker", position: 96 });
  });
  test("signature marker (0x08000000 set)", () => {
    expect(decodeTimeMarkerPosition(0x08000000 | 192)).toEqual({
      kind: "signature",
      position: 192,
    });
  });
  test("zero raw = plain marker at position 0", () => {
    expect(decodeTimeMarkerPosition(0)).toEqual({ kind: "marker", position: 0 });
  });
});

describe("decodeClips — binary-format unit tests (crafted payloads)", () => {
  test("empty payload yields empty array", () => {
    expect(decodeClips(new Uint8Array(0))).toEqual([]);
  });

  test("payload size not a multiple of 80 or 32 → empty array", () => {
    expect(decodeClips(new Uint8Array(37))).toEqual([]);
    expect(decodeClips(new Uint8Array(79))).toEqual([]);
  });

  test("80-byte record (FL 21+/25) decodes all core fields", () => {
    const buf = new Uint8Array(80);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 96, true); // position = 96 ticks
    view.setUint16(4, 20480, true); // pattern_base (ignored)
    view.setUint16(6, 3, true); // item_index
    view.setUint32(8, 192, true); // length = 192 ticks
    view.setUint16(12, 499, true); // track_rvidx (= track 0 in display order)
    view.setUint16(14, 7, true); // group
    view.setUint16(18, 64, true); // item_flags
    view.setFloat32(24, 0.25, true); // start_offset
    view.setFloat32(28, 1.75, true); // end_offset

    const clips = decodeClips(buf);
    expect(clips.length).toBe(1);
    expect(clips[0]).toEqual({
      position: 96,
      item_index: 3,
      length: 192,
      track_rvidx: 499,
      group: 7,
      item_flags: 64,
      start_offset: 0.25,
      end_offset: 1.75,
    });
  });

  test("two 80-byte records decode in order", () => {
    const buf = new Uint8Array(160);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0, true);
    view.setUint32(80, 480, true);
    const clips = decodeClips(buf);
    expect(clips.length).toBe(2);
    expect(clips[0]!.position).toBe(0);
    expect(clips[1]!.position).toBe(480);
  });
});

// --------------------------------------------------------------------------- //
// Track grouping (parent/child) — regression for the FL collapsible
// track hierarchy that was previously invisible to the parser.
// --------------------------------------------------------------------------- //

describe("decodeTrackData — grouped flag (byte 46)", () => {
  function makeTrackBlob(opts: {
    iid?: number;
    color?: number;
    grouped?: boolean;
    locked?: boolean;
  }): Uint8Array {
    // 70-byte FL 25 layout. Only the fields we care about are set;
    // everything else stays zero.
    const buf = new Uint8Array(70);
    const view = new DataView(buf.buffer);
    if (opts.iid !== undefined) view.setUint32(0, opts.iid, true);
    if (opts.color !== undefined) view.setUint32(4, opts.color, true);
    if (opts.grouped !== undefined) view.setUint8(46, opts.grouped ? 1 : 0);
    if (opts.locked !== undefined) view.setUint8(47, opts.locked ? 1 : 0);
    return buf;
  }

  test("byte 46 = 0 → grouped: false", () => {
    const blob = makeTrackBlob({ iid: 42, grouped: false });
    const t = decodeTrackData(blob, 5);
    expect(t.index).toBe(5);
    expect(t.iid).toBe(42);
    expect(t.grouped).toBe(false);
  });

  test("byte 46 = 1 → grouped: true", () => {
    const blob = makeTrackBlob({ iid: 7, grouped: true });
    const t = decodeTrackData(blob, 9);
    expect(t.grouped).toBe(true);
  });

  test("grouped is independent of locked (byte 46 vs 47)", () => {
    expect(decodeTrackData(makeTrackBlob({ grouped: true, locked: false }), 0).grouped).toBe(true);
    expect(decodeTrackData(makeTrackBlob({ grouped: true, locked: false }), 0).locked).toBe(false);
    expect(decodeTrackData(makeTrackBlob({ grouped: false, locked: true }), 0).grouped).toBe(false);
    expect(decodeTrackData(makeTrackBlob({ grouped: false, locked: true }), 0).locked).toBe(true);
  });

  test("payload shorter than 47 bytes → grouped undefined (don't read past end)", () => {
    const short = new Uint8Array(40);
    const t = decodeTrackData(short, 0);
    expect(t.grouped).toBeUndefined();
  });

  test("default 70-byte all-zero blob → grouped: false (FL emits this on every untouched track)", () => {
    const t = decodeTrackData(new Uint8Array(70), 0);
    expect(t.grouped).toBe(false);
  });
});

describe("setTrackGrouped — round-trip preserves all other track-data bytes", () => {
  const FIX = resolve(CORPUS_DIR, "base_one_pattern.flp");

  async function loadProject() {
    const buf = await Bun.file(FIX).arrayBuffer();
    return parseFLPFile(buf);
  }

  function reparse(project: ReturnType<typeof parseFLPFile>) {
    const bytes = serializeFLPProject(project);
    return parseFLPFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }

  test("setTrackGrouped → serialize → parse → grouped survives", async () => {
    const project = await loadProject();
    const m = setTrackGrouped(project, 0, 3, true);
    const re = reparse(m);
    expect(re.arrangements[0]?.tracks[3]?.grouped).toBe(true);
    // All other tracks unchanged.
    expect(re.arrangements[0]?.tracks[2]?.grouped === true).toBe(false);
    expect(re.arrangements[0]?.tracks[4]?.grouped === true).toBe(false);
  });

  test("setTrackGrouped only touches byte 46 of the target track's blob", async () => {
    const project = await loadProject();
    const TRACK_IDX = 5;
    const before = project.arrangements[0]!.tracks[TRACK_IDX]!;
    // mutate + reparse — the project's cached arrangements aren't
    // re-derived after a mutation, so we round-trip through the
    // serializer to see the post-mutation track.
    const after = reparse(setTrackGrouped(project, 0, TRACK_IDX, true))
      .arrangements[0]!.tracks[TRACK_IDX]!;
    expect(after.iid).toBe(before.iid);
    expect(after.color).toEqual(before.color);
    expect(after.icon).toBe(before.icon);
    expect(after.enabled).toBe(before.enabled);
    expect(after.height).toBe(before.height);
    expect(after.locked).toBe(before.locked);
    expect(after.grouped).toBe(true);
  });

  test("idempotent: set true twice → still true; set false → ungrouped", async () => {
    let p = await loadProject();
    p = setTrackGrouped(p, 0, 1, true);
    p = setTrackGrouped(p, 0, 1, true);
    expect(reparse(p).arrangements[0]?.tracks[1]?.grouped).toBe(true);
    p = setTrackGrouped(p, 0, 1, false);
    expect(reparse(p).arrangements[0]?.tracks[1]?.grouped === true).toBe(false);
  });

  test("parent inference: child rows resolve to nearest ungrouped parent above", async () => {
    // Build PARENT(0) / child-1(1, grouped) / child-2(2, grouped) /
    // PARENT(3) / child(4, grouped). Verify the bridge's parent_index
    // logic walking up from a grouped track lands on the right ungrouped
    // ancestor.
    let p = await loadProject();
    p = setTrackName(p, 0, 0, "PARENT-A");
    p = setTrackName(p, 0, 1, "child-1");
    p = setTrackGrouped(p, 0, 1, true);
    p = setTrackName(p, 0, 2, "child-2");
    p = setTrackGrouped(p, 0, 2, true);
    p = setTrackName(p, 0, 3, "PARENT-B");
    p = setTrackName(p, 0, 4, "child-of-B");
    p = setTrackGrouped(p, 0, 4, true);
    const re = reparse(p);
    const t = re.arrangements[0]!.tracks;

    // Replicate the bridge's parent-walk.
    function parentIndex(idx: number): number {
      for (let i = idx; i >= 0; i--) {
        if (i === 0 || t[i]?.grouped !== true) return i;
      }
      return 0;
    }

    expect(parentIndex(0)).toBe(0); // own parent
    expect(parentIndex(1)).toBe(0); // child of PARENT-A
    expect(parentIndex(2)).toBe(0); // also child of PARENT-A (consecutive grouped)
    expect(parentIndex(3)).toBe(3); // own parent (ungrouped)
    expect(parentIndex(4)).toBe(3); // child of PARENT-B
  });
});
