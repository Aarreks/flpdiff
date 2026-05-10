/**
 * Pure mutation helpers over `FLPProject` — Phase 3.0.4.
 *
 * Each helper takes an `FLPProject`, returns a NEW `FLPProject` with
 * the relevant event(s) modified. The serializer (Phase 3.0.3)
 * writes the result back to disk byte-exact except for the
 * intentionally-changed bytes.
 *
 * v0.1 covers: tempo, pattern name, channel name, insert name, time
 * signature. Channel + insert mutations mirror the boundary logic
 * from `project-builder.ts` (channels open at 0x40, inserts close at
 * 0x93, names are scope-attributed first-event-wins).
 */
import type { FLPProject } from "../parser/flp-project.ts";
import type { FLPEvent } from "../parser/event.ts";
import { decodeNotes, decodeControllers, type Controller, type Note } from "../model/pattern.ts";

export class MutationError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const OP_TEMPO_U32 = 0x9c;
const OP_PATTERN_NEW = 0x41; // marks the start of a pattern block (uint16 pattern id)
const OP_PATTERN_NAME = 0xc1; // UTF-16LE null-terminated text inside the active pattern's block
const OP_NEW_CHANNEL = 0x40; // opens a channel scope (uint16 iid)
const OP_NAME = 0xcb; // shared: channel name in channel scope, plugin name in mixer slot scope
const OP_CHANNEL_NAME_LEGACY = 0xc0; // pre-FL-11.5 channel-name fallback (also UTF-16LE on FL 25)
const OP_INSERT_END = 0x93; // closes a mixer insert block (uint32 routing target)
const OP_INSERT_FLAGS = 0xec; // FL-25 insert flags blob; closes channel scope (used for boundary detection)
const OP_INSERT_NAME = 0xcc; // per-insert name (UTF-16LE)
const OP_PROJECT_TIME_SIG_NUM = 0x11; // u8 project numerator
const OP_PROJECT_TIME_SIG_DENOM = 0x12; // u8 project denominator
const OP_CHANNEL_COLOR = 0x80; // u32 RGBA in channel scope (shared with plugin color)
const OP_INSERT_COLOR = 0x95; // u32 RGBA in mixer-insert scope
const OP_PATTERN_COLOR = 0x96; // u32 RGBA in pattern scope
const OP_CHANNEL_ROUTED_TO = 0x16; // u8 (signed int8) in channel scope; -1 = unrouted
const OP_ARRANGEMENT_NEW = 0x63; // u16 arrangement id (opens arrangement scope)
const OP_ARRANGEMENT_NAME = 0xf1; // UTF-16LE arrangement name
const OP_TRACK_DATA = 0xee; // 70-byte blob; one per track in arrangement
const OP_TRACK_NAME = 0xef; // UTF-16LE per-track name (follows the 0xEE it names)
const OP_PATTERN_NOTES = 0xe0; // pattern note blob (FL 25; pre-FL-25 was 0xD0)
const OP_PATTERN_CONTROLLERS = 0xdf; // pattern controllers blob
const OP_PATTERN_COLOR_OPCODE = 0x96; // alias for clarity in pattern-clone code
const OP_PATTERN_LENGTH = 0xa4; // u32 pattern length in PPQ ticks
const OP_PATTERN_LOOPED = 0x1a; // u8 looped flag

export type RGBA = { r: number; g: number; b: number; a?: number };

function packRGBA({ r, g, b, a = 0 }: RGBA): number {
  for (const [n, v] of Object.entries({ r, g, b, a })) {
    if (!Number.isInteger(v) || v < 0 || v > 255) {
      throw new MutationError("INVALID_ARGS", `RGBA.${n} must be integer in [0, 255], got ${v}`);
    }
  }
  // Mirror unpackRGBA's byte order: low byte = R.
  return ((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);
}

// --------------------------------------------------------------------------- //
// setTempo
// --------------------------------------------------------------------------- //

/**
 * Replace the modern Tempo event (`0x9C`, uint32 milli-BPM).
 *
 * Pre-FL-3.4.0 files used coarse (`0x42` u16) + optional fine
 * (`0x5D` u16); we don't write those — modern FL never reads them
 * back, so falling through silently would lose data on legacy
 * projects. Throws `LEGACY_TEMPO_FORMAT` instead.
 */
export function setTempo(project: FLPProject, bpm: number): FLPProject {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new MutationError("INVALID_ARGS", `bpm must be a positive number, got ${bpm}`);
  }
  const milli = Math.round(bpm * 1000);
  const events = [...project.events];
  let foundIndex = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "u32" && ev.opcode === OP_TEMPO_U32) {
      foundIndex = i;
      break;
    }
  }
  if (foundIndex === -1) {
    // Check if it's a legacy file before raising the more specific error
    const legacy = events.find(
      (e) => e.kind === "u16" && (e.opcode === 0x42 || e.opcode === 0x5d),
    );
    if (legacy) {
      throw new MutationError(
        "LEGACY_TEMPO_FORMAT",
        "this FLP uses the pre-FL-3.4.0 tempo opcodes (0x42 + 0x5D); set_tempo only writes the modern 0x9C u32 form",
      );
    }
    throw new MutationError("EVENT_NOT_FOUND", "no tempo event (opcode 0x9C) in this project");
  }
  events[foundIndex] = { kind: "u32", opcode: OP_TEMPO_U32, value: milli };
  return { ...project, events };
}

// --------------------------------------------------------------------------- //
// setPatternName
// --------------------------------------------------------------------------- //

/**
 * Replace pattern `iid`'s name with the given string. Pattern ids
 * are 1-based in FL UI (verified live; decision #30 in MCP-SPEC.md).
 *
 * Walks the event stream tracking the current pattern context: a
 * `0x41` event sets the active pattern id; subsequent `0xC1` events
 * (UTF-16LE, null-terminated) name that pattern. Replaces the name
 * blob in place. If the pattern exists but has no `0xC1` name yet,
 * we INSERT one immediately after the `0x41` so subsequent `0xC1`s
 * for other patterns aren't shifted into the wrong scope.
 */
export function setPatternName(project: FLPProject, iid: number, name: string): FLPProject {
  if (!Number.isInteger(iid) || iid < 1) {
    throw new MutationError(
      "INVALID_ARGS",
      `pattern iid must be a positive integer (1-based), got ${iid}`,
    );
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new MutationError("INVALID_ARGS", "name must be a non-empty string");
  }

  const events = [...project.events];
  const newPayload = encodeUtf16LeNullTerminated(name);

  let currentId = -1;
  let patternFound = false;
  let nameReplaced = false;
  let insertAfterIndex = -1;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "u16" && ev.opcode === OP_PATTERN_NEW) {
      // If we already passed the target pattern's block without finding
      // a name event, remember that we should insert one before moving
      // to the next pattern.
      if (currentId === iid && !nameReplaced) {
        insertAfterIndex = i - 1;
        break;
      }
      currentId = ev.value;
      if (currentId === iid) patternFound = true;
      continue;
    }
    if (
      currentId === iid &&
      ev.kind === "blob" &&
      ev.opcode === OP_PATTERN_NAME
    ) {
      events[i] = { kind: "blob", opcode: OP_PATTERN_NAME, payload: newPayload };
      nameReplaced = true;
      patternFound = true;
      break;
    }
  }

  // EOF reached while inside the target pattern's block without a name event.
  if (!nameReplaced && currentId === iid && insertAfterIndex === -1) {
    insertAfterIndex = events.length - 1;
    patternFound = true;
  }

  if (!patternFound) {
    throw new MutationError(
      "EVENT_NOT_FOUND",
      `no pattern with iid=${iid} found (max pattern id seen: ${currentId})`,
    );
  }

  if (!nameReplaced) {
    events.splice(insertAfterIndex + 1, 0, {
      kind: "blob",
      opcode: OP_PATTERN_NAME,
      payload: newPayload,
    });
  }

  return { ...project, events };
}

// --------------------------------------------------------------------------- //
// setChannelName
// --------------------------------------------------------------------------- //

/**
 * Replace channel `iid`'s name. Channel iids come from the value of
 * `0x40` events and are 0-based, sparse (FL preserves iids when a
 * channel is deleted from the middle of the rack). Looks up the
 * channel block (between its `0x40` and the next `0x40` or
 * end-of-events) and replaces the first `0xCB` blob in that range.
 *
 * The parser already prefers `0xCB` over the legacy `0xC0` fallback
 * (first-id-wins), so writing `0xCB` is sufficient even if a stale
 * `0xC0` exists alongside. If neither exists in the channel's range,
 * we INSERT a `0xCB` immediately after the `0x40`.
 */
export function setChannelName(project: FLPProject, iid: number, name: string): FLPProject {
  if (!Number.isInteger(iid) || iid < 0) {
    throw new MutationError(
      "INVALID_ARGS",
      `channel iid must be a non-negative integer, got ${iid}`,
    );
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new MutationError("INVALID_ARGS", "name must be a non-empty string");
  }

  const events = [...project.events];
  const newPayload = encodeUtf16LeNullTerminated(name);

  let openIndex = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "u16" && ev.opcode === OP_NEW_CHANNEL && ev.value === iid) {
      openIndex = i;
      break;
    }
  }
  if (openIndex === -1) {
    throw new MutationError("EVENT_NOT_FOUND", `no channel with iid=${iid} found`);
  }

  // Bound the search to this channel's block: from its 0x40 (exclusive)
  // until the next 0x40 OR until we hit a mixer-section closer (0x93/0xEC)
  // — same boundary semantics buildChannels uses to keep the 0xCB scope
  // out of the mixer slot section.
  let endIndex = events.length;
  for (let i = openIndex + 1; i < events.length; i++) {
    const ev = events[i]!;
    if (
      (ev.kind === "u16" && ev.opcode === OP_NEW_CHANNEL) ||
      (ev.kind === "u32" && ev.opcode === OP_INSERT_END) ||
      (ev.kind === "blob" && ev.opcode === OP_INSERT_FLAGS)
    ) {
      endIndex = i;
      break;
    }
  }

  for (let i = openIndex + 1; i < endIndex; i++) {
    const ev = events[i]!;
    if (ev.kind === "blob" && ev.opcode === OP_NAME) {
      events[i] = { kind: "blob", opcode: OP_NAME, payload: newPayload };
      // Drop any legacy 0xC0 fallback in the same range so it can't be
      // resurrected if the parser's first-id-wins rule ever changes
      // and to keep the rewrite minimal.
      return { ...project, events };
    }
  }

  // No 0xCB in this channel's range — insert one immediately after the
  // 0x40. (We don't touch any 0xC0 fallback that might exist; the
  // parser still prefers 0xCB.)
  events.splice(openIndex + 1, 0, { kind: "blob", opcode: OP_NAME, payload: newPayload });
  return { ...project, events };
}

// --------------------------------------------------------------------------- //
// setInsertName
// --------------------------------------------------------------------------- //

/**
 * Replace mixer insert `index`'s name. Insert indices are 0-based;
 * insert 0 = master. The Kth insert's events run from end-of-prev-insert
 * (or stream start, for K=0) up to and including the Kth `0x93`
 * (insert-end) event.
 *
 * Replaces the first `0xCC` blob in the range; if missing, inserts one
 * immediately before the `0x93` so subsequent insert blocks aren't
 * shifted.
 */
export function setInsertName(project: FLPProject, index: number, name: string): FLPProject {
  if (!Number.isInteger(index) || index < 0) {
    throw new MutationError(
      "INVALID_ARGS",
      `insert index must be a non-negative integer, got ${index}`,
    );
  }
  if (typeof name !== "string") {
    throw new MutationError("INVALID_ARGS", "name must be a string (use empty string to clear)");
  }

  const events = [...project.events];

  // Walk to the Kth 0x93 closer; track the previous closer to bound the range.
  let kthCloseIdx = -1;
  let prevCloseIdx = -1;
  let seen = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "u32" && ev.opcode === OP_INSERT_END) {
      seen += 1;
      if (seen === index) {
        kthCloseIdx = i;
        break;
      }
      prevCloseIdx = i;
    }
  }
  if (kthCloseIdx === -1) {
    throw new MutationError(
      "EVENT_NOT_FOUND",
      `no mixer insert with index=${index} found (saw ${seen + 1} 0x93 closers)`,
    );
  }

  const rangeStart = prevCloseIdx + 1; // 0 when index === 0
  const newPayload = encodeUtf16LeNullTerminated(name);

  for (let i = rangeStart; i < kthCloseIdx; i++) {
    const ev = events[i]!;
    if (ev.kind === "blob" && ev.opcode === OP_INSERT_NAME) {
      events[i] = { kind: "blob", opcode: OP_INSERT_NAME, payload: newPayload };
      return { ...project, events };
    }
  }

  // Insert before the 0x93 closer for this insert.
  events.splice(kthCloseIdx, 0, {
    kind: "blob",
    opcode: OP_INSERT_NAME,
    payload: newPayload,
  });
  return { ...project, events };
}

// --------------------------------------------------------------------------- //
// setTimeSignature
// --------------------------------------------------------------------------- //

/**
 * Replace the project-level time signature (`0x11` numerator + `0x12`
 * denominator, both u8). These fire in the project header as a flat
 * pair (not inside any time-marker block) so no scope walking needed.
 *
 * Both events must already exist (FL writes them on every save);
 * EVENT_NOT_FOUND otherwise. Denominator is the literal denominator
 * value (4 = quarter-note beats), not log2 — FL stores 4/4 as `denom=4`,
 * 6/8 as `denom=8`, etc. Power-of-2 in [1, 64] is the legal range
 * matching FL's UI options (1, 2, 4, 8, 16, 32).
 */
export function setTimeSignature(
  project: FLPProject,
  numerator: number,
  denominator: number,
): FLPProject {
  if (!Number.isInteger(numerator) || numerator < 1 || numerator > 255) {
    throw new MutationError(
      "INVALID_ARGS",
      `numerator must be an integer in [1, 255], got ${numerator}`,
    );
  }
  if (
    !Number.isInteger(denominator) ||
    denominator < 1 ||
    denominator > 64 ||
    (denominator & (denominator - 1)) !== 0
  ) {
    throw new MutationError(
      "INVALID_ARGS",
      `denominator must be a power of 2 in [1, 64] (1, 2, 4, 8, 16, 32, 64), got ${denominator}`,
    );
  }

  const events = [...project.events];
  let numIdx = -1;
  let denomIdx = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "u8" && ev.opcode === OP_PROJECT_TIME_SIG_NUM && numIdx === -1) {
      numIdx = i;
    } else if (ev.kind === "u8" && ev.opcode === OP_PROJECT_TIME_SIG_DENOM && denomIdx === -1) {
      denomIdx = i;
    }
    if (numIdx !== -1 && denomIdx !== -1) break;
  }
  if (numIdx === -1) {
    throw new MutationError(
      "EVENT_NOT_FOUND",
      "no project time-signature numerator (opcode 0x11) in this project",
    );
  }
  if (denomIdx === -1) {
    throw new MutationError(
      "EVENT_NOT_FOUND",
      "no project time-signature denominator (opcode 0x12) in this project",
    );
  }

  events[numIdx] = { kind: "u8", opcode: OP_PROJECT_TIME_SIG_NUM, value: numerator };
  events[denomIdx] = { kind: "u8", opcode: OP_PROJECT_TIME_SIG_DENOM, value: denominator };
  return { ...project, events };
}

