/**
 * Tests for F9.2 — preset splice helpers.
 *
 *   - loadFactoryGeneratorPreset: splice a generator `.fst` into a target
 *     FLP as a new top-level channel.
 *   - loadFactoryEffectPreset: splice an effect `.fst` into a mixer slot.
 *
 * Synthetic-fixture layer covers happy path + invariants without depending
 * on a local FL install. Real-`.fst` integration tests are path-gated and
 * verify the helpers accept the actual factory presets.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { FLPEvent } from "../src/parser/event.ts";
import type { FLPProject } from "../src/parser/flp-project.ts";
import { parseFLPFile } from "../src/parser/flp-project.ts";
import {
  loadFactoryEffectPreset,
  loadFactoryGeneratorPreset,
  MutationError,
} from "../src/mutations/index.ts";
import { FST_CONTAINER_KIND } from "../src/synth/extract-fst.ts";

// --------------------------------------------------------------------------- //
// Synthetic helpers                                                           //
// --------------------------------------------------------------------------- //

function asciiNul(s: string): Uint8Array {
  return new TextEncoder().encode(s + "\0");
}

function blobEvent(opcode: number, payload: Uint8Array): FLPEvent {
  return { kind: "blob", opcode, payload };
}

function syntheticDonor(events: FLPEvent[]): FLPProject {
  return {
    header: { format: FST_CONTAINER_KIND, n_channels: 6, ppq: 96 },
    events,
    metadata: {} as never,
    channels: [],
    inserts: [],
    patterns: [],
    arrangements: [],
    insertRouting: [],
  };
}

// Minimum-viable parsed .fst donor: 0xC9 internal name + 52-byte 0xD4 +
// small 0xD5 state. Mirrors the Fruity DX10 Steel Guitar shape.
function syntheticGeneratorDonor(internalName = "Fruity DX10"): FLPProject {
  return syntheticDonor([
    blobEvent(0xc7, asciiNul("3.3.2")), // FL-version banner; extractor drops
    blobEvent(0xc9, asciiNul(internalName)),
    blobEvent(0xd4, new Uint8Array(52)),
    blobEvent(0xd5, new Uint8Array(92)),
  ]);
}

// --------------------------------------------------------------------------- //
// loadFactoryGeneratorPreset — synthetic                                      //
// --------------------------------------------------------------------------- //

const BASE_EMPTY_PATH = resolve(import.meta.dir, "./corpus/re_base/fl25/base_empty.flp");

function readBaseEmpty(): FLPProject {
  const buf = readFileSync(BASE_EMPTY_PATH);
  return parseFLPFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

describe("loadFactoryGeneratorPreset — synthetic donor", () => {
  test("adds a new channel with the next iid", () => {
    const base = readBaseEmpty();
    const donor = syntheticGeneratorDonor();
    const channelIidsBefore = base.events
      .filter((e) => e.kind === "u16" && e.opcode === 0x40)
      .map((e) => (e.kind === "u16" ? e.value : -1));
    const { project, iid } = loadFactoryGeneratorPreset(base, donor);
    expect(iid).toBe(Math.max(...channelIidsBefore) + 1);
    const channelIidsAfter = project.events
      .filter((e) => e.kind === "u16" && e.opcode === 0x40)
      .map((e) => (e.kind === "u16" ? e.value : -1));
    expect(channelIidsAfter.length).toBe(channelIidsBefore.length + 1);
    expect(channelIidsAfter).toContain(iid);
  });

  test("strips the donor's 0xC7 FL-version banner from the splice", () => {
    const base = readBaseEmpty();
    const donor = syntheticGeneratorDonor();
    const before = base.events.filter((e) => e.opcode === 0xc7).length;
    const { project } = loadFactoryGeneratorPreset(base, donor);
    const after = project.events.filter((e) => e.opcode === 0xc7).length;
    // The base FLP carries its own 0xC7 project-FL-version event; the
    // splice MUST NOT add the donor's banner on top of it.
    expect(after).toBe(before);
  });

  test("injects 0x15 instrument kind when donor lacks one", () => {
    const base = readBaseEmpty();
    const donor = syntheticGeneratorDonor();
    const { project, iid } = loadFactoryGeneratorPreset(base, donor);
    const openIdx = project.events.findIndex(
      (e) => e.kind === "u16" && e.opcode === 0x40 && e.value === iid,
    );
    // Look in the new channel's scope (up to next 0x40 or end).
    let endIdx = project.events.length;
    for (let i = openIdx + 1; i < project.events.length; i++) {
      const ev = project.events[i]!;
      if (ev.kind === "u16" && ev.opcode === 0x40) {
        endIdx = i;
        break;
      }
    }
    const scope = project.events.slice(openIdx + 1, endIdx);
    const kindByte = scope.find((e) => e.kind === "u8" && e.opcode === 0x15);
    expect(kindByte).toBeDefined();
    expect(kindByte && kindByte.kind === "u8" && kindByte.value).toBe(1);
  });

  test("injects 0xCB channel-name with caller-supplied name", () => {
    const base = readBaseEmpty();
    const donor = syntheticGeneratorDonor();
    const { project, iid } = loadFactoryGeneratorPreset(base, donor, { name: "My Lead" });
    const openIdx = project.events.findIndex(
      (e) => e.kind === "u16" && e.opcode === 0x40 && e.value === iid,
    );
    let endIdx = project.events.length;
    for (let i = openIdx + 1; i < project.events.length; i++) {
      const ev = project.events[i]!;
      if (ev.kind === "u16" && ev.opcode === 0x40) {
        endIdx = i;
        break;
      }
    }
    const scope = project.events.slice(openIdx + 1, endIdx);
    const nameEv = scope.find((e) => e.kind === "blob" && e.opcode === 0xcb);
    expect(nameEv).toBeDefined();
    // UTF-16LE decode should round-trip.
    const decoded = new TextDecoder("utf-16le" as "utf-8")
      .decode((nameEv as { payload: Uint8Array }).payload)
      .replace(/\0$/, "");
    expect(decoded).toBe("My Lead");
  });

  test("falls back to plugin internal name when no name supplied + donor has no 0xCB", () => {
    const base = readBaseEmpty();
    const donor = syntheticGeneratorDonor("Sytrus");
    const { project, iid } = loadFactoryGeneratorPreset(base, donor);
    const openIdx = project.events.findIndex(
      (e) => e.kind === "u16" && e.opcode === 0x40 && e.value === iid,
    );
    const nameEv = project.events
      .slice(openIdx + 1, openIdx + 10)
      .find((e) => e.kind === "blob" && e.opcode === 0xcb);
    expect(nameEv).toBeDefined();
    const decoded = new TextDecoder("utf-16le" as "utf-8")
      .decode((nameEv as { payload: Uint8Array }).payload)
      .replace(/\0$/, "");
    expect(decoded).toBe("Sytrus");
  });

  test("patches 0xD4 voice-routing UIDs above existing max", () => {
    const base = readBaseEmpty();
    // First splice — pick a low UID baseline.
    const r1 = loadFactoryGeneratorPreset(base, syntheticGeneratorDonor());
    // Second splice on the result — its UIDs must be strictly larger.
    const r2 = loadFactoryGeneratorPreset(r1.project, syntheticGeneratorDonor());

    function uidsForIid(p: FLPProject, iid: number): { f9: number; f10: number } | null {
      const openIdx = p.events.findIndex(
        (e) => e.kind === "u16" && e.opcode === 0x40 && e.value === iid,
      );
      if (openIdx < 0) return null;
      for (let i = openIdx + 1; i < p.events.length; i++) {
        const ev = p.events[i]!;
        if (ev.kind === "u16" && ev.opcode === 0x40) break;
        if (ev.kind === "blob" && ev.opcode === 0xd4 && ev.payload.byteLength >= 44) {
          const view = new DataView(ev.payload.buffer, ev.payload.byteOffset, ev.payload.byteLength);
          return { f9: view.getUint32(36, true), f10: view.getUint32(40, true) };
        }
      }
      return null;
    }

    const u1 = uidsForIid(r1.project, r1.iid);
    const u2 = uidsForIid(r2.project, r2.iid);
    expect(u1).not.toBeNull();
    expect(u2).not.toBeNull();
    expect(u2!.f9).toBeGreaterThan(u1!.f9);
    expect(u2!.f10).toBeGreaterThan(u1!.f10);
  });

  test("rejects a donor whose container kind is 0x10 (arrangement project)", () => {
    const base = readBaseEmpty();
    const project = readBaseEmpty(); // arrangement-kind donor
    try {
      loadFactoryGeneratorPreset(base, project);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MutationError);
      if (e instanceof MutationError) expect(e.code).toBe("PLUGIN_INSTANTIATE_FAILED");
    }
  });

  test("rejects a donor missing the 0xC9 plugin-internal-name", () => {
    const base = readBaseEmpty();
    const donor = syntheticDonor([
      blobEvent(0xc7, asciiNul("3.3.2")),
      blobEvent(0xd5, new Uint8Array(92)),
    ]);
    try {
      loadFactoryGeneratorPreset(base, donor);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MutationError);
      if (e instanceof MutationError) expect(e.code).toBe("PLUGIN_INSTANTIATE_FAILED");
    }
  });
});

// --------------------------------------------------------------------------- //
// loadFactoryEffectPreset — synthetic                                         //
// --------------------------------------------------------------------------- //

describe("loadFactoryEffectPreset — synthetic donor", () => {
  test("splices into the requested mixer slot + reports fl_ipc_slot_index", () => {
    const base = readBaseEmpty();
    const donor = syntheticGeneratorDonor("Fruity Reeverb 2");
    // base_empty has 18 inserts (master + 17 user). Slot marker 0 of insert 1
    // is always valid because FL emits 0x62 events for every slot.
    const { project, fl_ipc_slot_index } = loadFactoryEffectPreset(base, donor, {
      insert_index: 1,
      slot_marker: 0,
    });
    expect(fl_ipc_slot_index).toBe(1); // slot_marker + 1
    // Donor's 0xC9 + 0xD4 + 0xD5 should now appear in the project's event
    // stream (minus the 0xC7 banner).
    const pluginNames = project.events
      .filter((e) => e.kind === "blob" && e.opcode === 0xc9 && e.payload.byteLength > 0)
      .map((e) => new TextDecoder("latin1" as "utf-8").decode((e as { payload: Uint8Array }).payload).replace(/\0$/, ""));
    expect(pluginNames).toContain("Fruity Reeverb 2");
  });

  test("rejects nonexistent (insert, slot_marker) target", () => {
    const base = readBaseEmpty();
    const donor = syntheticGeneratorDonor("Fruity Reeverb 2");
    try {
      loadFactoryEffectPreset(base, donor, { insert_index: 999, slot_marker: 0 });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MutationError);
      if (e instanceof MutationError) expect(e.code).toBe("PLUGIN_INSTANTIATE_FAILED");
    }
  });

  test("rejects donor with wrong container kind", () => {
    const base = readBaseEmpty();
    const wrongDonor: FLPProject = {
      ...syntheticGeneratorDonor("Fruity Reeverb 2"),
      header: { format: 0x0010, n_channels: 6, ppq: 96 },
    };
    try {
      loadFactoryEffectPreset(base, wrongDonor, { insert_index: 1, slot_marker: 0 });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MutationError);
      if (e instanceof MutationError) expect(e.code).toBe("PLUGIN_INSTANTIATE_FAILED");
    }
  });
});

// --------------------------------------------------------------------------- //
// Real factory .fst integration (path-gated)                                  //
// --------------------------------------------------------------------------- //

const FL_PRESETS_ROOT =
  "/Applications/FL Studio 2025.app/Contents/Resources/FL/Data/Patches/Plugin presets";
const FL_AVAILABLE = existsSync(FL_PRESETS_ROOT);

function readFst(path: string): FLPProject {
  const buf = readFileSync(path);
  return parseFLPFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

describe.if(FL_AVAILABLE)("loadFactoryGeneratorPreset — real factory presets", () => {
  test("Fruity DX10 / Steel Guitar splices into base_empty", () => {
    const base = readBaseEmpty();
    const fstPath = join(FL_PRESETS_ROOT, "Generators", "Fruity DX10", "Steel Guitar.fst");
    if (!existsSync(fstPath)) return;
    const donor = readFst(fstPath);
    const { project, iid } = loadFactoryGeneratorPreset(base, donor);
    expect(iid).toBeGreaterThanOrEqual(0);
    // Verify the new channel's scope includes a 0xC9 with "Fruity DX10".
    const openIdx = project.events.findIndex(
      (e) => e.kind === "u16" && e.opcode === 0x40 && e.value === iid,
    );
    const scope = project.events.slice(openIdx + 1, openIdx + 30);
    const c9 = scope.find((e) => e.kind === "blob" && e.opcode === 0xc9);
    expect(c9).toBeDefined();
    const name = new TextDecoder("latin1" as "utf-8")
      .decode((c9 as { payload: Uint8Array }).payload)
      .replace(/\0$/, "");
    expect(name).toBe("Fruity DX10");
  });
});

describe.if(FL_AVAILABLE)("loadFactoryEffectPreset — real factory presets", () => {
  test("Fruity Reeverb 2 / Cathedral splices into mixer slot 1.0", () => {
    const base = readBaseEmpty();
    const fstPath = join(FL_PRESETS_ROOT, "Effects", "Fruity Reeverb 2", "Cathedral.fst");
    if (!existsSync(fstPath)) return;
    const donor = readFst(fstPath);
    const { project, fl_ipc_slot_index } = loadFactoryEffectPreset(base, donor, {
      insert_index: 1,
      slot_marker: 0,
    });
    expect(fl_ipc_slot_index).toBe(1);
    const pluginNames = project.events
      .filter((e) => e.kind === "blob" && e.opcode === 0xc9 && e.payload.byteLength > 0)
      .map((e) =>
        new TextDecoder("latin1" as "utf-8")
          .decode((e as { payload: Uint8Array }).payload)
          .replace(/\0$/, ""),
      );
    expect(pluginNames).toContain("Fruity Reeverb 2");
  });
});
