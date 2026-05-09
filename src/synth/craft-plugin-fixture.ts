/**
 * Craft a minimal FLP carrying a single named plugin, suitable as a
 * baseline for `sweep_plugin_layout.py` (Epic 5 / F2.4+).
 *
 * Strategy:
 * 1. Read a baseline FLP — typically `base_empty.flp` (no plugins,
 *    just the FL skeleton — channels=1, mixer=master+17 user inserts,
 *    1 empty arrangement).
 * 2. Read a donor FLP that has the target plugin in any mixer slot
 *    (e.g. `junie.flp` for Fruity Limiter at master slot 7).
 * 3. Locate the donor slot's full event scope (events from its
 *    `0x62` marker through the next `0x62` / `0x93`). FL needs the
 *    entire scope, not just `0xC9` + `0xD5` — the supporting
 *    `0xD4` (52-byte runtime data), `0x9B` u32, `0x80` u32 (color),
 *    `0x29` u8 metadata are all required for FL's runtime API to
 *    BIND the plugin (not just open its UI).
 * 4. Splice that scope into the baseline at the requested target
 *    `(insert, slotMarker)` — meaning "between `0x62 slotMarker`
 *    and the next `0x62`". Note: FL's IPC `getPluginName(insert,
 *    slot)` reports this plugin at `slotMarker + 1`. (Events before
 *    the first `0x62` of an insert appear at FL slot 0; events
 *    between `0x62 N` and `0x62 N+1` appear at FL slot N+1.)
 *
 * Empirically verified: the resulting FLP has FL accept + render the
 * plugin's UI AND bind it via `plugins.getPluginName` /
 * `plugins.setParamValue`, making it a valid input to the auto-sweep
 * RE tool.
 */
import { parseFLPFile } from "../parser/flp-project.ts";
import { serializeFLPProject } from "../parser/flp-write.ts";
import { readFileSync, writeFileSync } from "node:fs";
import type { FLPEvent } from "../parser/event.ts";
import type { FLPProject } from "../parser/flp-project.ts";

function toAB(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function readPath(path: string): FLPProject {
  return parseFLPFile(toAB(readFileSync(path)));
}

const OP_INSERT_FLAGS = 0xec;
const OP_NEW_SLOT = 0x62;
const OP_INSERT_END = 0x93;
const OP_PLUGIN_INTERNAL_NAME = 0xc9;
const OP_PLUGIN_NAME = 0xcb;

function decodeName(payload: Uint8Array): string {
  let end = payload.byteLength;
  while (end >= 2 && payload[end - 1] === 0 && payload[end - 2] === 0) end -= 2;
  return new TextDecoder("utf-16le" as "utf-8").decode(payload.subarray(0, end));
}

/**
 * Extract a single plugin slot's event scope from a donor FLP.
 * Matches by plugin name (checked against the slot's `0xC9` internal
 * name and `0xCB` display name). Returns the full event subarray
 * suitable for splicing into a target file.
 */
export function extractPluginSlotScope(
  donor: FLPProject,
  pluginName: string,
): { scope: FLPEvent[]; donorInsert: number; donorSlot: number } {
  let curInsert = 0;
  let curSlot = -1;
  let inMixer = false;
  let candidateStart = -1;
  let candidateName: string | null = null;

  for (let i = 0; i < donor.events.length; i++) {
    const ev = donor.events[i]!;
    if (ev.opcode === OP_INSERT_FLAGS) {
      inMixer = true;
      continue;
    }
    if (!inMixer) continue;

    if (ev.kind === "u16" && ev.opcode === OP_NEW_SLOT) {
      // Close any pending candidate scope; check if it matched.
      if (candidateStart >= 0) {
        if (candidateName === pluginName) {
          return {
            scope: donor.events.slice(candidateStart, i),
            donorInsert: curInsert,
            donorSlot: curSlot,
          };
        }
      }
      curSlot = ev.value;
      candidateStart = i + 1;
      candidateName = null;
      continue;
    }

    if (ev.opcode === OP_INSERT_END) {
      if (candidateStart >= 0 && candidateName === pluginName) {
        return {
          scope: donor.events.slice(candidateStart, i),
          donorInsert: curInsert,
          donorSlot: curSlot,
        };
      }
      curInsert++;
      curSlot = -1;
      candidateStart = -1;
      candidateName = null;
      continue;
    }

    if (ev.kind === "blob" && ev.opcode === OP_PLUGIN_INTERNAL_NAME) {
      const n = decodeName(ev.payload);
      if (n.length > 0 && candidateName === null) candidateName = n;
    }
    if (ev.kind === "blob" && ev.opcode === OP_PLUGIN_NAME) {
      const n = decodeName(ev.payload);
      if (n.length > 0) candidateName = n;
    }
  }

  throw new Error(`plugin "${pluginName}" not found in donor FLP`);
}

/**
 * Splice a plugin scope into the baseline at `(targetInsert,
 * targetSlotMarker)`. The slot scope is inserted RIGHT AFTER the
 * `0x62 targetSlotMarker` event of `targetInsert`, before any
 * subsequent `0x62`. FL's IPC reports the plugin at slot
 * `targetSlotMarker + 1`.
 */
export function craftPluginFixture(
  baseline: FLPProject,
  scope: FLPEvent[],
  targetInsert: number,
  targetSlotMarker: number,
): FLPProject {
  const events = [...baseline.events];
  let curInsert = 0;
  let inMixer = false;
  let insertedAt = -1;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.opcode === OP_INSERT_FLAGS) {
      inMixer = true;
      continue;
    }
    if (!inMixer) continue;
    if (ev.opcode === OP_INSERT_END) {
      curInsert++;
      continue;
    }
    if (curInsert === targetInsert && ev.kind === "u16" && ev.opcode === OP_NEW_SLOT) {
      if (ev.value === targetSlotMarker) {
        insertedAt = i + 1;
        break;
      }
    }
  }

  if (insertedAt < 0) {
    throw new Error(
      `target insert ${targetInsert} slot marker ${targetSlotMarker} not found in baseline`,
    );
  }
  events.splice(insertedAt, 0, ...scope);
  return { ...baseline, events };
}