// --------------------------------------------------------------------------- //
// setChannelColor / setInsertColor / setPatternColor
// --------------------------------------------------------------------------- //

/**
 * Generic helper for u32-RGBA color events scoped inside a block.
 * Walks events to the block opener whose `value === id`, scans the
 * block range (bounded by the next opener-of-same-kind OR by any
 * supplied `closerOpcodes`), replaces the first matching color event
 * if found, else inserts immediately after the opener.
 */
function setBlockColorU32(
  project: FLPProject,
  opts: {
    blockOpenOpcode: number;
    blockOpenKind: "u16";
    blockId: number;
    colorOpcode: number;
    closerOpcodes?: ReadonlyArray<{ opcode: number; kind: FLPEvent["kind"] }>;
    rgba: RGBA;
    blockLabel: string;
  },
): FLPProject {
  const events = [...project.events];
  const newValue = packRGBA(opts.rgba);

  let openIndex = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (
      ev.kind === opts.blockOpenKind &&
      ev.opcode === opts.blockOpenOpcode &&
      ev.value === opts.blockId
    ) {
      openIndex = i;
      break;
    }
  }
  if (openIndex === -1) {
    throw new MutationError(
      "EVENT_NOT_FOUND",
      `no ${opts.blockLabel} with id=${opts.blockId} found`,
    );
  }

  let endIndex = events.length;
  const closers = opts.closerOpcodes ?? [];
  for (let i = openIndex + 1; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === opts.blockOpenKind && ev.opcode === opts.blockOpenOpcode) {
      endIndex = i;
      break;
    }
    for (const c of closers) {
      if (ev.kind === c.kind && ev.opcode === c.opcode) {
        endIndex = i;
        break;
      }
    }
    if (endIndex !== events.length) break;
  }

  for (let i = openIndex + 1; i < endIndex; i++) {
    const ev = events[i]!;
    if (ev.kind === "u32" && ev.opcode === opts.colorOpcode) {
      events[i] = { kind: "u32", opcode: opts.colorOpcode, value: newValue };
      return { ...project, events };
    }
  }

  events.splice(openIndex + 1, 0, { kind: "u32", opcode: opts.colorOpcode, value: newValue });
  return { ...project, events };
}

export function setChannelColor(project: FLPProject, iid: number, rgba: RGBA): FLPProject {
  if (!Number.isInteger(iid) || iid < 0) {
    throw new MutationError(
      "INVALID_ARGS",
      `channel iid must be a non-negative integer, got ${iid}`,
    );
  }
  return setBlockColorU32(project, {
    blockOpenOpcode: OP_NEW_CHANNEL,
    blockOpenKind: "u16",
    blockId: iid,
    colorOpcode: OP_CHANNEL_COLOR,
    closerOpcodes: [
      { opcode: OP_INSERT_END, kind: "u32" },
      { opcode: OP_INSERT_FLAGS, kind: "blob" },
    ],
    rgba,
    blockLabel: "channel",
  });
}

/**
 * Insert color (`0x95`). Insert blocks are bounded by `0x93` closers,
 * not by an opener event — so we use a different strategy than the
 * channel/pattern walkers.
 */
export function setInsertColor(project: FLPProject, index: number, rgba: RGBA): FLPProject {
  if (!Number.isInteger(index) || index < 0) {
    throw new MutationError(
      "INVALID_ARGS",
      `insert index must be a non-negative integer, got ${index}`,
    );
  }
  const events = [...project.events];
  const newValue = packRGBA(rgba);

  let kthCloseIdx = -1;
  let prevCloseIdx = -1;
  let seen = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "u32" && ev.opcode === OP_INSERT_END) {
      seen += 1;
      if (seen === index) {
        kthCloseIdx = i;
        break;
      }
      prevCloseIdx = i;
    }
  }
  if (kthCloseIdx === -1) {
    throw new MutationError(
      "EVENT_NOT_FOUND",
      `no mixer insert with index=${index} found (saw ${seen + 1} 0x93 closers)`,
    );
  }

  for (let i = prevCloseIdx + 1; i < kthCloseIdx; i++) {
    const ev = events[i]!;
    if (ev.kind === "u32" && ev.opcode === OP_INSERT_COLOR) {
      events[i] = { kind: "u32", opcode: OP_INSERT_COLOR, value: newValue };
      return { ...project, events };
    }
  }
  events.splice(kthCloseIdx, 0, { kind: "u32", opcode: OP_INSERT_COLOR, value: newValue });
  return { ...project, events };
}

export function setPatternColor(project: FLPProject, iid: number, rgba: RGBA): FLPProject {
  if (!Number.isInteger(iid) || iid < 1) {
    throw new MutationError(
      "INVALID_ARGS",
      `pattern iid must be a positive integer (1-based), got ${iid}`,
    );
  }
  // Pattern blocks open at 0x41 with the pattern id; FL emits 0x41
  // twice per pattern — we just need ANY 0x41 with this id, then walk
  // until the NEXT 0x41 (regardless of id) or end-of-events.
  const events = [...project.events];
  const newValue = packRGBA(rgba);

  let openIndex = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "u16" && ev.opcode === OP_PATTERN_NEW && ev.value === iid) {
      openIndex = i;
      break;
    }
  }
  if (openIndex === -1) {
    throw new MutationError("EVENT_NOT_FOUND", `no pattern with iid=${iid} found`);
  }

  let endIndex = events.length;
  for (let i = openIndex + 1; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "u16" && ev.opcode === OP_PATTERN_NEW) {
      endIndex = i;
      break;
    }
  }

  for (let i = openIndex + 1; i < endIndex; i++) {
    const ev = events[i]!;
    if (ev.kind === "u32" && ev.opcode === OP_PATTERN_COLOR) {
      events[i] = { kind: "u32", opcode: OP_PATTERN_COLOR, value: newValue };
      return { ...project, events };
    }
  }
  events.splice(openIndex + 1, 0, { kind: "u32", opcode: OP_PATTERN_COLOR, value: newValue });
  return { ...project, events };
}

// --------------------------------------------------------------------------- //
// setChannelRouting
// --------------------------------------------------------------------------- //

/**
 * Replace channel `iid`'s mixer-insert routing target. The opcode is
 * `0x16`, a BYTE-range u8 interpreted as signed int8. `-1` (encoded
 * 0xFF) means unrouted (default to master).
 */
export function setChannelRouting(
  project: FLPProject,
  iid: number,
  targetInsert: number,
): FLPProject {
  if (!Number.isInteger(iid) || iid < 0) {
    throw new MutationError(
      "INVALID_ARGS",
      `channel iid must be a non-negative integer, got ${iid}`,
    );
  }
  if (!Number.isInteger(targetInsert) || targetInsert < -1 || targetInsert > 127) {
    throw new MutationError(
      "INVALID_ARGS",
      `targetInsert must be integer in [-1, 127] (signed int8), got ${targetInsert}`,
    );
  }

  const events = [...project.events];
  const encoded = targetInsert < 0 ? targetInsert + 256 : targetInsert; // -1 → 0xFF

  let openIndex = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "u16" && ev.opcode === OP_NEW_CHANNEL && ev.value === iid) {
      openIndex = i;
      break;
    }
  }
  if (openIndex === -1) {
    throw new MutationError("EVENT_NOT_FOUND", `no channel with iid=${iid} found`);
  }

  let endIndex = events.length;
  for (let i = openIndex + 1; i < events.length; i++) {
    const ev = events[i]!;
    if (
      (ev.kind === "u16" && ev.opcode === OP_NEW_CHANNEL) ||
      (ev.kind === "u32" && ev.opcode === OP_INSERT_END) ||
      (ev.kind === "blob" && ev.opcode === OP_INSERT_FLAGS)
    ) {
      endIndex = i;
      break;
    }
  }

  for (let i = openIndex + 1; i < endIndex; i++) {
    const ev = events[i]!;
    if (ev.kind === "u8" && ev.opcode === OP_CHANNEL_ROUTED_TO) {
      events[i] = { kind: "u8", opcode: OP_CHANNEL_ROUTED_TO, value: encoded };
      return { ...project, events };
    }
  }
  events.splice(openIndex + 1, 0, {
    kind: "u8",
    opcode: OP_CHANNEL_ROUTED_TO,
    value: encoded,
  });
  return { ...project, events };
}

// --------------------------------------------------------------------------- //
// setArrangementName
// --------------------------------------------------------------------------- //

export function setArrangementName(
  project: FLPProject,
  arrangementId: number,
  name: string,
): FLPProject {
  if (!Number.isInteger(arrangementId) || arrangementId < 0) {
    throw new MutationError(
      "INVALID_ARGS",
      `arrangement id must be a non-negative integer, got ${arrangementId}`,
    );
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new MutationError("INVALID_ARGS", "name must be a non-empty string");
  }
  const events = [...project.events];
  const newPayload = encodeUtf16LeNullTerminated(name);

  let openIndex = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (
      ev.kind === "u16" &&
      ev.opcode === OP_ARRANGEMENT_NEW &&
      ev.value === arrangementId
    ) {
      openIndex = i;
      break;
    }
  }
  if (openIndex === -1) {
    throw new MutationError(
      "EVENT_NOT_FOUND",
      `no arrangement with id=${arrangementId} found`,
    );
  }
  let endIndex = events.length;
  for (let i = openIndex + 1; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "u16" && ev.opcode === OP_ARRANGEMENT_NEW) {
      endIndex = i;
      break;
    }
  }
  for (let i = openIndex + 1; i < endIndex; i++) {
    const ev = events[i]!;
    if (ev.kind === "blob" && ev.opcode === OP_ARRANGEMENT_NAME) {
      events[i] = { kind: "blob", opcode: OP_ARRANGEMENT_NAME, payload: newPayload };
      return { ...project, events };
    }
  }
  events.splice(openIndex + 1, 0, {
    kind: "blob",
    opcode: OP_ARRANGEMENT_NAME,
    payload: newPayload,
  });
  return { ...project, events };
}

// --------------------------------------------------------------------------- //
// setTrackName
// --------------------------------------------------------------------------- //

/**
 * Replace the per-track name (`0xEF`) on track `trackIndex` (0-based,
 * 0 = top) within arrangement `arrangementId`. Track-data blobs (`0xEE`)
 * appear in walker order; the Nth `0xEE` after the arrangement opener
 * is track N. Track names appear immediately AFTER the `0xEE` they
 * label — FL only emits `0xEF` when the user has set a custom name,
 * so absence is normal.
 */
export function setTrackName(
  project: FLPProject,
  arrangementId: number,
  trackIndex: number,
  name: string,
): FLPProject {
  if (!Number.isInteger(arrangementId) || arrangementId < 0) {
    throw new MutationError(
      "INVALID_ARGS",
      `arrangement id must be a non-negative integer, got ${arrangementId}`,
    );
  }
  if (!Number.isInteger(trackIndex) || trackIndex < 0) {
    throw new MutationError(
      "INVALID_ARGS",
      `track index must be a non-negative integer, got ${trackIndex}`,
    );
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new MutationError("INVALID_ARGS", "name must be a non-empty string");
  }
  const events = [...project.events];
  const newPayload = encodeUtf16LeNullTerminated(name);

  let openIndex = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (
      ev.kind === "u16" &&
      ev.opcode === OP_ARRANGEMENT_NEW &&
      ev.value === arrangementId
    ) {
      openIndex = i;
      break;
    }
  }
  if (openIndex === -1) {
    throw new MutationError(
      "EVENT_NOT_FOUND",
      `no arrangement with id=${arrangementId} found`,
    );
  }
  let endIndex = events.length;
  for (let i = openIndex + 1; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "u16" && ev.opcode === OP_ARRANGEMENT_NEW) {
      endIndex = i;
      break;
    }
  }

  // Walk to the (trackIndex)-th 0xEE in the arrangement scope.
  let trackBlobIdx = -1;
  let seen = -1;
  for (let i = openIndex + 1; i < endIndex; i++) {
    const ev = events[i]!;
    if (ev.kind === "blob" && ev.opcode === OP_TRACK_DATA) {
      seen += 1;
      if (seen === trackIndex) {
        trackBlobIdx = i;
        break;
      }
    }
  }
  if (trackBlobIdx === -1) {
    throw new MutationError(
      "EVENT_NOT_FOUND",
      `arrangement ${arrangementId} has no track at index ${trackIndex} (only ${seen + 1} tracks)`,
    );
  }

  // Look for an existing 0xEF immediately after the 0xEE — but only
  // BEFORE the next 0xEE (so we don't accidentally rename a different track).
  let nextTrackIdx = endIndex;
  for (let i = trackBlobIdx + 1; i < endIndex; i++) {
    const ev = events[i]!;
    if (ev.kind === "blob" && ev.opcode === OP_TRACK_DATA) {
      nextTrackIdx = i;
      break;
    }
  }
  for (let i = trackBlobIdx + 1; i < nextTrackIdx; i++) {
    const ev = events[i]!;
    if (ev.kind === "blob" && ev.opcode === OP_TRACK_NAME) {
      events[i] = { kind: "blob", opcode: OP_TRACK_NAME, payload: newPayload };
      return { ...project, events };
    }
  }
  events.splice(trackBlobIdx + 1, 0, {
    kind: "blob",
    opcode: OP_TRACK_NAME,
    payload: newPayload,
  });
  return { ...project, events };
}

// --------------------------------------------------------------------------- //
// clonePattern
// --------------------------------------------------------------------------- //

/**
 * Clone pattern `sourceIid` to a new pattern with id = (max existing
 * pattern id) + 1. Duplicates the pattern's full event subtree (notes,
 * controllers, color, length, looped flag, and any 0xC1 name) and
 * inserts after the source pattern's events. The new pattern's `0x41`
 * marker carries the new id, and the optional `newName` (default
 * "<source name> copy") replaces the cloned 0xC1 blob.
 *
 * FL emits 0x41 TWICE per pattern (once for note/controller events,
 * once for the rest). We dedupe by walking from the FIRST 0x41 with
 * sourceIid until we exit the pattern's scope — bounded by the next
 * 0x41 with a DIFFERENT id OR end-of-pattern-section.
 */
