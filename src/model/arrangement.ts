/**
 * A playlist arrangement — the timeline view in FL Studio. Each FL 25
 * project has at least one (default-named "Arrangement") and may have
 * many if the user adds them.
 */
import type { RGBA } from "./channel.ts";

/**
 * One playlist clip within an arrangement. Mirrors FL's on-disk record
 * shape as emitted inside the `0xE9` arrangement-playlist blob.
 *
 * FL 21+/25 uses an 80-byte record per clip; earlier FL versions used
 * 32 bytes. The decoder auto-detects format by payload-size divisibility.
 */
export type Clip = {
  /** Tick position on the arrangement timeline (PPQ ticks). */
  position: number;
  /** Index into the source collection. Combined with pattern_base to pick pattern vs audio/automation clip. */
  item_index: number;
  /** Clip length in PPQ ticks. */
  length: number;
  /** Track position — stored REVERSED (track 0 = 499, track 499 = 0); consumers should un-reverse if they want FL's display ordering. */
  track_rvidx: number;
  /** Group id (0 for ungrouped). */
  group: number;
  /** Item flags bitmask. */
  item_flags: number;
  /** Clip start offset in seconds (for audio clips; ticks for pattern clips). */
  start_offset: number;
  /** Clip end offset. */
  end_offset: number;
};

/**
 * Decode arrangement clips from a `0xE9` payload.
 *
 * Three record sizes coexist in the wild:
 *   80 — FL 25.x (current)
 *   60 — FL 21.0 – 24.x
 *   32 — pre-FL-21
 *
 * Sizes 60 and 80 are co-divisible at multiples of 240, so for
 * unambiguous detection callers pass the FL major version via
 * `preferredRecordSize`. Without it we try 80 first (covers FL 25.x
 * truth-saved fixtures), then 60, then 32.
 *
 * Returns an empty array for malformed payloads.
 */
export function decodeClips(payload: Uint8Array, preferredRecordSize?: number): Clip[] {
  let recordSize = 0;
  if (preferredRecordSize !== undefined && payload.byteLength % preferredRecordSize === 0) {
    recordSize = preferredRecordSize;
  } else if (payload.byteLength % 80 === 0) {
    recordSize = 80;
  } else if (payload.byteLength % 60 === 0) {
    recordSize = 60;
  } else if (payload.byteLength % 32 === 0) {
    recordSize = 32;
  }
  if (recordSize === 0 || payload.byteLength === 0) return [];
  const out: Clip[] = [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let p = 0; p + recordSize <= payload.byteLength; p += recordSize) {
    out.push({
      position: view.getUint32(p, true),
      // byte 4-5 pattern_base (always 20480 = 0x5000) — skipped
      item_index: view.getUint16(p + 6, true),
      length: view.getUint32(p + 8, true),
      track_rvidx: view.getUint16(p + 12, true),
      group: view.getUint16(p + 14, true),
      // bytes 16-17 reserved (_u1)
      item_flags: view.getUint16(p + 18, true),
      // bytes 20-23 reserved (_u2)
      start_offset: view.getFloat32(p + 24, true),
      end_offset: view.getFloat32(p + 28, true),
      // bytes 32-59 reserved (_u3, FL 21+ only)
    });
  }
  return out;
}

/**
 * A marker on the arrangement's timeline. Two kinds: plain text
 * markers and time-signature changes. FL encodes the kind in the
 * high bits of the `0x94` time-marker position uint32 value —
 * the `SIGNATURE_BIT` (0x08000000) flips a regular marker into a
 * time-signature marker carrying numerator + denominator.
 */
export type TimeMarkerKind = "marker" | "signature";

export type TimeMarker = {
  kind: TimeMarkerKind;
  /** Position in PPQ ticks on the arrangement timeline. */
  position: number;
  /** User-set marker name, if any (from opcode 0xCD, UTF-16LE). */
  name?: string;
  /** Time-signature numerator; only meaningful for `kind === "signature"`. */
  numerator?: number;
  /** Time-signature denominator; only meaningful for `kind === "signature"`. */
  denominator?: number;
};

const TIME_SIGNATURE_BIT = 0x08000000;

/**
 * Decode a `0x94` time-marker position uint32 into its kind + plain-ticks
 * position. The high bit `0x08000000` flags time-signature markers.
 */
export function decodeTimeMarkerPosition(raw: number): { kind: TimeMarkerKind; position: number } {
  if ((raw & TIME_SIGNATURE_BIT) !== 0) {
    return { kind: "signature", position: raw & ~TIME_SIGNATURE_BIT };
  }
  return { kind: "marker", position: raw };
}

/**
 * A per-arrangement track descriptor. Decoded from opcode `0xEE`
 * (per-track data blob); FL 25 base projects emit 500 of these per
 * arrangement.
 */
