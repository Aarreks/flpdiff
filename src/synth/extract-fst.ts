/**
 * Extract channel-scope events from a `.fst` plugin preset.
 *
 * `.fst` files are FL Studio plugin presets — same FLhd+FLdt container
 * as `.flp` projects but with `container_kind=0x0030` (channel preset)
 * and a top-level event stream that's just the plugin's channel-scope
 * events: `0xC9` internal name + `0xD4` runtime data + `0xD5` state,
 * optionally followed by `0x1C` / `0xCB` / `0x9B` / `0x80` / `0x29`
 * channel-decoration events.
 *
 * See `flpdiff/docs/fl-format/fst-format.md` for the on-disk RE.
 *
 * Splice contract (used by Phase F9.2 `loadFactoryGeneratorPreset` and
 * `loadFactoryEffectPreset`):
 *
 *   1. Parse the donor `.fst` via `parseFLPFile` — works unchanged.
 *   2. Call `extractPluginScopeFromFst(donor)` to drop the FL-version
 *      banner (`0xC7`) and read the plugin's internal name.
 *   3. Wrap the returned `scope` in a channel-opener envelope
 *      (`0x40 newIid + 0x15 kindByte + 0xCB displayName + ...scope`)
 *      for generator presets, or splice into a mixer slot for effects.
 *
 * Generator vs effect classification is NOT encoded in the file —
 * both use `container_kind=0x0030`. Callers (typically the manifest
 * runtime in `mcp/src/flstudio_mcp/preset_browser.py`) infer it from
 * the source directory.
 */
import type { FLPEvent } from "../parser/event.ts";
import type { FLPProject } from "../parser/flp-project.ts";

export const FST_CONTAINER_KIND = 0x0030;

const OP_FL_VERSION_BANNER = 0xc7;
const OP_PLUGIN_INTERNAL_NAME = 0xc9;
const OP_DISPLAY_NAME = 0xcb;

function looksUtf16Le(payload: Uint8Array): boolean {
  // UTF-16LE-encoded ASCII has every odd-indexed byte at 0x00. We use
  // that as a cheap autodetect since `.fst` files don't carry the FL
  // version metadata our regular text decoder consults.
  if (payload.byteLength < 2 || payload.byteLength % 2 !== 0) return false;
  let zeros = 0;
  let total = 0;
  for (let i = 1; i < payload.byteLength; i += 2) {
    total += 1;
    if (payload[i] === 0) zeros += 1;
  }
  return total > 0 && zeros / total > 0.5;
}

function decodeName(payload: Uint8Array): string {
  // FL writes 0xC9 (plugin internal name) as **UTF-16LE in modern .flp
  // saves** but as **plain ASCII / Latin-1 in `.fst` plugin presets**
  // (the preset format was frozen long before FL switched to UTF-16
  // for project text). Autodetect by checking for the UTF-16LE
  // zero-padding pattern.
  let end = payload.byteLength;
  if (looksUtf16Le(payload)) {
    while (end >= 2 && payload[end - 1] === 0 && payload[end - 2] === 0) end -= 2;
    return new TextDecoder("utf-16le" as "utf-8").decode(payload.subarray(0, end));
  }
  while (end >= 1 && payload[end - 1] === 0) end -= 1;
  return new TextDecoder("latin1" as "utf-8").decode(payload.subarray(0, end));
}

export class FstParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FstParseError";
  }
}

export type ExtractedPluginScope = {
  /** Donor events minus the `0xC7` FL-version banner. Ready to splice. */
  scope: FLPEvent[];
  /** Plugin's internal name from `0xC9`. Required — throws if missing. */
  pluginInternalName: string;
  /** Plugin's display name from `0xCB`, if the preset carries one. */
  pluginDisplayName?: string;
};

/**
 * Extract the splice-ready plugin scope from a parsed `.fst` donor.
 *
 * Drops the `0xC7` FL-version banner (local-to-the-preset metadata,
 * not transferable). Returns the full remaining event list + the
 * plugin's internal name (and display name if the preset includes
 * a `0xCB`).
 *
 * Throws `FstParseError` if:
 * - the project's container kind isn't `0x0030`, OR
 * - no `0xC9` plugin-internal-name event is present.
 *
 * Both generator and effect presets share the same container — this
 * function doesn't distinguish them. Caller classifies via source
 * directory (`Plugin presets/Generators/` vs `Plugin presets/Effects/`).
 */
export function extractPluginScopeFromFst(donor: FLPProject): ExtractedPluginScope {
  if (donor.header.format !== FST_CONTAINER_KIND) {
    throw new FstParseError(
      `expected .fst container kind 0x${FST_CONTAINER_KIND.toString(16).padStart(4, "0")}, got 0x${donor.header.format
        .toString(16)
        .padStart(4, "0")}`,
    );
  }

  let pluginInternalName: string | undefined;
  let pluginDisplayName: string | undefined;
  const scope: FLPEvent[] = [];

  for (const ev of donor.events) {
    if (ev.opcode === OP_FL_VERSION_BANNER) continue;
    if (ev.kind === "blob" && ev.opcode === OP_PLUGIN_INTERNAL_NAME && pluginInternalName === undefined) {
      pluginInternalName = decodeName(ev.payload);
    }
    if (ev.kind === "blob" && ev.opcode === OP_DISPLAY_NAME && pluginDisplayName === undefined) {
      pluginDisplayName = decodeName(ev.payload);
    }
    scope.push(ev);
  }

  if (pluginInternalName === undefined) {
    throw new FstParseError(
      "no 0xC9 plugin-internal-name event in .fst donor — not a valid native plugin preset",
    );
  }

  return {
    scope,
    pluginInternalName,
    pluginDisplayName,
  };
}