export function clonePattern(
  project: FLPProject,
  sourceIid: number,
  newName?: string,
): FLPProject {
  if (!Number.isInteger(sourceIid) || sourceIid < 1) {
    throw new MutationError(
      "INVALID_ARGS",
      `pattern iid must be a positive integer (1-based), got ${sourceIid}`,
    );
  }

  // Find max pattern id to assign the new one.
  let maxId = 0;
  let sawSource = false;
  for (const ev of project.events) {
    if (ev.kind === "u16" && ev.opcode === OP_PATTERN_NEW) {
      if (ev.value > maxId) maxId = ev.value;
      if (ev.value === sourceIid) sawSource = true;
    }
  }
  if (!sawSource) {
    throw new MutationError("EVENT_NOT_FOUND", `no pattern with iid=${sourceIid} found`);
  }
  const newId = maxId + 1;

  // Pattern-scope opcode whitelist — mirrors buildPatterns. We
  // intentionally do NOT blanket-capture every event after a 0x41,
  // because the pattern section has no closing marker; everything
  // until the next 0x41 OR the start of the arrangement section
  // (0x63) would otherwise leak into the clone.
  const PATTERN_SCOPE_OPCODES: ReadonlySet<number> = new Set([
    OP_PATTERN_NAME,
    OP_PATTERN_NOTES,
    OP_PATTERN_CONTROLLERS,
    OP_PATTERN_COLOR_OPCODE,
    OP_PATTERN_LENGTH,
    OP_PATTERN_LOOPED,
  ]);
  const cloned: FLPEvent[] = [];
  let scopeId = -1;
  let lastSourceIdx = -1;
  for (let i = 0; i < project.events.length; i++) {
    const ev = project.events[i]!;
    if (ev.kind === "u16" && ev.opcode === OP_PATTERN_NEW) {
      scopeId = ev.value;
      if (scopeId === sourceIid) {
        cloned.push({ kind: "u16", opcode: OP_PATTERN_NEW, value: newId });
        lastSourceIdx = i;
      }
      continue;
    }
    if (scopeId !== sourceIid) continue;
    if (!PATTERN_SCOPE_OPCODES.has(ev.opcode)) continue;
    lastSourceIdx = i;
    if (ev.kind === "blob" && ev.opcode === OP_PATTERN_NAME) {
      const finalName = newName ?? `Pattern ${sourceIid} copy`;
      cloned.push({
        kind: "blob",
        opcode: OP_PATTERN_NAME,
        payload: encodeUtf16LeNullTerminated(finalName),
      });
      continue;
    }
    if (ev.kind === "blob") {
      cloned.push({ kind: "blob", opcode: ev.opcode, payload: new Uint8Array(ev.payload) });
    } else if (ev.kind === "u8") {
      cloned.push({ kind: "u8", opcode: ev.opcode, value: ev.value });
    } else if (ev.kind === "u16") {
      cloned.push({ kind: "u16", opcode: ev.opcode, value: ev.value });
    } else if (ev.kind === "u32") {
      cloned.push({ kind: "u32", opcode: ev.opcode, value: ev.value });
    }
  }

  // If source has no 0xC1 name event, insert one for the clone right
  // after its 0x41 so the rename is visible.
  const cloneHasName = cloned.some((e) => e.kind === "blob" && e.opcode === OP_PATTERN_NAME);
  if (!cloneHasName) {
    const finalName = newName ?? `Pattern ${sourceIid} copy`;
    cloned.splice(1, 0, {
      kind: "blob",
      opcode: OP_PATTERN_NAME,
      payload: encodeUtf16LeNullTerminated(finalName),
    });
  }

  const events = [...project.events];
  events.splice(lastSourceIdx + 1, 0, ...cloned);
  return { ...project, events };
}

// --------------------------------------------------------------------------- //
// setTrackColor
// --------------------------------------------------------------------------- //

/**
 * Replace track color inside the 70-byte `0xEE` track-data blob.
 * The color lives at bytes 4-7 (uint32 LE, RGBA-packed same as
 * channel/insert colors per `decodeTrackData`).
 *
 * No full encoder needed — we copy the existing payload, patch bytes
 * 4-7 in place, write back. All other fields (icon, enabled, height,
 * locked, plus the trailing motion/press/etc. we don't surface) are
 * preserved bit-exact.
 */
export function setTrackColor(
  project: FLPProject,
  arrangementId: number,
  trackIndex: number,
  rgba: RGBA,
): FLPProject {
  if (!Number.isInteger(arrangementId) || arrangementId < 0) {
    throw new MutationError(
      "INVALID_ARGS",
      `arrangement id must be a non-negative integer, got ${arrangementId}`,
    );
  }
  if (!Number.isInteger(trackIndex) || trackIndex < 0) {
    throw new MutationError(
      "INVALID_ARGS",
      `track index must be a non-negative integer, got ${trackIndex}`,
    );
  }
  const colorU32 = packRGBA(rgba);

  const events = [...project.events];
  let openIndex = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (
      ev.kind === "u16" &&
      ev.opcode === OP_ARRANGEMENT_NEW &&
      ev.value === arrangementId
    ) {
      openIndex = i;
      break;
    }
  }
  if (openIndex === -1) {
    throw new MutationError(
      "EVENT_NOT_FOUND",
      `no arrangement with id=${arrangementId} found`,
    );
  }
  let endIndex = events.length;
  for (let i = openIndex + 1; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "u16" && ev.opcode === OP_ARRANGEMENT_NEW) {
      endIndex = i;
      break;
    }
  }

  let trackBlobIdx = -1;
  let seen = -1;
  for (let i = openIndex + 1; i < endIndex; i++) {
    const ev = events[i]!;
    if (ev.kind === "blob" && ev.opcode === OP_TRACK_DATA) {
      seen += 1;
      if (seen === trackIndex) {
        trackBlobIdx = i;
        break;
      }
    }
  }
  if (trackBlobIdx === -1) {
    throw new MutationError(
      "EVENT_NOT_FOUND",
      `arrangement ${arrangementId} has no track at index ${trackIndex} (only ${seen + 1} tracks)`,
    );
  }
  const orig = events[trackBlobIdx]!;
  if (orig.kind !== "blob" || orig.payload.byteLength < 8) {
    throw new MutationError(
      "INVALID_ARGS",
      `track-data blob too small (${orig.kind === "blob" ? orig.payload.byteLength : 0} bytes); needs >= 8 for color`,
    );
  }
  const newPayload = new Uint8Array(orig.payload);
  const view = new DataView(newPayload.buffer, newPayload.byteOffset, newPayload.byteLength);
  view.setUint32(4, colorU32, true);
  events[trackBlobIdx] = { kind: "blob", opcode: OP_TRACK_DATA, payload: newPayload };
  return { ...project, events };
}

// --------------------------------------------------------------------------- //
// setTrackGrouped — toggle "grouped with track above" flag (byte 46)
// --------------------------------------------------------------------------- //

/**
 * Toggle the `grouped` flag at byte 46 of the 70-byte `0xEE`
 * track-data blob. FL infers parent/child track grouping positionally:
 * track N is a CHILD of the nearest track at index <N with
 * `grouped == false`. So setting `grouped: true` on track 5 makes it
 * a child of whatever ungrouped track sits at index 4 or earlier.
 */
export function setTrackGrouped(
  project: FLPProject,
  arrangementId: number,
  trackIndex: number,
  grouped: boolean,
): FLPProject {
  if (!Number.isInteger(arrangementId) || arrangementId < 0) {
    throw new MutationError(
      "INVALID_ARGS",
      `arrangement id must be a non-negative integer, got ${arrangementId}`,
    );
  }
  if (!Number.isInteger(trackIndex) || trackIndex < 0) {
    throw new MutationError(
      "INVALID_ARGS",
      `track index must be a non-negative integer, got ${trackIndex}`,
    );
  }
  if (typeof grouped !== "boolean") {
    throw new MutationError("INVALID_ARGS", "grouped must be a boolean");
  }
  const events = [...project.events];
  let openIndex = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (
      ev.kind === "u16" &&
      ev.opcode === OP_ARRANGEMENT_NEW &&
      ev.value === arrangementId
    ) {
      openIndex = i;
      break;
    }
  }
  if (openIndex === -1) {
    throw new MutationError(
      "EVENT_NOT_FOUND",
      `no arrangement with id=${arrangementId} found`,
    );
  }
  let endIndex = events.length;
  for (let i = openIndex + 1; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "u16" && ev.opcode === OP_ARRANGEMENT_NEW) {
      endIndex = i;
      break;
    }
  }
  let trackBlobIdx = -1;
  let seen = -1;
  for (let i = openIndex + 1; i < endIndex; i++) {
    const ev = events[i]!;
    if (ev.kind === "blob" && ev.opcode === OP_TRACK_DATA) {
      seen += 1;
      if (seen === trackIndex) {
        trackBlobIdx = i;
        break;
      }
    }
  }
  if (trackBlobIdx === -1) {
    throw new MutationError(
      "EVENT_NOT_FOUND",
      `arrangement ${arrangementId} has no track at index ${trackIndex} (only ${seen + 1} tracks)`,
    );
  }
  const orig = events[trackBlobIdx]!;
  if (orig.kind !== "blob" || orig.payload.byteLength < 47) {
    throw new MutationError(
      "INVALID_ARGS",
      `track-data blob too small for grouped flag (${orig.kind === "blob" ? orig.payload.byteLength : 0} bytes; need >= 47)`,
    );
  }
  const newPayload = new Uint8Array(orig.payload);
  // Byte 46 = grouped (per PyFLP TrackEvent struct, end-offset 47);
  // byte 47 is `locked`. We had these off-by-one until 2026-05-07
  // when FL UI showed "Lock to content" enabled instead of grouping.
  newPayload[46] = grouped ? 1 : 0;
  events[trackBlobIdx] = { kind: "blob", opcode: OP_TRACK_DATA, payload: newPayload };
  return { ...project, events };
}

// --------------------------------------------------------------------------- //
// addClip / removeClip / moveClip — playlist clip mutations
// --------------------------------------------------------------------------- //

const OP_PLAYLIST = 0xe9;
const PATTERN_BASE = 20480;
const TRACK_MAX = 499;
const CLIP_RECORD_SIZE = 60; // FL 21+ default; pre-FL-21 was 32

export type ClipPlacement = {
  /** "pattern" → reference a pattern by id; "channel" → reference a channel by iid. */
  kind: "pattern" | "channel";
  /** Pattern id (1-based) or channel iid (0-based). */
  ref_id: number;
  /** 0-based track index from FL display order (0 = top). Internally stored reversed. */
  track_index: number;
  /** Tick position on the playlist timeline. */
  position_ticks: number;
  /** Clip length in ticks. */
  length_ticks: number;
};

function findArrangementBounds(
  events: readonly FLPEvent[],
  arrangementId: number,
): { openIdx: number; endIdx: number } {
  let openIdx = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (
      ev.kind === "u16" &&
      ev.opcode === OP_ARRANGEMENT_NEW &&
      ev.value === arrangementId
    ) {
      openIdx = i;
      break;
    }
  }
  if (openIdx === -1) {
    throw new MutationError(
      "EVENT_NOT_FOUND",
      `no arrangement with id=${arrangementId} found`,
    );
  }
  let endIdx = events.length;
  for (let i = openIdx + 1; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "u16" && ev.opcode === OP_ARRANGEMENT_NEW) {
      endIdx = i;
      break;
    }
  }
  return { openIdx, endIdx };
}

function encodeClipRecord(
  position: number,
  itemIndex: number,
  length: number,
  trackRvidx: number,
): Uint8Array {
  // 60-byte FL 21+ record. Reserved bytes (_u1 16-17, _u2 20-23, _u3 32-59)
  // stay zero — FL tolerates zero-reserved on freshly-written clips.
  const buf = new Uint8Array(CLIP_RECORD_SIZE);
  const view = new DataView(buf.buffer);
  view.setUint32(0, position, true);
  view.setUint16(4, PATTERN_BASE, true); // pattern_base sentinel
  view.setUint16(6, itemIndex, true);
  view.setUint32(8, length, true);
  view.setUint16(12, trackRvidx, true);
  view.setUint16(14, 0, true); // group
  // 16-17 reserved
  view.setUint16(18, 0, true); // item_flags — default
  // 20-23 reserved
  view.setFloat32(24, 0.0, true); // start_offset
  view.setFloat32(28, 0.0, true); // end_offset
  // 32-59 reserved (FL 21+)
  return buf;
}

function resolveItemIndex(placement: ClipPlacement): number {
  if (placement.kind === "pattern") {
    if (!Number.isInteger(placement.ref_id) || placement.ref_id < 1) {
      throw new MutationError(
        "INVALID_ARGS",
        `pattern ref_id must be a positive integer, got ${placement.ref_id}`,
      );
    }
    return placement.ref_id + PATTERN_BASE;
  }
  if (!Number.isInteger(placement.ref_id) || placement.ref_id < 0) {
    throw new MutationError(
      "INVALID_ARGS",
      `channel ref_id must be a non-negative integer, got ${placement.ref_id}`,
    );
  }
  return placement.ref_id;
}

function resolveTrackRvidx(trackIndex: number): number {
  if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex > TRACK_MAX) {
    throw new MutationError(
      "INVALID_ARGS",
      `track_index must be integer in [0, ${TRACK_MAX}], got ${trackIndex}`,
    );
  }
  return TRACK_MAX - trackIndex;
}

/**
 * Append a new playlist clip to arrangement `arrangementId`. If the
 * arrangement already has at least one `0xE9` blob, the new record is
 * appended to the LAST one (preserving all original bytes verbatim).
 * Otherwise a fresh `0xE9` blob is inserted at the end of the
 * arrangement scope.
 */
export function addClip(
  project: FLPProject,
  arrangementId: number,
  placement: ClipPlacement,
): FLPProject {
  if (!Number.isInteger(placement.position_ticks) || placement.position_ticks < 0) {
    throw new MutationError("INVALID_ARGS", "position_ticks must be non-negative integer");
  }
  if (!Number.isInteger(placement.length_ticks) || placement.length_ticks < 1) {
    throw new MutationError("INVALID_ARGS", "length_ticks must be positive integer");
  }
  const itemIndex = resolveItemIndex(placement);
  const trackRvidx = resolveTrackRvidx(placement.track_index);
  const newRecord = encodeClipRecord(
    placement.position_ticks,
    itemIndex,
    placement.length_ticks,
    trackRvidx,
  );

  const events = [...project.events];
  const { openIdx, endIdx } = findArrangementBounds(events, arrangementId);

  // Find LAST 0xE9 in arrangement scope.
  let lastBlobIdx = -1;
  for (let i = openIdx + 1; i < endIdx; i++) {
    const ev = events[i]!;
    if (ev.kind === "blob" && ev.opcode === OP_PLAYLIST) {
      lastBlobIdx = i;
    }
  }

  if (lastBlobIdx === -1) {
    // No playlist blob yet — insert one before the next arrangement
    // (or at end of arrangement scope).
    events.splice(endIdx, 0, { kind: "blob", opcode: OP_PLAYLIST, payload: newRecord });
    return { ...project, events };
  }
  const orig = events[lastBlobIdx]!;
  if (orig.kind !== "blob") throw new MutationError("UNKNOWN", "0xE9 not blob");
  // Append: concat originalPayload + newRecord. Preserves every byte
  // of every existing record verbatim.
  const merged = new Uint8Array(orig.payload.byteLength + newRecord.byteLength);
  merged.set(orig.payload, 0);
  merged.set(newRecord, orig.payload.byteLength);
  events[lastBlobIdx] = { kind: "blob", opcode: OP_PLAYLIST, payload: merged };
  return { ...project, events };
}