/**
 * Top-level CLI entry. Parses argv and writes the synthesized FLP.
 * Run via `bun src/synth/craft-plugin-fixture.ts <args>`.
 */
function cliMain(argv: string[]): number {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--") && i + 1 < argv.length) {
      args[a.slice(2)] = argv[i + 1]!;
      i++;
    }
  }
  const required = ["baseline", "donor", "plugin", "out"];
  for (const k of required) {
    if (!args[k]) {
      console.error(`required: --baseline <flp> --donor <flp> --plugin "<name>" --out <flp>`);
      console.error(`optional: --target-insert N (default 0)  --target-slot-marker N (default 7)`);
      return 2;
    }
  }
  const targetInsert = args["target-insert"] ? Number(args["target-insert"]) : 0;
  const targetSlotMarker = args["target-slot-marker"] ? Number(args["target-slot-marker"]) : 7;

  const baseline = readPath(args["baseline"]!);
  const donor = readPath(args["donor"]!);
  const { scope, donorInsert, donorSlot } = extractPluginSlotScope(donor, args["plugin"]!);
  console.error(
    `[craft] extracted ${scope.length} events from donor insert=${donorInsert} slotMarker=${donorSlot}`,
  );
  const result = craftPluginFixture(baseline, scope, targetInsert, targetSlotMarker);
  const bytes = serializeFLPProject(result);
  writeFileSync(args["out"]!, bytes);
  console.error(
    `[craft] wrote ${args["out"]} (${bytes.byteLength} bytes); FL IPC slot index = ${targetSlotMarker + 1}`,
  );

  // Verify by re-parsing.
  const verify = parseFLPFile(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  for (const ins of verify.inserts) {
    for (const slot of ins.slots ?? []) {
      if (slot.hasPlugin) {
        console.error(
          `[craft]   verify: insert ${ins.index} slot ${slot.index}: ${slot.pluginName || slot.internalName}`,
        );
      }
    }
  }
  return 0;
}

if (import.meta.main) {
  process.exit(cliMain(process.argv.slice(2)));
}