export type Track = {
  /** Zero-based index within the arrangement — derived from walker order. Presentation layer shifts to 1-based to match Python's flp-info. */
  index: number;
  /** FL's internal track iid (first uint32 of the TrackData blob). */
  iid?: number;
  /** User-set track name. Sourced from opcode `0xEF`. */
  name?: string;
  /** RGBA color stored in the blob's bytes 4-7 (uint32 LE, packed same as channel/insert colors). */
  color?: RGBA;
  /** Icon id (blob bytes 8-11, uint32 LE). */
  icon?: number;
  /** Enable flag (blob byte 12, u8 bool). Track-level "mute" is the inverse. */
  enabled?: boolean;
  /** Track height multiplier (blob bytes 13-16, float32 LE). FL's "100%" default is `1.0`. */
  height?: number;
  /** Track-locked flag from blob byte 48 (u8 bool). */
  locked?: boolean;
  /**
   * "Grouped with track above" flag from blob byte 47 (u8 bool).
   *
   * FL implements track grouping (parent/child collapsible tracks)
   * positionally: track N is a child of the nearest track at index <N
   * with `grouped == false`. So the parent inference is just "walk
   * up until you find an ungrouped track". A track at index 0 is
   * always a parent regardless of its flag.
   */
  grouped?: boolean;
};

/**
 * Decode a `0xEE` track-data payload into a `Track` record. Reads
 * the leading six fields — iid / color / icon / enabled / height /
 * (skip to offset 48) locked — which is what Python's `flp-info`
 * surfaces. The trailing motion / press / trigger_sync / queued /
 * tolerant / position_sync / grouped fields aren't exposed yet.
 *
 * FL 25 writes a fixed 70-byte payload per track; FL 20.9.1+ writes
 * ~66 bytes; older FL writes short records. Missing trailing bytes
 * just leave fields `undefined`.
 */
export function decodeTrackData(payload: Uint8Array, index: number): Track {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const track: Track = { index };
  if (payload.byteLength >= 4) track.iid = view.getUint32(0, true);
  if (payload.byteLength >= 8) {
    const raw = view.getUint32(4, true);
    track.color = {
      r: raw & 0xff,
      g: (raw >> 8) & 0xff,
      b: (raw >> 16) & 0xff,
      a: (raw >> 24) & 0xff,
    };
  }
  if (payload.byteLength >= 12) track.icon = view.getUint32(8, true);
  if (payload.byteLength >= 13) track.enabled = view.getUint8(12) !== 0;
  if (payload.byteLength >= 17) track.height = view.getFloat32(13, true);
  // Per PyFLP TrackEvent.STRUCT cumulative offsets:
  //   position_sync Int32ul → bytes 42-45 (ends at 46)
  //   grouped       Flag    → byte 46     (ends at 47)
  //   locked        Flag    → byte 47     (ends at 48)
  // We previously had these off-by-one (read byte 47 as grouped),
  // which silently set FL's "Lock to content" instead of "Group with
  // above track" on every reorganized auto track. Caught when Roman
  // observed the wrong checkbox state in FL's track menu (2026-05-07).
  if (payload.byteLength >= 47) track.grouped = view.getUint8(46) !== 0;
  if (payload.byteLength >= 48) track.locked = view.getUint8(47) !== 0;
  return track;
}

export type Arrangement = {
  /** FL-assigned arrangement id from opcode `0x63`. */
  id: number;
  /** User-assigned arrangement name, from opcode `0xF1`. Defaults to `"Arrangement"` on fresh FL 25 projects. */
  name?: string;
  /**
   * Per-track descriptors (opcode `0xEE`). FL 25 emits 500 track
   * slots by default, each carrying a 70-byte blob. Decoded into
   * `Track` records; per-track name (opcode `0xEF`) attaches to
   * the last-emitted track.
   */
  tracks: Track[];
  /**
   * Playlist clips on this arrangement's timeline, decoded from
   * opcode `0xE9`. FL omits the event entirely when there are no
   * clips — so an empty arrangement has `clips === []`, not undefined.
   */
  clips: Clip[];
  /**
   * Timeline markers — plain text markers and time-signature changes.
   * Empty when the user hasn't added any; FL doesn't emit default
   * markers on a fresh project.
   */
  timemarkers: TimeMarker[];
};

/**
 * Human-readable summary matching Python's flp-info format:
 *   "1 arrangement (500 tracks)"
 *   "2 arrangements (500 + 500 tracks)"
 */
export function formatArrangementSummary(arrangements: readonly Arrangement[]): string {
  const n = arrangements.length;
  if (n === 0) return "0 arrangements";
  const tracksPart = arrangements.map((a) => String(a.tracks.length)).join(" + ");
  const suffix = n === 1 ? `${tracksPart} tracks` : `${tracksPart} tracks`;
  const word = n === 1 ? "arrangement" : "arrangements";
  return `${n} ${word} (${suffix})`;
}