export type ClipMatch = {
  /** Match clips on this track (FL display order, 0 = top). Required. */
  track_index: number;
  /** Match only clips at exactly this tick position. Optional. */
  position_ticks?: number;
  /** Match only clips referencing this pattern id (>0) or channel iid. Optional. */
  ref_id?: number;
  /** Disambiguates ref_id resolution when pattern_id / channel_iid overlap. Optional. */
  kind?: "pattern" | "channel";
};

function clipMatches(
  match: ClipMatch,
  recordPosition: number,
  recordItemIndex: number,
  recordTrackRvidx: number,
): boolean {
  if (resolveTrackRvidx(match.track_index) !== recordTrackRvidx) return false;
  if (match.position_ticks !== undefined && match.position_ticks !== recordPosition) {
    return false;
  }
  if (match.ref_id !== undefined) {
    const isPattern = recordItemIndex > PATTERN_BASE;
    const recordRef = isPattern ? recordItemIndex - PATTERN_BASE : recordItemIndex;
    if (match.kind !== undefined) {
      const expectedKind = isPattern ? "pattern" : "channel";
      if (match.kind !== expectedKind) return false;
    }
    if (match.ref_id !== recordRef) return false;
  }
  return true;
}

/**
 * Drop ALL playlist clips matching `match` from arrangement
 * `arrangementId`. Returns the unchanged project if no matches.
 */
export function removeClip(
  project: FLPProject,
  arrangementId: number,
  match: ClipMatch,
): FLPProject {
  const events = [...project.events];
  const { openIdx, endIdx } = findArrangementBounds(events, arrangementId);
  let touched = false;

  for (let i = openIdx + 1; i < endIdx; i++) {
    const ev = events[i]!;
    if (ev.kind !== "blob" || ev.opcode !== OP_PLAYLIST) continue;
    const recordSize =
      ev.payload.byteLength % 60 === 0 ? 60 : ev.payload.byteLength % 32 === 0 ? 32 : 0;
    if (recordSize === 0) continue;
    const view = new DataView(
      ev.payload.buffer,
      ev.payload.byteOffset,
      ev.payload.byteLength,
    );
    const keepRecords: Uint8Array[] = [];
    let dropped = false;
    for (let p = 0; p + recordSize <= ev.payload.byteLength; p += recordSize) {
      const pos = view.getUint32(p, true);
      const itemIdx = view.getUint16(p + 6, true);
      const trackRv = view.getUint16(p + 12, true);
      if (clipMatches(match, pos, itemIdx, trackRv)) {
        dropped = true;
        continue;
      }
      keepRecords.push(ev.payload.slice(p, p + recordSize));
    }
    if (!dropped) continue;
    touched = true;
    if (keepRecords.length === 0) {
      // Drop the entire blob (no clips left in this 0xE9).
      events.splice(i, 1);
      i -= 1; // re-scan adjacent
      continue;
    }
    const merged = new Uint8Array(keepRecords.reduce((s, r) => s + r.byteLength, 0));
    let off = 0;
    for (const r of keepRecords) {
      merged.set(r, off);
      off += r.byteLength;
    }
    events[i] = { kind: "blob", opcode: OP_PLAYLIST, payload: merged };
  }

  if (!touched) {
    throw new MutationError(
      "EVENT_NOT_FOUND",
      `no clips matched in arrangement ${arrangementId}`,
    );
  }
  return { ...project, events };
}

/**
 * Move clips matching `match` to a new track and/or position. Patches
 * the existing record bytes in place — preserves all reserved fields.
 */
export function moveClip(
  project: FLPProject,
  arrangementId: number,
  match: ClipMatch,
  to: { track_index?: number; position_ticks?: number },
): FLPProject {
  if (to.track_index === undefined && to.position_ticks === undefined) {
    throw new MutationError(
      "INVALID_ARGS",
      "moveClip requires at least one of {track_index, position_ticks}",
    );
  }
  if (to.position_ticks !== undefined && (!Number.isInteger(to.position_ticks) || to.position_ticks < 0)) {
    throw new MutationError("INVALID_ARGS", "to.position_ticks must be non-negative integer");
  }
  const newRvidx = to.track_index !== undefined ? resolveTrackRvidx(to.track_index) : undefined;

  const events = [...project.events];
  const { openIdx, endIdx } = findArrangementBounds(events, arrangementId);
  let touched = false;

  for (let i = openIdx + 1; i < endIdx; i++) {
    const ev = events[i]!;
    if (ev.kind !== "blob" || ev.opcode !== OP_PLAYLIST) continue;
    const recordSize =
      ev.payload.byteLength % 60 === 0 ? 60 : ev.payload.byteLength % 32 === 0 ? 32 : 0;
    if (recordSize === 0) continue;
    const newPayload = new Uint8Array(ev.payload);
    const view = new DataView(newPayload.buffer, newPayload.byteOffset, newPayload.byteLength);
    let blobTouched = false;
    for (let p = 0; p + recordSize <= newPayload.byteLength; p += recordSize) {
      const pos = view.getUint32(p, true);
      const itemIdx = view.getUint16(p + 6, true);
      const trackRv = view.getUint16(p + 12, true);
      if (!clipMatches(match, pos, itemIdx, trackRv)) continue;
      if (to.position_ticks !== undefined) view.setUint32(p, to.position_ticks, true);
      if (newRvidx !== undefined) view.setUint16(p + 12, newRvidx, true);
      blobTouched = true;
      touched = true;
    }
    if (blobTouched) {
      events[i] = { kind: "blob", opcode: OP_PLAYLIST, payload: newPayload };
    }
  }
  if (!touched) {
    throw new MutationError(
      "EVENT_NOT_FOUND",
      `no clips matched in arrangement ${arrangementId}`,
    );
  }
  return { ...project, events };
}

// --------------------------------------------------------------------------- //
// helpers
// --------------------------------------------------------------------------- //

function encodeUtf16LeNullTerminated(s: string): Uint8Array {
  const out = new Uint8Array((s.length + 1) * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++) {
    view.setUint16(i * 2, s.charCodeAt(i), true);
  }
  // Trailing UTF-16LE NUL is two zero bytes (already 0 from Uint8Array init).
  return out;
}

// Re-export the type discriminator for testing convenience.
export type { FLPEvent };

// --------------------------------------------------------------------------- //
// F2.1 — Pattern notes encoder (0xE0)                                          //
// --------------------------------------------------------------------------- //

const NOTE_RECORD_SIZE = 24;

/**
 * Encode a single `Note` to its 24-byte on-disk record (opcode `0xE0`
 * payload format). Inverse of `decodeNotes` in `model/pattern.ts`.
 *
 * Throws `MutationError` with code `INVALID_ARGS` on out-of-range
 * fields (key `[0,131]`, position/length non-negative, channel_iid u16).
 */
export function encodeNote(note: Note): Uint8Array {
  if (!Number.isInteger(note.position) || note.position < 0 || note.position > 0xffffffff) {
    throw new MutationError(
      "INVALID_ARGS",
      `note.position must be u32, got ${note.position}`,
    );
  }
  if (!Number.isInteger(note.length) || note.length < 0 || note.length > 0xffffffff) {
    throw new MutationError("INVALID_ARGS", `note.length must be u32, got ${note.length}`);
  }
  if (!Number.isInteger(note.channel_iid) || note.channel_iid < 0 || note.channel_iid > 0xffff) {
    throw new MutationError(
      "INVALID_ARGS",
      `note.channel_iid must be u16 (0..65535), got ${note.channel_iid}`,
    );
  }
  if (!Number.isInteger(note.key) || note.key < 0 || note.key > 131) {
    throw new MutationError(
      "INVALID_ARGS",
      `note.key must be in [0, 131] (FL MIDI range), got ${note.key}`,
    );
  }

  const buf = new Uint8Array(NOTE_RECORD_SIZE);
  const view = new DataView(buf.buffer);
  view.setUint32(0, note.position, true);
  view.setUint16(4, (note.flags ?? 0) & 0xffff, true);
  view.setUint16(6, note.channel_iid, true);
  view.setUint32(8, note.length, true);
  view.setUint16(12, note.key, true);
  view.setUint16(14, (note.group ?? 0) & 0xffff, true);
  buf[16] = (note.fine_pitch ?? 120) & 0xff;
  // byte 17 reserved (left as 0)
  buf[18] = (note.release ?? 64) & 0xff;
  buf[19] = (note.midi_channel ?? 0) & 0xff;
  buf[20] = (note.pan ?? 64) & 0xff;
  buf[21] = (note.velocity ?? 100) & 0xff;
  buf[22] = (note.mod_x ?? 128) & 0xff;
  buf[23] = (note.mod_y ?? 128) & 0xff;
  return buf;
}

function encodePatternNotes(notes: readonly Note[]): Uint8Array {
  const out = new Uint8Array(notes.length * NOTE_RECORD_SIZE);
  for (let i = 0; i < notes.length; i++) {
    out.set(encodeNote(notes[i]!), i * NOTE_RECORD_SIZE);
  }
  return out;
}

/**
 * Locate a pattern's event-stream scope: the slice from its `0x41`
 * marker through the byte before the next pattern boundary
 * (next `0x41` or the start of the arrangement section `0x63`, whichever
 * comes first). Returns `null` if the pattern doesn't exist.
 */
function findPatternScope(
  events: readonly FLPEvent[],
  patternId: number,
): { startIdx: number; endIdx: number } | null {
  let start = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "u16" && ev.opcode === OP_PATTERN_NEW && ev.value === patternId) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  for (let i = start + 1; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "u16" && ev.opcode === OP_PATTERN_NEW) return { startIdx: start, endIdx: i };
    if (ev.kind === "u16" && ev.opcode === OP_ARRANGEMENT_NEW) {
      return { startIdx: start, endIdx: i };
    }
  }
  return { startIdx: start, endIdx: events.length };
}

function collectExistingNotes(events: readonly FLPEvent[], scope: {
  startIdx: number;
  endIdx: number;
}): Note[] {
  const out: Note[] = [];
  for (let i = scope.startIdx + 1; i < scope.endIdx; i++) {
    const ev = events[i]!;
    if (ev.kind === "blob" && ev.opcode === OP_PATTERN_NOTES) {
      for (const n of decodeNotes(ev.payload)) out.push(n);
    }
  }
  return out;
}

/**
 * Replace every note on `patternId` with `notes`. All existing
 * `0xE0` events inside the pattern's scope are dropped; if `notes` is
 * non-empty a single concatenated `0xE0` is inserted right after the
 * pattern's `0xC1` name event (or right after its `0x41` marker if the
 * pattern has no name event).
 *
 * Throws `EVENT_NOT_FOUND` if the pattern id doesn't exist, and
 * `INVALID_ARGS` for non-positive `patternId` or invalid note records
 * (caught by `encodeNote`).
 */
export function setPatternNotes(
  project: FLPProject,
  patternId: number,
  notes: readonly Note[],
): FLPProject {
  if (!Number.isInteger(patternId) || patternId < 1) {
    throw new MutationError(
      "INVALID_ARGS",
      `pattern id must be a positive integer (1-based), got ${patternId}`,
    );
  }
  const scope = findPatternScope(project.events, patternId);
  if (!scope) {
    throw new MutationError("EVENT_NOT_FOUND", `no pattern with id=${patternId} found`);
  }

  // Validate-encode upfront so a single bad note doesn't leave the
  // project half-mutated; the encoded payload also gets reused below.
  const encoded = notes.length > 0 ? encodePatternNotes(notes) : null;

  // Drop existing 0xE0 events inside the target scope.
  const events: FLPEvent[] = [];
  for (let i = 0; i < project.events.length; i++) {
    const ev = project.events[i]!;
    if (i > scope.startIdx && i < scope.endIdx && ev.opcode === OP_PATTERN_NOTES) continue;
    events.push(ev);
  }

  if (encoded === null) return { ...project, events };

  // The scope shifts when we drop events; re-locate.
  const newScope = findPatternScope(events, patternId)!;
  let insertAt = newScope.startIdx + 1;
  for (let i = newScope.startIdx + 1; i < newScope.endIdx; i++) {
    if (events[i]!.opcode === OP_PATTERN_NAME) {
      insertAt = i + 1;
      break;
    }
  }
  events.splice(insertAt, 0, { kind: "blob", opcode: OP_PATTERN_NOTES, payload: encoded });
  return { ...project, events };
}

/**
 * Append one note to a pattern. Existing notes are preserved; the new
 * note is added at the end of the (rewritten, single) `0xE0` blob.
 *
 * Note: this rewrites the pattern's notes blob to a single `0xE0`
 * record even if the source had multiple consecutive `0xE0` events
 * (FL emits one but reads concatenations correctly). Reading round-
 * trips identically.
 */
export function addPatternNote(
  project: FLPProject,
  patternId: number,
  note: Note,
): FLPProject {
  if (!Number.isInteger(patternId) || patternId < 1) {
    throw new MutationError(
      "INVALID_ARGS",
      `pattern id must be a positive integer (1-based), got ${patternId}`,
    );
  }
  const scope = findPatternScope(project.events, patternId);
  if (!scope) {
    throw new MutationError("EVENT_NOT_FOUND", `no pattern with id=${patternId} found`);
  }
  // Validate eagerly — throws INVALID_ARGS on bad note.
  encodeNote(note);
  const existing = collectExistingNotes(project.events, scope);
  return setPatternNotes(project, patternId, [...existing, note]);
}

/**
 * Remove a note from a pattern. `selector` is either a 0-based index
 * into the existing note list or a predicate `(note, index) => boolean`
 * that returns `true` for every note that should be removed.
 *
 * Throws `INVALID_ARGS` if `selector` is a number out of range,
 * `EVENT_NOT_FOUND` if the pattern id doesn't exist.
 */
export function removePatternNote(
  project: FLPProject,
  patternId: number,
  selector: number | ((note: Note, index: number) => boolean),
): FLPProject {
  if (!Number.isInteger(patternId) || patternId < 1) {
    throw new MutationError(
      "INVALID_ARGS",
      `pattern id must be a positive integer (1-based), got ${patternId}`,
    );
  }
  const scope = findPatternScope(project.events, patternId);
  if (!scope) {
    throw new MutationError("EVENT_NOT_FOUND", `no pattern with id=${patternId} found`);
  }
  const existing = collectExistingNotes(project.events, scope);

  let kept: Note[];
  if (typeof selector === "number") {
    if (!Number.isInteger(selector) || selector < 0 || selector >= existing.length) {
      throw new MutationError(
        "INVALID_ARGS",
        `note index ${selector} out of range [0, ${existing.length})`,
      );
    }
    kept = existing.filter((_, i) => i !== selector);
  } else {
    kept = existing.filter((n, i) => !selector(n, i));
  }
  return setPatternNotes(project, patternId, kept);
}

