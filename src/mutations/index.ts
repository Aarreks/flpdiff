/**
 * Pure mutation helpers over `FLPProject` — Phase 3.0.4.
 *
 * Each helper takes an `FLPProject`, returns a NEW `FLPProject` with
 * the relevant event(s) modified. The serializer (Phase 3.0.3)
 * writes the result back to disk byte-exact except for the
 * intentionally-changed bytes.
 *
 * v0.1 scope: tempo + pattern name. These are the cleanest cases
 * because their opcodes map 1:1 to a single event without nested
 * block state. Channel name (0xC0/0xCB), insert name (0xCC), and
 * time signature (0x21/0x22 inside time-marker blocks) need
 * block-walking logic to identify the Nth event in the right scope
 * — deferred to a v0.1.x follow-up that mirrors `project-builder`'s
 * walker.
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
