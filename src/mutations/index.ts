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