// --------------------------------------------------------------------------- //
// F2.2 — Pattern controllers encoder (0xDF)                                    //
// --------------------------------------------------------------------------- //

const CONTROLLER_RECORD_SIZE = 12;

/**
 * Encode a single `Controller` to its 12-byte on-disk record (opcode
 * `0xDF` payload format). Inverse of `decodeControllers` in
 * `model/pattern.ts`.
 *
 * Layout (per PyFLP `ControllerEvent.STRUCT` cross-checked against
 * decoder; cumulative end offsets corrected per D-45):
 *   bytes 0-3: position (uint32 LE)
 *   bytes 4-5: reserved (zero — PyFLP `_u1` + `_u2`)
 *   byte 6:    channel (uint8)
 *   byte 7:    flags (uint8)
 *   bytes 8-11: value (float32 LE)
 */
export function encodeController(controller: Controller): Uint8Array {
  if (
    !Number.isInteger(controller.position) ||
    controller.position < 0 ||
    controller.position > 0xffffffff
  ) {
    throw new MutationError(
      "INVALID_ARGS",
      `controller.position must be u32, got ${controller.position}`,
    );
  }
  if (!Number.isInteger(controller.channel) || controller.channel < 0 || controller.channel > 255) {
    throw new MutationError(
      "INVALID_ARGS",
      `controller.channel must be u8 (0..255), got ${controller.channel}`,
    );
  }
  if (!Number.isInteger(controller.flags) || controller.flags < 0 || controller.flags > 255) {
    throw new MutationError(
      "INVALID_ARGS",
      `controller.flags must be u8 (0..255), got ${controller.flags}`,
    );
  }
  if (!Number.isFinite(controller.value)) {
    throw new MutationError(
      "INVALID_ARGS",
      `controller.value must be a finite float, got ${controller.value}`,
    );
  }

  const buf = new Uint8Array(CONTROLLER_RECORD_SIZE);
  const view = new DataView(buf.buffer);
  view.setUint32(0, controller.position, true);
  // bytes 4-5 reserved (left as 0)
  buf[6] = controller.channel & 0xff;
  buf[7] = controller.flags & 0xff;
  view.setFloat32(8, controller.value, true);
  return buf;
}

function encodePatternControllers(controllers: readonly Controller[]): Uint8Array {
  const out = new Uint8Array(controllers.length * CONTROLLER_RECORD_SIZE);
  for (let i = 0; i < controllers.length; i++) {
    out.set(encodeController(controllers[i]!), i * CONTROLLER_RECORD_SIZE);
  }
  return out;
}

function collectExistingControllers(
  events: readonly FLPEvent[],
  scope: { startIdx: number; endIdx: number },
): Controller[] {
  const out: Controller[] = [];
  for (let i = scope.startIdx + 1; i < scope.endIdx; i++) {
    const ev = events[i]!;
    if (ev.kind === "blob" && ev.opcode === OP_PATTERN_CONTROLLERS) {
      for (const c of decodeControllers(ev.payload)) out.push(c);
    }
  }
  return out;
}

/**
 * Replace every controller record on `patternId` with `controllers`.
 * All existing `0xDF` events inside the pattern's scope are dropped;
 * if `controllers` is non-empty a single concatenated `0xDF` is
 * inserted right after the pattern's `0xC1` name (or after `0x41` if
 * no name exists). Mirrors the `setPatternNotes` shape.
 *
 * Throws `EVENT_NOT_FOUND` for unknown pattern, `INVALID_ARGS` for
 * non-positive `patternId` or invalid controller fields.
 */
export function setPatternControllers(
  project: FLPProject,
  patternId: number,
  controllers: readonly Controller[],
): FLPProject {
  if (!Number.isInteger(patternId) || patternId < 1) {
    throw new MutationError(
      "INVALID_ARGS",
      `pattern id must be a positive integer (1-based), got ${patternId}`,
    );
  }
  const scope = findPatternScope(project.events, patternId);
  if (!scope) {
    throw new MutationError("EVENT_NOT_FOUND", `no pattern with id=${patternId} found`);
  }

  const encoded = controllers.length > 0 ? encodePatternControllers(controllers) : null;

  const events: FLPEvent[] = [];
  for (let i = 0; i < project.events.length; i++) {
    const ev = project.events[i]!;
    if (i > scope.startIdx && i < scope.endIdx && ev.opcode === OP_PATTERN_CONTROLLERS) continue;
    events.push(ev);
  }

  if (encoded === null) return { ...project, events };

  const newScope = findPatternScope(events, patternId)!;
  let insertAt = newScope.startIdx + 1;
  for (let i = newScope.startIdx + 1; i < newScope.endIdx; i++) {
    if (events[i]!.opcode === OP_PATTERN_NAME) {
      insertAt = i + 1;
      break;
    }
  }
  events.splice(insertAt, 0, {
    kind: "blob",
    opcode: OP_PATTERN_CONTROLLERS,
    payload: encoded,
  });
  return { ...project, events };
}

/**
 * Append one controller event to a pattern. Existing controllers are
 * preserved; the rewritten payload coalesces every controller into a
 * single `0xDF` blob (FL emits one but reads concatenations).
 */
export function addPatternController(
  project: FLPProject,
  patternId: number,
  controller: Controller,
): FLPProject {
  if (!Number.isInteger(patternId) || patternId < 1) {
    throw new MutationError(
      "INVALID_ARGS",
      `pattern id must be a positive integer (1-based), got ${patternId}`,
    );
  }
  const scope = findPatternScope(project.events, patternId);
  if (!scope) {
    throw new MutationError("EVENT_NOT_FOUND", `no pattern with id=${patternId} found`);
  }
  encodeController(controller);
  const existing = collectExistingControllers(project.events, scope);
  return setPatternControllers(project, patternId, [...existing, controller]);
}

/**
 * Remove a controller from a pattern. `selector` is either a 0-based
 * index into the existing controller list or a predicate
 * `(controller, index) => boolean` that returns true for every
 * controller to drop.
 */
export function removePatternController(
  project: FLPProject,
  patternId: number,
  selector: number | ((controller: Controller, index: number) => boolean),
): FLPProject {
  if (!Number.isInteger(patternId) || patternId < 1) {
    throw new MutationError(
      "INVALID_ARGS",
      `pattern id must be a positive integer (1-based), got ${patternId}`,
    );
  }
  const scope = findPatternScope(project.events, patternId);
  if (!scope) {
    throw new MutationError("EVENT_NOT_FOUND", `no pattern with id=${patternId} found`);
  }
  const existing = collectExistingControllers(project.events, scope);

  let kept: Controller[];
  if (typeof selector === "number") {
    if (!Number.isInteger(selector) || selector < 0 || selector >= existing.length) {
      throw new MutationError(
        "INVALID_ARGS",
        `controller index ${selector} out of range [0, ${existing.length})`,
      );
    }
    kept = existing.filter((_, i) => i !== selector);
  } else {
    kept = existing.filter((c, i) => !selector(c, i));
  }
  return setPatternControllers(project, patternId, kept);
}

// --------------------------------------------------------------------------- //
// F2.3 — Pattern + channel creation                                            //
// --------------------------------------------------------------------------- //

const OP_CHANNEL_TYPE = 0x15; // u8: 0=sampler, 2/4=instrument, 3=layer, 5=automation
const OP_PLUGIN_INTERNAL_NAME = 0xc9; // text blob (UTF-16LE)

/**
 * Channel kind input accepted by `createChannel`. Maps to the on-disk
 * `0x15` u8 byte. `"sampler"` is the safe default (FL's built-in
 * sampler renders fine with no plugin attached). Other kinds require
 * additional opcodes (instrument plugin state, automation point
 * stream, layer membership) that this v1 helper does NOT emit — for
 * those, clone an existing channel via a different helper.
 */
export type ChannelKindInput = "sampler" | "instrument" | "automation" | "layer";

const _CHANNEL_KIND_TO_BYTE: Record<ChannelKindInput, number> = {
  sampler: 0,
  instrument: 2,
  layer: 3,
  automation: 5,
};

/**
 * Find a safe insertion index for a NEW pattern or channel scope:
 * just before the first `0x63` (arrangement opener). All FL 25 saves
 * place patterns + channels before arrangements; mixer events come
 * after. If no `0x63` exists (rare; corrupted or pre-arrangement
 * snapshot), fall back to end-of-events.
 */
function findInsertionBeforeArrangements(events: readonly FLPEvent[]): number {
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "u16" && ev.opcode === OP_ARRANGEMENT_NEW) return i;
  }
  return events.length;
}

function nextPatternId(events: readonly FLPEvent[]): number {
  let max = 0;
  for (const ev of events) {
    if (ev.kind === "u16" && ev.opcode === OP_PATTERN_NEW && ev.value > max) max = ev.value;
  }
  return max + 1;
}

function nextChannelIid(events: readonly FLPEvent[]): number {
  let max = -1;
  for (const ev of events) {
    if (ev.kind === "u16" && ev.opcode === OP_NEW_CHANNEL && ev.value > max) max = ev.value;
  }
  // Channels are 0-indexed; if none exist, the next is 0. Otherwise max + 1.
  return max + 1;
}

/**
 * Create a brand-new empty pattern. Returns `{project, id}` where
 * `id` is the assigned pattern id (one greater than the current max,
 * never reused even if there are gaps from deletions).
 *
 * Minimum on-disk shape: `[0x41 newId u16, 0xC1 name blob]`. FL
 * fills in defaults for length / color / looped / notes / controllers
 * on read.
 *
 * Insertion point: just before the first `0x63` (arrangement opener).
 * The pattern shows up in the FL pattern selector after a re-load.
 */
export function createPattern(
  project: FLPProject,
  opts: { name?: string } = {},
): { project: FLPProject; id: number } {
  const name = opts.name ?? "";
  if (typeof name !== "string") {
    throw new MutationError("INVALID_ARGS", `opts.name must be a string when provided`);
  }
  if (name.length > 256) {
    throw new MutationError("INVALID_ARGS", `opts.name too long (${name.length} chars, max 256)`);
  }

  const newId = nextPatternId(project.events);
  const insertAt = findInsertionBeforeArrangements(project.events);

  const newEvents: FLPEvent[] = [
    { kind: "u16", opcode: OP_PATTERN_NEW, value: newId },
    {
      kind: "blob",
      opcode: OP_PATTERN_NAME,
      payload: encodeUtf16LeNullTerminated(name),
    },
  ];

  const events = [...project.events];
  events.splice(insertAt, 0, ...newEvents);
  return { project: { ...project, events }, id: newId };
}

/**
 * Create a brand-new empty channel. Returns `{project, iid}` where
 * `iid` is the assigned channel iid (one greater than the current max).
 *
 * Minimum on-disk shape: `[0x40 newIid u16, 0x15 kindByte u8, 0xCB
 * name blob]`. The `0x15` byte tells FL the channel kind (defaults to
 * sampler = `0` so FL renders the built-in sampler with no plugin
 * required). Other kinds (instrument / automation / layer) need
 * additional supporting opcodes that this v1 helper does NOT emit —
 * clone an existing channel of that kind instead.
 *
 * The legacy `header.n_channels` u16 is intentionally NOT bumped:
 * modern FL writes 0 there and the channel count is derived from the
 * event stream (see `flpdiff/src/parser/flp-project.ts:14-18`).
 *
 * Insertion point: just before the first `0x63` (arrangement opener).
 */
export function createChannel(
  project: FLPProject,
  opts: { name?: string; kind?: ChannelKindInput } = {},
): { project: FLPProject; iid: number } {
  const name = opts.name ?? "";
  const kind = opts.kind ?? "sampler";
  if (typeof name !== "string") {
    throw new MutationError("INVALID_ARGS", `opts.name must be a string when provided`);
  }
  if (name.length > 256) {
    throw new MutationError("INVALID_ARGS", `opts.name too long (${name.length} chars, max 256)`);
  }
  if (!(kind in _CHANNEL_KIND_TO_BYTE)) {
    throw new MutationError(
      "INVALID_ARGS",
      `opts.kind must be one of: sampler, instrument, automation, layer (got ${kind})`,
    );
  }

  const newIid = nextChannelIid(project.events);
  if (newIid > 0xffff) {
    throw new MutationError(
      "EVENT_NOT_FOUND",
      `cannot allocate new channel iid: max u16 (${0xffff}) reached`,
    );
  }

  const insertAt = findInsertionBeforeArrangements(project.events);

  const newEvents: FLPEvent[] = [
    { kind: "u16", opcode: OP_NEW_CHANNEL, value: newIid },
    { kind: "u8", opcode: OP_CHANNEL_TYPE, value: _CHANNEL_KIND_TO_BYTE[kind] },
    {
      kind: "blob",
      opcode: OP_NAME,
      payload: encodeUtf16LeNullTerminated(name),
    },
  ];

  // For instrument kind, emit an empty plugin-internal-name slot so FL
  // recognises the channel as a placeholder for a future plugin. Sampler
  // doesn't need it.
  if (kind === "instrument") {
    newEvents.splice(2, 0, {
      kind: "blob",
      opcode: OP_PLUGIN_INTERNAL_NAME,
      payload: encodeUtf16LeNullTerminated(""),
    });
  }

  const events = [...project.events];
  events.splice(insertAt, 0, ...newEvents);
  return { project: { ...project, events }, iid: newIid };
}

// --------------------------------------------------------------------------- //
// F2.4 — Native plugin parameters (Fruity Parametric EQ 2 prototype)           //
// --------------------------------------------------------------------------- //

const OP_PLUGIN_STATE = 0xd5;
const OP_NEW_SLOT = 0x62;
const OP_PLUGIN_NAME_IN_MIXER_SCOPE = OP_NAME; // 0xCB - in mixer-slot scope, this is the plugin name

/**
 * Field within a Fruity Parametric EQ 2 band that can be mutated.
 * `level` / `freq` / `width` are uint16-scaled (`round(v * 0xFFFF)`);
 * `type` / `order` are uint8 enums (deferred — pass an integer 0..7
 * via the `enum_value` variant of `ParamRef` once added).
 */
export type EQ2BandField = "level" | "freq" | "width";

/**
 * Generic param reference: an integer parameter index. Maps directly
 * to FL's `plugins.setParamValue(value, paramIndex, ...)` numbering.
 * The plugin's layout entry tells the encoder which byte offset that
 * index targets and which field type to write.
 *
 * EQ 2 also accepts the structured `main_level` / `band` refs; new
 * plugin layouts authored via the auto-sweep tool emit generic
 * `{kind:"param", index}` only.
 */
export type PluginParamRef =
  | { kind: "main_level" }
  | { kind: "band"; band: number; field: EQ2BandField }
  | { kind: "param"; index: number };

export type PluginScope =
  | { kind: "channel"; channelIid: number }
  | { kind: "mixer_slot"; insertIndex: number; slotIndex: number };

