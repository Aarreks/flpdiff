/**
 * Tests for `extractPluginScopeFromFst` — Phase F9.1.4.
 *
 * Two layers:
 *   1. Synthetic .fst built programmatically — exercises the
 *      container-kind check, banner stripping, and field extraction
 *      without depending on a local FL install.
 *   2. Real factory .fst files at `/Applications/FL Studio 2025.app/...`
 *      — gated on the install path existing; skipped on CI. Verifies
 *      shape against 5 representative plugins (DX10, FL Keys, Sytrus,
 *      Drumaxx, Fruity Reeverb 2).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FLPEvent } from "../src/parser/event.ts";
import type { FLPProject } from "../src/parser/flp-project.ts";
import { parseFLPFile } from "../src/parser/flp-project.ts";
import {
  FST_CONTAINER_KIND,
  FstParseError,
  extractPluginScopeFromFst,
} from "../src/synth/extract-fst.ts";

// --------------------------------------------------------------------------- //
// Synthetic fixtures                                                          //
// --------------------------------------------------------------------------- //

function utf16leNul(s: string): Uint8Array {
  const enc = new TextEncoder();
  // TextEncoder is utf-8-only; build utf-16-le manually.
  const buf = new Uint8Array((s.length + 1) * 2);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    buf[i * 2] = code & 0xff;
    buf[i * 2 + 1] = (code >> 8) & 0xff;
  }
  return buf;
}

function blobEvent(opcode: number, payload: Uint8Array): FLPEvent {
  return { kind: "blob", opcode, payload } satisfies FLPEvent;
}

function syntheticFstProject(
  events: FLPEvent[],
  opts: { format?: number } = {},
): FLPProject {
  return {
    header: { format: opts.format ?? FST_CONTAINER_KIND, n_channels: 6, ppq: 96 },
    events,
    metadata: {} as never,
    channels: [],
    inserts: [],
    patterns: [],
    arrangements: [],
    insertRouting: [],
  };
}

// --------------------------------------------------------------------------- //
// Container-kind validation                                                   //
// --------------------------------------------------------------------------- //

describe("extractPluginScopeFromFst — container validation", () => {
  test("rejects 0x0010 arrangement-project container", () => {
    const proj = syntheticFstProject(
      [blobEvent(0xc9, utf16leNul("Fruity DX10"))],
      { format: 0x0010 },
    );
    expect(() => extractPluginScopeFromFst(proj)).toThrow(FstParseError);
    expect(() => extractPluginScopeFromFst(proj)).toThrow(/container kind/);
  });

  test("rejects unknown container kinds", () => {
    const proj = syntheticFstProject(
      [blobEvent(0xc9, utf16leNul("Fruity DX10"))],
      { format: 0x00ff },
    );
    expect(() => extractPluginScopeFromFst(proj)).toThrow(FstParseError);
  });

  test("accepts 0x0030 channel-preset container", () => {
    const proj = syntheticFstProject([blobEvent(0xc9, utf16leNul("Fruity DX10"))]);
    expect(() => extractPluginScopeFromFst(proj)).not.toThrow();
  });
});

// --------------------------------------------------------------------------- //
// Field extraction                                                            //
// --------------------------------------------------------------------------- //

describe("extractPluginScopeFromFst — field extraction", () => {
  test("strips 0xC7 FL-version banner from scope", () => {
    const proj = syntheticFstProject([
      blobEvent(0xc7, new TextEncoder().encode("3.3.2\0")),
      blobEvent(0xc9, utf16leNul("Fruity DX10")),
      blobEvent(0xd4, new Uint8Array(52)),
      blobEvent(0xd5, new Uint8Array(92)),
    ]);
    const { scope } = extractPluginScopeFromFst(proj);
    // 3 events out of 4 — the 0xC7 was dropped.
    expect(scope.length).toBe(3);
    expect(scope.find((e) => e.opcode === 0xc7)).toBeUndefined();
    expect(scope.map((e) => e.opcode)).toEqual([0xc9, 0xd4, 0xd5]);
  });

  test("preserves event order otherwise", () => {
    const proj = syntheticFstProject([
      blobEvent(0xc9, utf16leNul("Fruity DX10")),
      blobEvent(0xd4, new Uint8Array(52)),
      blobEvent(0xcb, utf16leNul("Steel Guitar")),
      blobEvent(0xd5, new Uint8Array(92)),
    ]);
    const { scope } = extractPluginScopeFromFst(proj);
    expect(scope.map((e) => e.opcode)).toEqual([0xc9, 0xd4, 0xcb, 0xd5]);
  });

  test("reads plugin internal name from 0xC9", () => {
    const proj = syntheticFstProject([blobEvent(0xc9, utf16leNul("Fruity DX10"))]);
    const result = extractPluginScopeFromFst(proj);
    expect(result.pluginInternalName).toBe("Fruity DX10");
  });

  test("reads display name from 0xCB when present", () => {
    const proj = syntheticFstProject([
      blobEvent(0xc9, utf16leNul("Fruity DX10")),
      blobEvent(0xcb, utf16leNul("Steel Guitar")),
    ]);
    const { pluginDisplayName } = extractPluginScopeFromFst(proj);
    expect(pluginDisplayName).toBe("Steel Guitar");
  });

  test("display name absent when no 0xCB in donor", () => {
    const proj = syntheticFstProject([blobEvent(0xc9, utf16leNul("Fruity DX10"))]);
    const { pluginDisplayName } = extractPluginScopeFromFst(proj);
    expect(pluginDisplayName).toBeUndefined();
  });

  test("throws when 0xC9 plugin-internal-name missing", () => {
    const proj = syntheticFstProject([
      blobEvent(0xc7, new TextEncoder().encode("3.3.2\0")),
      blobEvent(0xd5, new Uint8Array(92)),
    ]);
    expect(() => extractPluginScopeFromFst(proj)).toThrow(FstParseError);
    expect(() => extractPluginScopeFromFst(proj)).toThrow(/0xC9/);
  });
});

// --------------------------------------------------------------------------- //
// Real FL factory presets (path-gated)                                        //
// --------------------------------------------------------------------------- //

const FL_PRESETS_ROOT =
  "/Applications/FL Studio 2025.app/Contents/Resources/FL/Data/Patches/Plugin presets";
const FL_PRESETS_AVAILABLE = existsSync(FL_PRESETS_ROOT);

function readFlp(path: string): FLPProject {
  const bytes = readFileSync(path);
  return parseFLPFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function firstFstUnder(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const entries = readdirSync(dir).filter((f) => f.endsWith(".fst"));
  return entries.length > 0 ? join(dir, entries[0]!) : null;
}

describe.if(FL_PRESETS_AVAILABLE)("extractPluginScopeFromFst — real factory presets", () => {
  const targets = [
    { plugin: "Fruity DX10", category: "Generators", expectedInternal: "Fruity DX10" },
    { plugin: "FL Keys", category: "Generators", expectedInternal: "FL Keys" },
    { plugin: "Sytrus", category: "Generators", expectedInternal: "Sytrus" },
    { plugin: "Drumaxx", category: "Generators", expectedInternal: "Drumaxx" },
    { plugin: "Fruity Reeverb 2", category: "Effects", expectedInternal: "Fruity Reeverb 2" },
  ];

  for (const target of targets) {
    test(`${target.plugin} (.fst under ${target.category}/) extracts cleanly`, () => {
      const presetDir = join(FL_PRESETS_ROOT, target.category, target.plugin);
      const fstPath = firstFstUnder(presetDir);
      if (!fstPath) {
        // FL install may have dropped the plugin; skip rather than fail.
        return;
      }
      const project = readFlp(fstPath);
      expect(project.header.format).toBe(FST_CONTAINER_KIND);

      const { scope, pluginInternalName } = extractPluginScopeFromFst(project);
      expect(pluginInternalName).toBe(target.expectedInternal);
      // Every preset must carry at least the (0xC9, 0xD4, 0xD5) trio.
      const opcodes = new Set(scope.map((e) => e.opcode));
      expect(opcodes.has(0xc9)).toBe(true);
      expect(opcodes.has(0xd4)).toBe(true);
      expect(opcodes.has(0xd5)).toBe(true);
      // 0xC7 was stripped.
      expect(opcodes.has(0xc7)).toBe(false);
    });
  }
});