/**
 * Per-plugin byte-offset map. `paramRefToOffset` returns
 * `{offset, fieldType}` where `fieldType` controls how the
 * normalized 0..1 value gets scaled to bytes.
 */
type PluginLayout = {
  /** Minimum payload size that includes every parameter offset.
   *  Trailing state past this point is opaque and may vary across FL
   *  versions — accept any payload >= this. */
  minSize: number;
  /** Maximum tolerated size — keeps the check from blessing arbitrary
   *  unrelated blobs as the same plugin. */
  maxSize: number;
  paramRefToOffset: (
    ref: PluginParamRef,
  ) =>
    | {
        offset: number;
        fieldType: "u8" | "u16" | "u32" | "f32" | "i32_bipolar";
        /** Required when `fieldType === "i32_bipolar"`. The stored
         *  int32 LE = `round((normalized * 2 - 1) * scale)` so that
         *  `0.0 → -scale`, `0.5 → 0`, `1.0 → +scale`. */
        scale?: number;
      }
    | null;
};

const EQ2_LAYOUT: PluginLayout = {
  // Last param byte is at offset 0x91 (main level high byte). Anything
  // smaller is missing parameter slots; refuse. FL 25.2.4 emits 354;
  // older FL saves emit 350 (4 fewer bytes of trailing state). 500 is
  // a generous upper bound that still rejects unrelated blobs.
  minSize: 0x92,
  maxSize: 500,
  paramRefToOffset: (ref) => {
    if (ref.kind === "main_level") return { offset: 0x90, fieldType: "u16" };
    if (ref.kind === "band") {
      if (!Number.isInteger(ref.band) || ref.band < 1 || ref.band > 7) return null;
      const slot = (ref.band - 1) * 4;
      if (ref.field === "level") return { offset: 0x04 + slot, fieldType: "u16" };
      if (ref.field === "freq") return { offset: 0x20 + slot, fieldType: "u16" };
      if (ref.field === "width") return { offset: 0x3c + slot, fieldType: "u16" };
    }
    return null;
  },
};

/**
 * Registry of native FL plugins whose parameter layout has been
 * reverse-engineered well enough to support direct byte-patching.
 *
 * Keys are the exact plugin-name strings FL emits via the `0xCB`
 * (mixer slot scope) or via `0xC9` plugin-internal-name. FL 25.2.4
 * inconsistently uses lowercase `parametric` — we register both.
 */
/**
 * Fruity Reeverb 2 layout — 15 params, RE'd via `sweep_plugin_layout.py`
 * 2026-05-09 against insert 22 slot 0 of listen-to-my-synthesizer.flp.
 *
 * Real-corpus blob size: 66 bytes (280/280 user-saved instances).
 * Freshly-instantiated Reeverb 2 emits a 58-byte minimal blob — first
 * param touch grows it to canonical 66. minSize=66 here keeps the
 * encoder strict against half-formed blobs.
 *
 * Param 9 (Stereo separation) is a 4-byte slot at 0x28, encoded as
 * `i32_bipolar` LE with scale=64 (verified via FL round-trip
 * 2026-05-09): 0.0 → -64, 0.5 → 0, 1.0 → +64.
 *
 * **Scale caveat (v1 limitation):** unlike EQ 2 which uniformly stores
 * params as `round(v * 0xFFFF)`, Reeverb 2 mixes encodings — some
 * params (Bass multiplier, Crossover, Stereo separation) appear to be
 * normalized 0..0xFFFF; others (Low cut, High cut, Predelay) store
 * raw frequency / time values. The encoder still applies the universal
 * `round(v * 0xFFFF)` (u16) / `round(v * 0xFF)` (u8) mapping; users
 * who need exact Hz / ms values must compute the normalized fraction
 * themselves. Future: per-param scale curves in the layout entry.
 */
const REEVERB2_LAYOUT: PluginLayout = {
  minSize: 66,
  maxSize: 116,
  paramRefToOffset: (ref) => {
    if (ref.kind !== "param") return null;
    if (ref.index === 0) return { offset: 0x04, fieldType: "u16" }; // Low cut (Hz)
    if (ref.index === 1) return { offset: 0x08, fieldType: "u8" };  // High cut
    if (ref.index === 2) return { offset: 0x0c, fieldType: "u16" }; // Predelay
    if (ref.index === 3) return { offset: 0x10, fieldType: "u8" };  // Room size
    if (ref.index === 4) return { offset: 0x14, fieldType: "u8" };  // Diffusion
    if (ref.index === 5) return { offset: 0x18, fieldType: "u8" };  // Decay time
    if (ref.index === 6) return { offset: 0x1c, fieldType: "u8" };  // High damping
    if (ref.index === 7) return { offset: 0x20, fieldType: "u16" }; // Bass multiplier
    if (ref.index === 8) return { offset: 0x24, fieldType: "u16" }; // Crossover
    // Param 9 (Stereo separation) — i32 LE bipolar, scale 64.
    // 0.0 → -64, 0.5 → 0, 1.0 → +64. Verified via FL round-trip
    // 2026-05-09 against synthesized fixture (h3_ys_64 donor).
    if (ref.index === 9) return { offset: 0x28, fieldType: "i32_bipolar", scale: 64 }; // Stereo separation
    if (ref.index === 10) return { offset: 0x2c, fieldType: "u8" }; // Dry level
    if (ref.index === 11) return { offset: 0x30, fieldType: "u8" }; // Early reflection level
    if (ref.index === 12) return { offset: 0x34, fieldType: "u8" }; // Wet level
    if (ref.index === 13) return { offset: 0x39, fieldType: "u8" }; // Mod Speed
    if (ref.index === 14) return { offset: 0x3d, fieldType: "u8" }; // Mod Depth
    return null;
  },
};

/**
 * Fruity Limiter layout — 18 params, RE'd via `sweep_plugin_layout.py`
 * 2026-05-09 against synthesized `base_limiter.flp` (base_empty +
 * junie's master slot 7 spliced via `craft-plugin-fixture.ts`).
 *
 * Real-corpus coverage: every Fruity Limiter saved-once instance is
 * 169 bytes. minSize=169 (strict). maxSize=219 (50-byte tolerance for
 * future FL versions adding trailing state).
 *
 * Param 9 (Comp ratio) and param 10 (Comp knee) write 4 bytes each
 * encoded as `i32_bipolar` LE with scale=1000 (verified via FL
 * round-trip 2026-05-09): 0.0 → -1000, 0.5 → 0, 1.0 → +1000.
 * The other 16 params are u8/u16 LE and write cleanly via
 * `round(v * 0xFF)` / `round(v * 0xFFFF)`.
 */
const LIMITER_LAYOUT: PluginLayout = {
  minSize: 169,
  maxSize: 219,
  paramRefToOffset: (ref) => {
    if (ref.kind !== "param") return null;
    if (ref.index === 0) return { offset: 0x04, fieldType: "u16" }; // Gain
    if (ref.index === 1) return { offset: 0x08, fieldType: "u16" }; // Soft saturation threshold
    if (ref.index === 2) return { offset: 0x0c, fieldType: "u16" }; // Limiter ceiling
    if (ref.index === 3) return { offset: 0x10, fieldType: "u16" }; // Limiter attack time
    if (ref.index === 4) return { offset: 0x14, fieldType: "u8" };  // Limiter attack curve
    if (ref.index === 5) return { offset: 0x18, fieldType: "u16" }; // Limiter release time
    if (ref.index === 6) return { offset: 0x1c, fieldType: "u8" };  // Limiter release curve
    if (ref.index === 7) return { offset: 0x20, fieldType: "u16" }; // Limiter peak window
    if (ref.index === 8) return { offset: 0x24, fieldType: "u16" }; // Comp threshold
    // Params 9 (Comp ratio) + 10 (Comp knee) — i32 LE bipolar, scale
    // 1000. 0.0 → -1000, 0.5 → 0, 1.0 → +1000. Verified via FL
    // round-trip 2026-05-09 against /tmp/probe_limiter.flp.
    if (ref.index === 9) return { offset: 0x28, fieldType: "i32_bipolar", scale: 1000 }; // Comp ratio
    if (ref.index === 10) return { offset: 0x2c, fieldType: "i32_bipolar", scale: 1000 }; // Comp knee
    if (ref.index === 11) return { offset: 0x30, fieldType: "u16" }; // Comp attack time
    if (ref.index === 12) return { offset: 0x34, fieldType: "u16" }; // Comp release time
    if (ref.index === 13) return { offset: 0x38, fieldType: "u8" };  // Comp curve
    if (ref.index === 14) return { offset: 0x3c, fieldType: "u16" }; // Comp RMS window
    if (ref.index === 15) return { offset: 0x40, fieldType: "u16" }; // Noise gain
    if (ref.index === 16) return { offset: 0x44, fieldType: "u16" }; // Noise threshold
    if (ref.index === 17) return { offset: 0x48, fieldType: "u16" }; // Noise release time
    return null;
  },
};

const PLUGIN_PARAM_LAYOUTS: Record<string, PluginLayout> = {
  "Fruity Parametric EQ 2": EQ2_LAYOUT,
  "Fruity parametric EQ 2": EQ2_LAYOUT,
  "Fruity Reeverb 2": REEVERB2_LAYOUT,
  "Fruity reeverb 2": REEVERB2_LAYOUT,
  "Fruity Limiter": LIMITER_LAYOUT,
};

/**
 * Find the index of the `0xD5` (plugin state) event for a given
 * `PluginScope`, plus the plugin name observed at that scope. Returns
 * `null` if the scope doesn't resolve or has no plugin state event.
 */
function findPluginStateEvent(
  events: readonly FLPEvent[],
  scope: PluginScope,
): { eventIdx: number; pluginName: string | null } | null {
  if (scope.kind === "channel") {
    let inScope = false;
    let scopeIid = -1;
    let lastName: string | null = null;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      if (ev.kind === "u16" && ev.opcode === OP_NEW_CHANNEL) {
        inScope = ev.value === scope.channelIid;
        scopeIid = ev.value;
        lastName = null;
        continue;
      }
      if (ev.opcode === OP_INSERT_END || ev.opcode === OP_INSERT_FLAGS || ev.opcode === OP_NEW_SLOT) {
        // Channel section closed.
        return null;
      }
      if (!inScope) continue;
      if (ev.kind === "blob" && ev.opcode === OP_PLUGIN_INTERNAL_NAME) {
        lastName = decodeUtf16LeNullTerminated(ev.payload);
      }
      if (ev.kind === "blob" && ev.opcode === OP_NAME) {
        const n = decodeUtf16LeNullTerminated(ev.payload);
        if (n.length > 0) lastName = n;
      }
      if (ev.kind === "blob" && ev.opcode === OP_PLUGIN_STATE) {
        return { eventIdx: i, pluginName: lastName };
      }
    }
    return null;
  }
  // mixer_slot scope.
  //
  // Insert numbering: insert 0 is the Master, inserts 1..N are user
  // inserts. Each insert is closed by an `OP_INSERT_END` (0x93)
  // event. So events BEFORE the first 0x93 belong to insert 0
  // (Master), events between 1st and 2nd 0x93 belong to insert 1, etc.
  // The mixer section opens at the first `OP_INSERT_FLAGS` (0xEC) or
  // `OP_NEW_SLOT` (0x62).
  let insertIdx = 0;
  // FL doesn't emit a 0x62 marker for the FIRST plugin in an insert —
  // events appear directly after OP_INSERT_FLAGS in slot 0 scope. Start
  // each insert at slot 0; subsequent 0x62 markers move the cursor.
  // (Same convention as the sweep tool's walker; D-32 lesson.)
  let curSlotIdx = 0;
  let inMixer = false;
  let lastSlotName: string | null = null;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.opcode === OP_INSERT_FLAGS) {
      inMixer = true;
      continue;
    }
    if (ev.kind === "u16" && ev.opcode === OP_NEW_SLOT) {
      inMixer = true;
      curSlotIdx = ev.value;
      lastSlotName = null;
      continue;
    }
    if (!inMixer) continue;
    if (ev.opcode === OP_INSERT_END) {
      // Current insert closes here; next events belong to insertIdx + 1.
      insertIdx++;
      curSlotIdx = 0;
      lastSlotName = null;
      continue;
    }
    if (ev.kind === "blob" && ev.opcode === OP_PLUGIN_NAME_IN_MIXER_SCOPE) {
      const n = decodeUtf16LeNullTerminated(ev.payload);
      if (n.length > 0) lastSlotName = n;
    }
    if (ev.kind === "blob" && ev.opcode === OP_PLUGIN_INTERNAL_NAME) {
      const n = decodeUtf16LeNullTerminated(ev.payload);
      if (n.length > 0 && lastSlotName === null) lastSlotName = n;
    }
    if (ev.kind === "blob" && ev.opcode === OP_PLUGIN_STATE) {
      if (insertIdx === scope.insertIndex && curSlotIdx === scope.slotIndex) {
        return { eventIdx: i, pluginName: lastSlotName };
      }
    }
  }
  return null;
}

function decodeUtf16LeNullTerminated(payload: Uint8Array): string {
  let end = payload.byteLength;
  // Strip trailing UTF-16LE NUL pairs.
  while (end >= 2 && payload[end - 1] === 0 && payload[end - 2] === 0) end -= 2;
  return new TextDecoder("utf-16le" as "utf-8").decode(payload.subarray(0, end));
}

/**
 * Patch a single parameter in a native FL plugin's `0xD5` state blob.
 *
 * v0.1 supports **only** Fruity Parametric EQ 2 (registered name
 * variants: `"Fruity Parametric EQ 2"` / `"Fruity parametric EQ 2"`).
 * Other native plugins have not yet been RE'd; calls against
 * unsupported plugins reject with `UNSUPPORTED_PLUGIN`.
 *
 * Param ref shapes:
 *   - `{kind: "main_level"}` → byte 0x90 (uint16 LE)
 *   - `{kind: "band", band: 1..7, field: "level"|"freq"|"width"}` →
 *     uint16 LE at the band's slot in the corresponding group
 *
 * `normalizedValue` is in `[0.0, 1.0]` and stored as
 * `round(v * 0xFFFF)`. The encoder rejects values outside that range
 * with `INVALID_ARGS`.
 *
 * The `type` and `order` band fields (uint8 enums 0..7) are NOT
 * supported in v0.1 — they aren't continuous params so a normalized
 * 0..1 mapping is lossy. Future API may add an enum-value variant.
 *
 * VST plugins (Fruity Wrapper-hosted) are NOT supported — their state
 * blob contains session-internal noise that drifts across same-value
 * saves, breaking the fixed-offset RE strategy. Use the live MIDI-
 * script path for VSTs.
 */
export function setNativePluginParam(
  project: FLPProject,
  scope: PluginScope,
  param: PluginParamRef,
  normalizedValue: number,
): FLPProject {
  if (!Number.isFinite(normalizedValue) || normalizedValue < 0 || normalizedValue > 1) {
    throw new MutationError(
      "INVALID_ARGS",
      `normalizedValue must be in [0.0, 1.0], got ${normalizedValue}`,
    );
  }
  if (scope.kind === "channel") {
    if (!Number.isInteger(scope.channelIid) || scope.channelIid < 0) {
      throw new MutationError(
        "INVALID_ARGS",
        `scope.channelIid must be a non-negative integer, got ${scope.channelIid}`,
      );
    }
  } else if (scope.kind === "mixer_slot") {
    if (!Number.isInteger(scope.insertIndex) || scope.insertIndex < 0) {
      throw new MutationError(
        "INVALID_ARGS",
        `scope.insertIndex must be a non-negative integer, got ${scope.insertIndex}`,
      );
    }
    if (!Number.isInteger(scope.slotIndex) || scope.slotIndex < 0) {
      throw new MutationError(
        "INVALID_ARGS",
        `scope.slotIndex must be a non-negative integer, got ${scope.slotIndex}`,
      );
    }
  } else {
    throw new MutationError(
      "INVALID_ARGS",
      `scope.kind must be 'channel' or 'mixer_slot'`,
    );
  }

  const located = findPluginStateEvent(project.events, scope);
  if (!located) {
    throw new MutationError(
      "EVENT_NOT_FOUND",
      `no plugin state (0xD5) event found at the requested scope`,
    );
  }
  const { eventIdx, pluginName } = located;
  if (!pluginName) {
    throw new MutationError(
      "UNSUPPORTED_PLUGIN",
      `plugin at the requested scope has no name event; cannot identify layout`,
    );
  }
  const layout = PLUGIN_PARAM_LAYOUTS[pluginName];
  if (!layout) {
    const known = Object.keys(PLUGIN_PARAM_LAYOUTS).join(", ");
    throw new MutationError(
      "UNSUPPORTED_PLUGIN",
      `plugin "${pluginName}" has no registered param layout. Known: ${known}`,
    );
  }
  const ev = project.events[eventIdx]!;
  if (ev.kind !== "blob") {
    throw new MutationError("EVENT_NOT_FOUND", `0xD5 event is not a blob`);
  }
  if (ev.payload.byteLength < layout.minSize || ev.payload.byteLength > layout.maxSize) {
    throw new MutationError(
      "UNSUPPORTED_PLUGIN",
      `plugin "${pluginName}" state blob is ${ev.payload.byteLength} bytes, ` +
        `expected [${layout.minSize}, ${layout.maxSize}]; layout may be out of date`,
    );
  }
  const offsetInfo = layout.paramRefToOffset(param);
  if (!offsetInfo) {
    throw new MutationError(
      "INVALID_ARGS",
      `param ref ${JSON.stringify(param)} not recognised for plugin "${pluginName}"`,
    );
  }

  // Patch a copy.
  const newPayload = new Uint8Array(ev.payload);
  const off = offsetInfo.offset;
  if (offsetInfo.fieldType === "u16") {
    const raw = Math.round(normalizedValue * 0xffff);
    newPayload[off] = raw & 0xff;
    newPayload[off + 1] = (raw >> 8) & 0xff;
  } else if (offsetInfo.fieldType === "u8") {
    const raw = Math.round(normalizedValue * 0xff);
    newPayload[off] = raw & 0xff;
  } else if (offsetInfo.fieldType === "u32") {
    // round(v * 0xFFFFFFFF) overflows JS bitwise ops; use DataView.
    const view = new DataView(newPayload.buffer, newPayload.byteOffset, newPayload.byteLength);
    view.setUint32(off, Math.round(normalizedValue * 0xffffffff), true);
  } else if (offsetInfo.fieldType === "f32") {
    const view = new DataView(newPayload.buffer, newPayload.byteOffset, newPayload.byteLength);
    view.setFloat32(off, normalizedValue, true);
  } else if (offsetInfo.fieldType === "i32_bipolar") {
    if (offsetInfo.scale === undefined || !Number.isFinite(offsetInfo.scale)) {
      throw new MutationError(
        "INVALID_ARGS",
        `i32_bipolar fieldType requires numeric scale; got ${offsetInfo.scale}`,
      );
    }
    const raw = Math.round((normalizedValue * 2 - 1) * offsetInfo.scale);
    const view = new DataView(newPayload.buffer, newPayload.byteOffset, newPayload.byteLength);
    view.setInt32(off, raw, true);
  }

  const events = [...project.events];
  events[eventIdx] = { kind: "blob", opcode: OP_PLUGIN_STATE, payload: newPayload };
  return { ...project, events };
}

// --------------------------------------------------------------------------- //
// F6.1 — Note transformations + pattern length writer                          //
// --------------------------------------------------------------------------- //
//
// Pure-data ops on existing notes. Each helper reads the pattern's
// notes via collectExistingNotes(), applies the transform, and writes
// back via setPatternNotes() — so the encoder/decoder round-trip
// guarantees still hold.
//
// Auto-grow: any helper that may move a note's `position + length`
// past the current pattern length (`0xA4`) bumps the length to the
// next beat boundary (D-60a). Helpers that only mutate `key` or
// `velocity` leave length alone.

const OP_PATTERN_NEW_FOR_LEN = 0x41;

/**
 * Write or update the pattern-length scalar (`0xA4` u32 PPQ ticks)
 * inside a pattern's scope. Adds the event right after `0xC1`
 * (pattern name) if not present; replaces in-place otherwise.
 *
 * Throws `EVENT_NOT_FOUND` if the pattern id doesn't exist.
 */
export function setPatternLength(
  project: FLPProject,
  patternId: number,
  ticks: number,
): FLPProject {
  if (!Number.isInteger(patternId) || patternId < 1) {
    throw new MutationError(
      "INVALID_ARGS",
      `pattern id must be a positive integer (1-based), got ${patternId}`,
    );
  }
  if (!Number.isInteger(ticks) || ticks < 0 || ticks > 0xffffffff) {
    throw new MutationError(
      "INVALID_ARGS",
      `pattern length must be a non-negative u32, got ${ticks}`,
    );
  }
  const scope = findPatternScope(project.events, patternId);
  if (!scope) {
    throw new MutationError("EVENT_NOT_FOUND", `no pattern with id=${patternId} found`);
  }
  const events = [...project.events];
  for (let i = scope.startIdx + 1; i < scope.endIdx; i++) {
    if (events[i]!.opcode === OP_PATTERN_LENGTH) {
      events[i] = { kind: "u32", opcode: OP_PATTERN_LENGTH, value: ticks };
      return { ...project, events };
    }
  }
  // Insert after the pattern-name event (0xC1) if present, else right
  // after the 0x41 opener.
  let insertAt = scope.startIdx + 1;
  for (let i = scope.startIdx + 1; i < scope.endIdx; i++) {
    if (events[i]!.opcode === OP_PATTERN_NAME) {
      insertAt = i + 1;
      break;
    }
  }
  events.splice(insertAt, 0, { kind: "u32", opcode: OP_PATTERN_LENGTH, value: ticks });
  return { ...project, events };
}

/**
 * Find the current pattern-length scalar inside a pattern scope, or
 * `0` if no `0xA4` event is present (FL semantics: 0 = "use project
 * default bar length").
 */
function findPatternLength(
  events: readonly FLPEvent[],
  scope: { startIdx: number; endIdx: number },
): number {
  for (let i = scope.startIdx + 1; i < scope.endIdx; i++) {
    const ev = events[i]!;
    if (ev.opcode === OP_PATTERN_LENGTH && ev.kind === "u32") return ev.value;
  }
  return 0;
}

/** Maximum `position + length` across a note list (= pattern's
 *  required minimum length). */
function notesEndTick(notes: readonly Note[]): number {
  let end = 0;
  for (const n of notes) {
    const e = n.position + n.length;
    if (e > end) end = e;
  }
  return end;
}

/** Round `ticks` up to the next beat boundary (`ppq` ticks). Used for
 *  auto-grow so the pattern length lands on a clean grid. */
function ceilToBeat(ticks: number, ppq: number): number {
  if (ppq <= 0) return ticks;
  return Math.ceil(ticks / ppq) * ppq;
}

/**
 * Re-write a pattern's notes AND auto-grow `0xA4` if the new notes
 * extend past the current length. If `growLength === false`, the
 * length is left alone (used by transforms that don't change
 * positions, like transpose).
 */
function setPatternNotesAutoGrow(
  project: FLPProject,
  patternId: number,
  notes: readonly Note[],
  growLength: boolean,
): FLPProject {
  let next = setPatternNotes(project, patternId, notes);
  if (!growLength) return next;
  const scope = findPatternScope(next.events, patternId)!;
  const currentLen = findPatternLength(next.events, scope);
  const required = notesEndTick(notes);
  if (currentLen > 0 && required > currentLen) {
    next = setPatternLength(next, patternId, ceilToBeat(required, next.header.ppq));
  }
  return next;
}

/** Mulberry32 — small deterministic PRNG; seedable for tests. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function clampInt(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(value)));
}

/**
 * Shift every note's `key` by `semitones`. Optional `channelIid`
 * filter restricts the transform to one channel; otherwise every
 * note in the pattern is shifted.
 *
 * Notes whose post-shift key would fall outside `[0, 131]` clip to
 * the boundary (FL's valid key range) — silently, since per-note
 * skipping would corrupt chord groupings.
 */
export function transposePatternNotes(
  project: FLPProject,
  patternId: number,
  semitones: number,
  channelIid?: number,
): FLPProject {
  if (!Number.isInteger(semitones)) {
    throw new MutationError("INVALID_ARGS", `semitones must be an integer, got ${semitones}`);
  }
  const scope = findPatternScope(project.events, patternId);
  if (!scope) {
    throw new MutationError("EVENT_NOT_FOUND", `no pattern with id=${patternId} found`);
  }
  const existing = collectExistingNotes(project.events, scope);
  const next = existing.map((n) => {
    if (channelIid !== undefined && n.channel_iid !== channelIid) return n;
    return { ...n, key: clampInt(n.key + semitones, 0, 131) };
  });
  return setPatternNotesAutoGrow(project, patternId, next, /* growLength */ false);
}

/**
 * Snap every note's `position` to the nearest multiple of `gridTicks`.
 * `strength` ∈ [0, 1] controls partial quantization (1 = full snap,
 * 0.5 = move halfway to grid, 0 = no-op). Auto-grows pattern length
 * if any note now extends past it.
 */
export function quantizePatternNotes(
  project: FLPProject,
  patternId: number,
  gridTicks: number,
  strength: number = 1.0,
): FLPProject {
  if (!Number.isInteger(gridTicks) || gridTicks <= 0) {
    throw new MutationError(
      "INVALID_ARGS",
      `gridTicks must be a positive integer, got ${gridTicks}`,
    );
  }
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
    throw new MutationError(
      "INVALID_ARGS",
      `strength must be in [0, 1], got ${strength}`,
    );
  }
  const scope = findPatternScope(project.events, patternId);
  if (!scope) {
    throw new MutationError("EVENT_NOT_FOUND", `no pattern with id=${patternId} found`);
  }
  const existing = collectExistingNotes(project.events, scope);
  const next = existing.map((n) => {
    const target = Math.round(n.position / gridTicks) * gridTicks;
    const newPos = Math.round(n.position + (target - n.position) * strength);
    return { ...n, position: Math.max(0, newPos) };
  });
  return setPatternNotesAutoGrow(project, patternId, next, /* growLength */ true);
}

/**
 * Add ±`range` jitter to every note's `velocity`. Result clamped to
 * `[1, 127]` (0 would silently mute). `seed` defaults to `Date.now()`.
 */
export function humanizeVelocities(
  project: FLPProject,
  patternId: number,
  range: number,
  seed?: number,
): FLPProject {
  if (!Number.isInteger(range) || range < 0) {
    throw new MutationError("INVALID_ARGS", `range must be a non-negative integer, got ${range}`);
  }
  const scope = findPatternScope(project.events, patternId);
  if (!scope) {
    throw new MutationError("EVENT_NOT_FOUND", `no pattern with id=${patternId} found`);
  }
  const existing = collectExistingNotes(project.events, scope);
  if (range === 0) return setPatternNotesAutoGrow(project, patternId, existing, false);
  const rand = mulberry32(seed ?? Date.now());
  const next = existing.map((n) => {
    const jitter = Math.round((rand() * 2 - 1) * range);
    return { ...n, velocity: clampInt(n.velocity + jitter, 1, 127) };
  });
  return setPatternNotesAutoGrow(project, patternId, next, /* growLength */ false);
}

/**
 * Add ±`rangeTicks` jitter to every note's `position`. Negative
 * positions clamp to 0. Auto-grows pattern length if any note now
 * extends past it. `seed` defaults to `Date.now()`.
 */
export function humanizeTimings(
  project: FLPProject,
  patternId: number,
  rangeTicks: number,
  seed?: number,
): FLPProject {
  if (!Number.isInteger(rangeTicks) || rangeTicks < 0) {
    throw new MutationError(
      "INVALID_ARGS",
      `rangeTicks must be a non-negative integer, got ${rangeTicks}`,
    );
  }
  const scope = findPatternScope(project.events, patternId);
  if (!scope) {
    throw new MutationError("EVENT_NOT_FOUND", `no pattern with id=${patternId} found`);
  }
  const existing = collectExistingNotes(project.events, scope);
  if (rangeTicks === 0) return setPatternNotesAutoGrow(project, patternId, existing, true);
  const rand = mulberry32(seed ?? Date.now());
  const next = existing.map((n) => {
    const jitter = Math.round((rand() * 2 - 1) * rangeTicks);
    return { ...n, position: Math.max(0, n.position + jitter) };
  });
  return setPatternNotesAutoGrow(project, patternId, next, /* growLength */ true);
}

/**
 * Mirror notes in time around the pattern's midpoint. A note at
 * position `p` with length `l` ends up at `pattern_length - p - l`
 * (so its tail still sits inside the original window). Falls back
 * to `notesEndTick(notes)` as the mirror axis when `0xA4` is absent
 * (FL semantics: 0 = "use project default", which we can't compute
 * here).
 */
export function reversePatternNotes(
  project: FLPProject,
  patternId: number,
): FLPProject {
  const scope = findPatternScope(project.events, patternId);
  if (!scope) {
    throw new MutationError("EVENT_NOT_FOUND", `no pattern with id=${patternId} found`);
  }
  const existing = collectExistingNotes(project.events, scope);
  if (existing.length === 0) return project;
  const declaredLen = findPatternLength(project.events, scope);
  const axis = declaredLen > 0 ? declaredLen : notesEndTick(existing);
  const next = existing.map((n) => ({
    ...n,
    position: Math.max(0, axis - n.position - n.length),
  }));
  return setPatternNotesAutoGrow(project, patternId, next, /* growLength */ false);
}

/**
 * Mirror notes in pitch around `axisKey` (default 60 = middle C).
 * `key' = clamp(2 * axisKey - key, 0, 131)`. Velocities + timings
 * preserved.
 */
export function invertPatternNotes(
  project: FLPProject,
  patternId: number,
  axisKey: number = 60,
): FLPProject {
  if (!Number.isInteger(axisKey) || axisKey < 0 || axisKey > 131) {
    throw new MutationError("INVALID_ARGS", `axisKey must be in [0, 131], got ${axisKey}`);
  }
  const scope = findPatternScope(project.events, patternId);
  if (!scope) {
    throw new MutationError("EVENT_NOT_FOUND", `no pattern with id=${patternId} found`);
  }
  const existing = collectExistingNotes(project.events, scope);
  const next = existing.map((n) => ({ ...n, key: clampInt(2 * axisKey - n.key, 0, 131) }));
  return setPatternNotesAutoGrow(project, patternId, next, /* growLength */ false);
}

void OP_PATTERN_NEW_FOR_LEN;

// --------------------------------------------------------------------------- //
// F6.2 — Channel volume + pan (0xDB Levels blob)                              //
// --------------------------------------------------------------------------- //
//
// Per-channel volume + pan live in a 24-byte 0xDB blob (FL 25), one
// per channel. Layout (decoded by `decodeLevels` in
// src/model/channel.ts):
//   offset 0  int32   pan          (-6400 .. +6400, 0 = center)
//   offset 4  uint32  volume       (0 .. 12800, 10000 = default 0.78)
//   offset 8  int32   pitch_shift
//   offset 12 uint32  filter_mod_x
//   offset 16 uint32  filter_mod_y
//   offset 20 uint32  filter_type
//
// Encoders preserve fields 8..23 verbatim; only patch offsets 0/4.

const OP_CHANNEL_LEVELS = 0xdb;
const CHANNEL_VOLUME_MAX = 12800;
const CHANNEL_PAN_MAX = 6400;

/** Find the 0xDB blob event index for a given channel iid. Walks the
 *  channel scope between consecutive `0x40 NEW_CHANNEL` markers. */
function findChannelLevelsEvent(
  events: readonly FLPEvent[],
  iid: number,
): number {
  let inScope = false;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "u16" && ev.opcode === OP_NEW_CHANNEL) {
      inScope = ev.value === iid;
      continue;
    }
    if (!inScope) continue;
    if (ev.kind === "blob" && ev.opcode === OP_CHANNEL_LEVELS) {
      return i;
    }
  }
  return -1;
}

/** Build a 24-byte 0xDB Levels blob with FL's defaults: pan=6400 (raw,
 *  display center), volume=10000 (raw, ~0.78 normalized), pitch_shift=0,
 *  filter_mod_x=256, filter_mod_y=0, filter_type=0. Used when a freshly
 *  created channel (via createChannel) has no Levels event yet. */
function defaultChannelLevelsPayload(): Uint8Array {
  const buf = new Uint8Array(24);
  const view = new DataView(buf.buffer);
  view.setInt32(0, 6400, true);   // pan
  view.setUint32(4, 10000, true); // volume
  view.setInt32(8, 0, true);      // pitch_shift
  view.setUint32(12, 256, true);  // filter_mod_x
  view.setUint32(16, 0, true);    // filter_mod_y
  view.setUint32(20, 0, true);    // filter_type
  return buf;
}

/** Patch one numeric field inside the 24-byte 0xDB Levels blob.
 *  Auto-inserts a default 0xDB if the channel exists but has no Levels
 *  event yet (e.g., freshly-created channels via createChannel — FL's
 *  on-disk emission includes Levels by default but our minimal channel
 *  creator omits it). Throws if the channel itself doesn't exist. */
function patchChannelLevels(
  project: FLPProject,
  iid: number,
  patch: (view: DataView) => void,
): FLPProject {
  if (!Number.isInteger(iid) || iid < 0) {
    throw new MutationError("INVALID_ARGS", `channel iid must be a non-negative integer, got ${iid}`);
  }
  let events = [...project.events];
  let eventIdx = findChannelLevelsEvent(events, iid);
  if (eventIdx < 0) {
    // No Levels event — verify channel exists, then insert a default
    // Levels blob right after the 0x40 NEW_CHANNEL opener.
    let openIdx = -1;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      if (ev.kind === "u16" && ev.opcode === OP_NEW_CHANNEL && ev.value === iid) {
        openIdx = i;
        break;
      }
    }
    if (openIdx === -1) {
      throw new MutationError("EVENT_NOT_FOUND", `no channel with iid=${iid} found`);
    }
    const defaultPayload = defaultChannelLevelsPayload();
    events.splice(openIdx + 1, 0, {
      kind: "blob",
      opcode: OP_CHANNEL_LEVELS,
      payload: defaultPayload,
    });
    eventIdx = openIdx + 1;
  }
  const ev = events[eventIdx]!;
  if (ev.kind !== "blob" || ev.payload.byteLength < 24) {
    throw new MutationError(
      "EVENT_NOT_FOUND",
      `0xDB event for channel ${iid} is not a 24+ byte blob`,
    );
  }
  const newPayload = new Uint8Array(ev.payload);
  const view = new DataView(newPayload.buffer, newPayload.byteOffset, newPayload.byteLength);
  patch(view);
  events[eventIdx] = { kind: "blob", opcode: OP_CHANNEL_LEVELS, payload: newPayload };
  return { ...project, events };
}

/**
 * Set a channel's volume (offset 4, uint32 LE). `normalized` is in
 * `[0, 1]` and maps linearly to `[0, 12800]`. FL's "default 0.78"
 * = `0.78125 = 10000/12800`.
 */
export function setChannelVolume(
  project: FLPProject,
  iid: number,
  normalized: number,
): FLPProject {
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
    throw new MutationError(
      "INVALID_ARGS",
      `volume must be in [0, 1], got ${normalized}`,
    );
  }
  return patchChannelLevels(project, iid, (view) => {
    view.setUint32(4, Math.round(normalized * CHANNEL_VOLUME_MAX), true);
  });
}

/**
 * Set a channel's pan (offset 0, int32 LE). `normalized` is in
 * `[-1, +1]` (bipolar): -1 = full left, 0 = center, +1 = full right.
 * Maps to `[-6400, +6400]`.
 */
export function setChannelPan(
  project: FLPProject,
  iid: number,
  normalized: number,
): FLPProject {
  if (!Number.isFinite(normalized) || normalized < -1 || normalized > 1) {
    throw new MutationError(
      "INVALID_ARGS",
      `pan must be in [-1, +1], got ${normalized}`,
    );
  }
  return patchChannelLevels(project, iid, (view) => {
    view.setInt32(0, Math.round(normalized * CHANNEL_PAN_MAX), true);
  });
}

// --------------------------------------------------------------------------- //
// F6.5 — Arrangement sequencing (composite helper over addClip)               //
// --------------------------------------------------------------------------- //
//
// `arrangeSong` lays out a sequence of pattern clips in a single
// arrangement, computing playlist positions from a structure spec.
// Internally calls `addClip` per section.

export type SongSection = {
  /** Pattern id to place (must already exist). */
  pattern_id: number;
  /** Length of this section in bars (4 beats per bar at 4/4). */
  bars: number;
  /** Optional explicit position in PPQ ticks. If omitted, sections
   *  are laid sequentially starting at 0 (or after the previous one). */
  position_ticks?: number;
};

export type ArrangeSongOptions = {
  /** Track index (0-based, top track) where the clips land.
   *  Default: 0. Sections stack horizontally on this track. */
  track_index?: number;
  /** Number of beats per bar. Default 4 (assumes 4/4). */
  beats_per_bar?: number;
};

/**
 * Lay out a sequence of pattern clips on a single track of the
 * arrangement. Computes positions sequentially from `bars * ppq *
 * beats_per_bar` unless a section overrides `position_ticks`.
 *
 * Returns the mutated project with N new playlist clips appended
 * (one per section in `structure`).
 *
 * Throws `INVALID_ARGS` if structure is empty / contains bad data;
 * `EVENT_NOT_FOUND` if the arrangement_id doesn't exist (from
 * underlying `addClip`).
 */
export function arrangeSong(
  project: FLPProject,
  arrangementId: number,
  structure: readonly SongSection[],
  opts: ArrangeSongOptions = {},
): FLPProject {
  if (!Array.isArray(structure) || structure.length === 0) {
    throw new MutationError("INVALID_ARGS", "structure must be a non-empty array of sections");
  }
  const trackIndex = opts.track_index ?? 0;
  const beatsPerBar = opts.beats_per_bar ?? 4;
  if (!Number.isInteger(beatsPerBar) || beatsPerBar < 1) {
    throw new MutationError("INVALID_ARGS", `beats_per_bar must be positive integer, got ${beatsPerBar}`);
  }
  const ppq = project.header.ppq;
  let cursor = 0;
  let next = project;
  for (let i = 0; i < structure.length; i++) {
    const section = structure[i]!;
    if (!Number.isInteger(section.pattern_id) || section.pattern_id < 1) {
      throw new MutationError(
        "INVALID_ARGS",
        `structure[${i}].pattern_id must be positive integer, got ${section.pattern_id}`,
      );
    }
    if (!Number.isInteger(section.bars) || section.bars < 1) {
      throw new MutationError(
        "INVALID_ARGS",
        `structure[${i}].bars must be positive integer, got ${section.bars}`,
      );
    }
    const lengthTicks = section.bars * beatsPerBar * ppq;
    const positionTicks = section.position_ticks ?? cursor;
    if (!Number.isInteger(positionTicks) || positionTicks < 0) {
      throw new MutationError(
        "INVALID_ARGS",
        `structure[${i}].position_ticks must be non-negative integer, got ${positionTicks}`,
      );
    }
    next = addClip(next, arrangementId, {
      kind: "pattern",
      ref_id: section.pattern_id,
      track_index: trackIndex,
      position_ticks: positionTicks,
      length_ticks: lengthTicks,
    });
    cursor = positionTicks + lengthTicks;
  }
  return next;
}

// --------------------------------------------------------------------------- //
// F6.6 — Plugin instantiation (synthesis-best-effort, D-32 caveat)            //
// --------------------------------------------------------------------------- //
//
// Wraps the existing `extractPluginSlotScope` + `craftPluginFixture`
// synthesis path from src/synth/craft-plugin-fixture.ts as a regular
// mutation, callable from the bridge. Limitations:
// - Requires a donor FLPProject already containing the target plugin
//   (we don't ship a donor pack yet; user provides via donor_path).
// - FL UI recognition works for synthesized plugins; IPC binding works
//   in the cases tested but may fail on others (R17 / D-32).
// - Best-effort error: PLUGIN_INSTANTIATE_FAILED + which plugin tried.

import { extractPluginSlotScope, craftPluginFixture } from "../synth/craft-plugin-fixture.ts";

export type InstantiateScope =
  | { kind: "mixer_slot"; insert_index: number; slot_marker: number };

/**
 * Splice a plugin from `donor` into `project` at the requested mixer
 * slot. Returns the mutated project + the FL IPC slot index where
 * the plugin will appear (= slot_marker + 1).
 *
 * Throws `PLUGIN_INSTANTIATE_FAILED` if extraction or splice fails.
 */
export function instantiateNativePlugin(
  project: FLPProject,
  donor: FLPProject,
  pluginName: string,
  scope: InstantiateScope,
): { project: FLPProject; fl_ipc_slot_index: number } {
  if (scope.kind !== "mixer_slot") {
    throw new MutationError(
      "INVALID_ARGS",
      `scope.kind must be 'mixer_slot' (channel scope not yet supported)`,
    );
  }
  let extracted;
  try {
    extracted = extractPluginSlotScope(donor, pluginName);
  } catch (err) {
    throw new MutationError(
      "PLUGIN_INSTANTIATE_FAILED",
      `donor extraction for "${pluginName}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let mutated;
  try {
    mutated = craftPluginFixture(project, extracted.scope, scope.insert_index, scope.slot_marker);
  } catch (err) {
    throw new MutationError(
      "PLUGIN_INSTANTIATE_FAILED",
      `splice into insert=${scope.insert_index} slot_marker=${scope.slot_marker}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    project: mutated,
    fl_ipc_slot_index: scope.slot_marker + 1,
  };
}

// --------------------------------------------------------------------------- //
// F7.1 — Channel sample-path setter (0xC4)                                    //
// --------------------------------------------------------------------------- //
//
// Sample channels store their loaded sample's path at opcode 0xC4 in
// channel scope. Path uses FL's library-token form (e.g.
// `%FLStudioFactoryData%/Data/Patches/Packs/Drums/Kicks/909 Kick.wav`)
// — caller is responsible for token form; this encoder doesn't expand
// or validate paths.

const OP_CHANNEL_SAMPLE_PATH = 0xc4;

/**
 * Set (or replace) the sample path on a sampler channel. If the channel
 * already has a 0xC4 event, replace it in-place; otherwise insert one
 * immediately after the 0x40 channel-open.
 *
 * Throws `EVENT_NOT_FOUND` if the channel doesn't exist;
 * `INVALID_ARGS` if path is empty / iid is bad.
 */
export function setChannelSamplePath(
  project: FLPProject,
  iid: number,
  samplePath: string,
): FLPProject {
  if (!Number.isInteger(iid) || iid < 0) {
    throw new MutationError(
      "INVALID_ARGS",
      `channel iid must be a non-negative integer, got ${iid}`,
    );
  }
  if (typeof samplePath !== "string" || samplePath.length === 0) {
    throw new MutationError("INVALID_ARGS", "samplePath must be a non-empty string");
  }

  const events = [...project.events];
  const newPayload = encodeUtf16LeNullTerminated(samplePath);

  let openIndex = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "u16" && ev.opcode === OP_NEW_CHANNEL && ev.value === iid) {
      openIndex = i;
      break;
    }
  }
  if (openIndex === -1) {
    throw new MutationError("EVENT_NOT_FOUND", `no channel with iid=${iid} found`);
  }

  // Bound to this channel's block (same boundary semantics as setChannelName).
  let endIndex = events.length;
  for (let i = openIndex + 1; i < events.length; i++) {
    const ev = events[i]!;
    if (
      (ev.kind === "u16" && ev.opcode === OP_NEW_CHANNEL) ||
      (ev.kind === "u32" && ev.opcode === OP_INSERT_END) ||
      (ev.kind === "blob" && ev.opcode === OP_INSERT_FLAGS)
    ) {
      endIndex = i;
      break;
    }
  }

  for (let i = openIndex + 1; i < endIndex; i++) {
    const ev = events[i]!;
    if (ev.kind === "blob" && ev.opcode === OP_CHANNEL_SAMPLE_PATH) {
      events[i] = { kind: "blob", opcode: OP_CHANNEL_SAMPLE_PATH, payload: newPayload };
      return { ...project, events };
    }
  }

  // No 0xC4 in scope — insert immediately after the 0x40 opener.
  events.splice(openIndex + 1, 0, {
    kind: "blob",
    opcode: OP_CHANNEL_SAMPLE_PATH,
    payload: newPayload,
  });
  return { ...project, events };
}
