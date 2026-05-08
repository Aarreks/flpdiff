/**
 * `flpdiff bridge` — JSON-RPC entrypoint for offline FLP operations.
 *
 * Reads ONE JSON object from stdin (one line), executes the requested
 * read kind, writes ONE JSON object to stdout (one line). Designed
 * to be spawned per-call by the flstudio-mcp Python server (Phase
 * 3.1) so the canonical TS parser stays the single source of truth
 * for FL-format reads (decision #21 in MCP-SPEC.md).
 *
 * Contract:
 *
 *   stdin:  { "kind": "<kind>", "args": { "path": "...", ... } }
 *   stdout: { "ok": true,  "kind": "<kind>", "result": <kind-specific> }
 *           { "ok": false, "kind": "<kind>", "error": "<CODE>", "message": "..." }
 *
 * Always exits with status 0 once a JSON line is written. Status 1
 * only when stdin is unparseable / the program itself crashes before
 * a structured response is produced.
 *
 * Read kinds (Phase 3.0.5):
 *   - describe       → full FlpInfoJson
 *   - get_tempo      → { tempo_bpm }
 *   - list_channels  → array of channel summaries
 *   - list_mixer     → array of mixer insert summaries
 *   - list_patterns  → array of pattern summaries
 *   - list_plugins   → flat array of plugins discovered across channels + mixer
 *
 * Write kinds land in Phase 3.0.6, gated on the FLP serializer
 * (Phase 3.0.3). Until then, write kinds return UNSUPPORTED_KIND.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseFLPFile, getTempo } from "./parser/flp-project.ts";
import { FLPParseError } from "./parser/errors.ts";
import { serializeFLPProject } from "./parser/flp-write.ts";
import { buildProjectSummary } from "./summary.ts";
import { toFlpInfoJson } from "./presentation/flp-info.ts";
import {
  buildArrangements,
  buildChannels,
  buildPatterns,
} from "./parser/project-builder.ts";
import {
  setTempo,
  setPatternName,
  setChannelName,
  setInsertName,
  setTimeSignature,
  setChannelColor,
  setInsertColor,
  setPatternColor,
  setChannelRouting,
  setArrangementName,
  setTrackName,
  setTrackColor,
  setTrackGrouped,
  clonePattern,
  addClip,
  removeClip,
  moveClip,
  addPatternNote,
  setPatternNotes,
  removePatternNote,
  addPatternController,
  setPatternControllers,
  removePatternController,
  MutationError,
  type RGBA,
  type ClipPlacement,
  type ClipMatch,
} from "./mutations/index.ts";
import type { Controller, Note } from "./model/pattern.ts";
import { planReorganize, reorganizeProject } from "./reorganize/index.ts";

type BridgeRequest = {
  kind: string;
  args?: Record<string, unknown>;
};

type BridgeOk = {
  ok: true;
  kind: string;
  result: unknown;
};

type BridgeErr = {
  ok: false;
  kind: string;
  error: string;
  message: string;
};

type BridgeResponse = BridgeOk | BridgeErr;

const READ_KINDS = new Set([
  "describe",
  "get_tempo",
  "list_channels",
  "list_mixer",
  "list_patterns",
  "list_plugins",
  "list_arrangements",
  "list_tracks",
  "list_clips",
]);

const WRITE_KINDS = new Set([
  "set_tempo",
  "set_pattern_name",
  "set_channel_name",
  "set_insert_name",
  "set_time_signature",
  "set_channel_color",
  "set_insert_color",
  "set_pattern_color",
  "set_channel_routing",
  "set_arrangement_name",
  "set_track_name",
  "set_track_color",
  "set_track_grouped",
  "clone_pattern",
  "add_clip",
  "remove_clip",
  "move_clip",
  "reorganize_project",
  "add_pattern_note",
  "set_pattern_notes",
  "remove_pattern_note",
  "add_pattern_controller",
  "set_pattern_controllers",
  "remove_pattern_controller",
]);

function parsePlacementArg(args: Record<string, unknown>): ClipPlacement {
  const kind = args["kind"];
  if (kind !== "pattern" && kind !== "channel") {
    throw new MutationError("INVALID_ARGS", "args.kind must be 'pattern' or 'channel'");
  }
  const refId = Number(args["ref_id"]);
  const trackIdx = Number(args["track_index"]);
  const pos = Number(args["position_ticks"]);
  const len = Number(args["length_ticks"]);
  if (![refId, trackIdx, pos, len].every(Number.isFinite)) {
    throw new MutationError(
      "INVALID_ARGS",
      "args.ref_id, args.track_index, args.position_ticks, args.length_ticks all required (numbers)",
    );
  }
  return {
    kind,
    ref_id: refId,
    track_index: trackIdx,
    position_ticks: pos,
    length_ticks: len,
  };
}

function parseMatchArg(args: Record<string, unknown>): ClipMatch {
  const trackIdx = Number(args["track_index"]);
  if (!Number.isFinite(trackIdx)) {
    throw new MutationError("INVALID_ARGS", "args.track_index is required (non-negative integer)");
  }
  const out: ClipMatch = { track_index: trackIdx };
  if (args["position_ticks"] !== undefined) {
    const p = Number(args["position_ticks"]);
    if (!Number.isFinite(p)) {
      throw new MutationError("INVALID_ARGS", "args.position_ticks must be number when provided");
    }
    out.position_ticks = p;
  }
  if (args["ref_id"] !== undefined) {
    const r = Number(args["ref_id"]);
    if (!Number.isFinite(r)) {
      throw new MutationError("INVALID_ARGS", "args.ref_id must be number when provided");
    }
    out.ref_id = r;
  }
  if (args["kind"] !== undefined) {
    if (args["kind"] !== "pattern" && args["kind"] !== "channel") {
      throw new MutationError("INVALID_ARGS", "args.kind must be 'pattern' or 'channel'");
    }
    out.kind = args["kind"];
  }
  return out;
}

/**
 * Build a `Note` from flat bridge args (or from a single nested object).
 * `addPatternNote` accepts position/channel_iid/length/key as required;
 * everything else falls back to FL's neutral defaults so the LLM can
 * emit minimal calls (and slide-flag is the bit user usually wants).
 */
function parseNoteArgs(args: Record<string, unknown>): Note {
  const num = (k: string, required: boolean, def?: number): number => {
    const raw = args[k];
    if (raw === undefined || raw === null) {
      if (required) {
        throw new MutationError("INVALID_ARGS", `args.${k} is required (number)`);
      }
      return def!;
    }
    const v = Number(raw);
    if (!Number.isFinite(v)) {
      throw new MutationError("INVALID_ARGS", `args.${k} must be a finite number, got ${raw}`);
    }
    return v;
  };
  let flags = num("flags", false, 0);
  if (args["slide"] !== undefined) {
    if (typeof args["slide"] !== "boolean") {
      throw new MutationError("INVALID_ARGS", "args.slide must be boolean when provided");
    }
    if (args["slide"]) flags |= 0x08;
    else flags &= ~0x08;
  }
  return {
    position: num("position", true),
    channel_iid: num("channel_iid", true),
    length: num("length", true),
    key: num("key", true),
    flags,
    slide: (flags & 0x08) !== 0,
    group: num("group", false, 0),
    fine_pitch: num("fine_pitch", false, 120),
    release: num("release", false, 64),
    midi_channel: num("midi_channel", false, 0),
    pan: num("pan", false, 64),
    velocity: num("velocity", false, 100),
    mod_x: num("mod_x", false, 128),
    mod_y: num("mod_y", false, 128),
  };
}

/**
 * Build a `Controller` from flat bridge args. Required: position,
 * channel, value. Optional: flags (default 0).
 */
function parseControllerArgs(args: Record<string, unknown>): Controller {
  const num = (k: string, required: boolean, def?: number): number => {
    const raw = args[k];
    if (raw === undefined || raw === null) {
      if (required) {
        throw new MutationError("INVALID_ARGS", `args.${k} is required (number)`);
      }
      return def!;
    }
    const v = Number(raw);
    if (!Number.isFinite(v)) {
      throw new MutationError("INVALID_ARGS", `args.${k} must be a finite number, got ${raw}`);
    }
    return v;
  };
  return {
    position: num("position", true),
    channel: num("channel", true),
    value: num("value", true),
    flags: num("flags", false, 0),
  };
}

function parseRGBAArg(args: Record<string, unknown>): RGBA {
  const c = args["color"];
  if (!c || typeof c !== "object") {
    throw new MutationError("INVALID_ARGS", "args.color is required (object {r,g,b,a?})");
  }
  const obj = c as Record<string, unknown>;
  const r = Number(obj["r"]);
  const g = Number(obj["g"]);
  const b = Number(obj["b"]);
  const aRaw = obj["a"];
  const a = aRaw === undefined ? 0 : Number(aRaw);
  if (![r, g, b, a].every(Number.isFinite)) {
    throw new MutationError("INVALID_ARGS", "args.color components must be numeric");
  }
  return { r, g, b, a };
}

// Per-kind allowed-args table. `path` is implicit on every kind that
// requires loading a file. Aliases get renamed to the canonical name
// during normalisation; anything else is rejected.
const ALLOWED_ARGS: Record<string, ReadonlySet<string>> = {
  // reads
  describe: new Set(["path"]),
  get_tempo: new Set(["path"]),
  list_channels: new Set(["path"]),
  list_mixer: new Set(["path"]),
  list_patterns: new Set(["path"]),
  list_plugins: new Set(["path"]),
  list_arrangements: new Set(["path"]),
  list_tracks: new Set(["path", "arrangement"]),
  list_clips: new Set(["path", "arrangement"]),
  // writes
  set_tempo: new Set(["path", "bpm"]),
  set_pattern_name: new Set(["path", "iid", "name"]),
  set_channel_name: new Set(["path", "iid", "name"]),
  set_insert_name: new Set(["path", "index", "name"]),
  set_time_signature: new Set(["path", "numerator", "denominator"]),
  set_channel_color: new Set(["path", "iid", "color"]),
  set_insert_color: new Set(["path", "index", "color"]),
  set_pattern_color: new Set(["path", "iid", "color"]),
  set_channel_routing: new Set(["path", "iid", "target_insert"]),
  set_arrangement_name: new Set(["path", "id", "name"]),
  set_track_name: new Set(["path", "arrangement", "track", "name"]),
  set_track_color: new Set(["path", "arrangement", "track", "color"]),
  set_track_grouped: new Set(["path", "arrangement", "track", "grouped"]),
  clone_pattern: new Set(["path", "source_iid", "name"]),
  add_clip: new Set([
    "path",
    "arrangement",
    "kind",
    "ref_id",
    "track_index",
    "position_ticks",
    "length_ticks",
  ]),
  remove_clip: new Set([
    "path",
    "arrangement",
    "track_index",
    "position_ticks",
    "ref_id",
    "kind",
  ]),
  move_clip: new Set([
    "path",
    "arrangement",
    "track_index",
    "position_ticks",
    "ref_id",
    "kind",
    "to_track_index",
    "to_position_ticks",
  ]),
  reorganize_project: new Set([
    "path",
    "arrangement",
    "add_family_separators",
    "dry_run",
  ]),
  add_pattern_note: new Set([
    "path",
    "pattern_id",
    "position",
    "channel_iid",
    "length",
    "key",
    "velocity",
    "pan",
    "fine_pitch",
    "release",
    "midi_channel",
    "mod_x",
    "mod_y",
    "group",
    "flags",
    "slide",
  ]),
  set_pattern_notes: new Set(["path", "pattern_id", "notes"]),
  remove_pattern_note: new Set(["path", "pattern_id", "index"]),
  add_pattern_controller: new Set([
    "path",
    "pattern_id",
    "position",
    "channel",
    "value",
    "flags",
  ]),
  set_pattern_controllers: new Set(["path", "pattern_id", "controllers"]),
  remove_pattern_controller: new Set(["path", "pattern_id", "index"]),
};

// Common LLM-natural aliases → canonical arg name. Applied per-kind
// AFTER unknown-key check, so `arrangement_id: 6` becomes `arrangement: 6`
// rather than being silently dropped.
const ARG_ALIASES: Record<string, string> = {
  arrangement_id: "arrangement",
  arrangementId: "arrangement",
  track_id: "track",
  trackId: "track",
  channel_iid: "iid",
  channelIid: "iid",
  pattern_iid: "iid",
  patternIid: "iid",
  insert_idx: "index",
  insertIdx: "index",
  insert_index: "index",
  insertIndex: "index",
  arrangement_name: "name",
  bpm_value: "bpm",
};

function normaliseArgs(
  kind: string,
  rawArgs: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!rawArgs) return {};
  const allowed = ALLOWED_ARGS[kind];
  if (!allowed) return rawArgs; // unknown kind — let dispatcher handle
  const out: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(rawArgs)) {
    // Prefer the key as-is when the kind already accepts it. Without this
    // check, args like `channel_iid` get rewritten to `iid` via the alias
    // table even on kinds (e.g. `add_pattern_note`) where the canonical
    // name IS `channel_iid`.
    const canonical = allowed.has(key) ? key : (ARG_ALIASES[key] ?? key);
    if (!allowed.has(canonical)) {
      unknown.push(key);
      continue;
    }
    if (canonical in out) {
      throw new BridgeError(
        "INVALID_ARGS",
        `args.${canonical} supplied twice (also via alias '${key}')`,
      );
    }
    out[canonical] = value;
  }
  if (unknown.length > 0) {
    throw new BridgeError(
      "INVALID_ARGS",
      `unknown args for ${kind}: ${unknown.join(", ")}; allowed: ${[...allowed].sort().join(", ")}`,
    );
  }
  return out;
}

function readStdinSync(): string {
  // Bun/Node accept fd 0 for stdin. Slurps until EOF, returns full buffer.
  return readFileSync(0, "utf-8");
}

function loadProject(path: string) {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw new BridgeError("FILE_NOT_FOUND", `flp file not found: ${abs}`);
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(abs);
  } catch (err) {
    throw new BridgeError(
      "READ_ERROR",
      `cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return parseFLPFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  } catch (err) {
    if (err instanceof FLPParseError) {
      throw new BridgeError("PARSE_ERROR", err.message);
    }
    throw err;
  }
}

class BridgeError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

function executeWrite(
  kind: string,
  args: Record<string, unknown>,
  path: string,
  project: Awaited<ReturnType<typeof loadProject>>,
): BridgeResponse {
  try {
    let mutated = project;
    if (kind === "set_tempo") {
      const bpm = Number(args["bpm"]);
      if (!Number.isFinite(bpm)) {
        throw new MutationError("INVALID_ARGS", "args.bpm is required (number)");
      }
      mutated = setTempo(project, bpm);
    } else if (kind === "set_pattern_name") {
      const iid = Number(args["iid"]);
      const name = args["name"];
      if (!Number.isFinite(iid)) {
        throw new MutationError("INVALID_ARGS", "args.iid is required (positive integer)");
      }
      if (typeof name !== "string") {
        throw new MutationError("INVALID_ARGS", "args.name is required (string)");
      }
      mutated = setPatternName(project, iid, name);
    } else if (kind === "set_channel_name") {
      const iid = Number(args["iid"]);
      const name = args["name"];
      if (!Number.isFinite(iid)) {
        throw new MutationError("INVALID_ARGS", "args.iid is required (non-negative integer)");
      }
      if (typeof name !== "string") {
        throw new MutationError("INVALID_ARGS", "args.name is required (string)");
      }
      mutated = setChannelName(project, iid, name);
    } else if (kind === "set_insert_name") {
      const index = Number(args["index"]);
      const name = args["name"];
      if (!Number.isFinite(index)) {
        throw new MutationError("INVALID_ARGS", "args.index is required (non-negative integer)");
      }
      if (typeof name !== "string") {
        throw new MutationError("INVALID_ARGS", "args.name is required (string)");
      }
      mutated = setInsertName(project, index, name);
    } else if (kind === "set_time_signature") {
      const num = Number(args["numerator"]);
      const denom = Number(args["denominator"]);
      if (!Number.isFinite(num)) {
        throw new MutationError("INVALID_ARGS", "args.numerator is required (positive integer)");
      }
      if (!Number.isFinite(denom)) {
        throw new MutationError("INVALID_ARGS", "args.denominator is required (power-of-2 integer)");
      }
      mutated = setTimeSignature(project, num, denom);
    } else if (kind === "set_channel_color") {
      const iid = Number(args["iid"]);
      if (!Number.isFinite(iid)) {
        throw new MutationError("INVALID_ARGS", "args.iid is required (non-negative integer)");
      }
      mutated = setChannelColor(project, iid, parseRGBAArg(args));
    } else if (kind === "set_insert_color") {
      const index = Number(args["index"]);
      if (!Number.isFinite(index)) {
        throw new MutationError("INVALID_ARGS", "args.index is required (non-negative integer)");
      }
      mutated = setInsertColor(project, index, parseRGBAArg(args));
    } else if (kind === "set_pattern_color") {
      const iid = Number(args["iid"]);
      if (!Number.isFinite(iid)) {
        throw new MutationError("INVALID_ARGS", "args.iid is required (positive integer)");
      }
      mutated = setPatternColor(project, iid, parseRGBAArg(args));
    } else if (kind === "set_channel_routing") {
      const iid = Number(args["iid"]);
      const target = Number(args["target_insert"]);
      if (!Number.isFinite(iid)) {
        throw new MutationError("INVALID_ARGS", "args.iid is required (non-negative integer)");
      }
      if (!Number.isFinite(target)) {
        throw new MutationError("INVALID_ARGS", "args.target_insert is required (-1 or 0..127)");
      }
      mutated = setChannelRouting(project, iid, target);
    } else if (kind === "set_arrangement_name") {
      const id = Number(args["id"] ?? 0);
      const name = args["name"];
      if (!Number.isFinite(id)) {
        throw new MutationError("INVALID_ARGS", "args.id must be a non-negative integer");
      }
      if (typeof name !== "string") {
        throw new MutationError("INVALID_ARGS", "args.name is required (string)");
      }
      mutated = setArrangementName(project, id, name);
    } else if (kind === "set_track_name") {
      const arrId = Number(args["arrangement"] ?? 0);
      const trackIdx = Number(args["track"]);
      const name = args["name"];
      if (!Number.isFinite(arrId)) {
        throw new MutationError("INVALID_ARGS", "args.arrangement must be a non-negative integer");
      }
      if (!Number.isFinite(trackIdx)) {
        throw new MutationError("INVALID_ARGS", "args.track is required (non-negative integer)");
      }
      if (typeof name !== "string") {
        throw new MutationError("INVALID_ARGS", "args.name is required (string)");
      }
      mutated = setTrackName(project, arrId, trackIdx, name);
    } else if (kind === "set_track_color") {
      const arrId = Number(args["arrangement"] ?? 0);
      const trackIdx = Number(args["track"]);
      if (!Number.isFinite(arrId)) {
        throw new MutationError("INVALID_ARGS", "args.arrangement must be a non-negative integer");
      }
      if (!Number.isFinite(trackIdx)) {
        throw new MutationError("INVALID_ARGS", "args.track is required (non-negative integer)");
      }
      mutated = setTrackColor(project, arrId, trackIdx, parseRGBAArg(args));
    } else if (kind === "add_clip") {
      const arrId = Number(args["arrangement"] ?? 0);
      if (!Number.isFinite(arrId)) {
        throw new MutationError("INVALID_ARGS", "args.arrangement must be a non-negative integer");
      }
      mutated = addClip(project, arrId, parsePlacementArg(args));
    } else if (kind === "remove_clip") {
      const arrId = Number(args["arrangement"] ?? 0);
      if (!Number.isFinite(arrId)) {
        throw new MutationError("INVALID_ARGS", "args.arrangement must be a non-negative integer");
      }
      mutated = removeClip(project, arrId, parseMatchArg(args));
    } else if (kind === "move_clip") {
      const arrId = Number(args["arrangement"] ?? 0);
      if (!Number.isFinite(arrId)) {
        throw new MutationError("INVALID_ARGS", "args.arrangement must be a non-negative integer");
      }
      const to: { track_index?: number; position_ticks?: number } = {};
      if (args["to_track_index"] !== undefined) {
        const t = Number(args["to_track_index"]);
        if (!Number.isFinite(t)) {
          throw new MutationError("INVALID_ARGS", "args.to_track_index must be a number");
        }
        to.track_index = t;
      }
      if (args["to_position_ticks"] !== undefined) {
        const p = Number(args["to_position_ticks"]);
        if (!Number.isFinite(p)) {
          throw new MutationError("INVALID_ARGS", "args.to_position_ticks must be a number");
        }
        to.position_ticks = p;
      }
      mutated = moveClip(project, arrId, parseMatchArg(args), to);
    } else if (kind === "set_track_grouped") {
      const arrId = Number(args["arrangement"] ?? 0);
      const trackIdx = Number(args["track"]);
      const grouped = args["grouped"];
      if (!Number.isFinite(arrId)) {
        throw new MutationError("INVALID_ARGS", "args.arrangement must be a non-negative integer");
      }
      if (!Number.isFinite(trackIdx)) {
        throw new MutationError("INVALID_ARGS", "args.track is required (non-negative integer)");
      }
      if (typeof grouped !== "boolean") {
        throw new MutationError("INVALID_ARGS", "args.grouped is required (boolean)");
      }
      mutated = setTrackGrouped(project, arrId, trackIdx, grouped);
    } else if (kind === "clone_pattern") {
      const iid = Number(args["source_iid"]);
      const newName = args["name"];
      if (!Number.isFinite(iid)) {
        throw new MutationError("INVALID_ARGS", "args.source_iid is required (positive integer)");
      }
      if (newName !== undefined && typeof newName !== "string") {
        throw new MutationError("INVALID_ARGS", "args.name must be a string when provided");
      }
      mutated = clonePattern(project, iid, newName);
    } else if (kind === "reorganize_project") {
      // Playlist-only Ableton-style reorganize: classify each clip by
      // its referenced channel/pattern, lay tracks out in family
      // blocks ([Drums], [Bass], …), move clips to their target
      // tracks, set track name + color. NEVER touches channels,
      // mixer inserts, or patterns — those carry intentional engineering.
      const arrId = Number(args["arrangement"] ?? 0);
      const addSep = args["add_family_separators"];
      const dryRun = args["dry_run"];
      if (!Number.isFinite(arrId) || arrId < 0) {
        throw new MutationError(
          "INVALID_ARGS",
          "args.arrangement must be a non-negative integer",
        );
      }
      if (addSep !== undefined && typeof addSep !== "boolean") {
        throw new MutationError(
          "INVALID_ARGS",
          "args.add_family_separators must be boolean when provided",
        );
      }
      if (dryRun !== undefined && typeof dryRun !== "boolean") {
        throw new MutationError("INVALID_ARGS", "args.dry_run must be boolean when provided");
      }

      const opts = {
        arrangementId: arrId,
        addFamilySeparators: addSep as boolean | undefined,
      };

      if (dryRun === true) {
        // Plan only — never call applyReorganize (its moveClip can throw
        // when the project's clip layout is unusual; dry-run must be safe).
        const plan = planReorganize(project, opts);
        return {
          ok: true,
          kind,
          result: {
            path: resolve(path),
            dry_run: true,
            mutations_applied: 0,
            plan,
          },
        };
      }
      const result = reorganizeProject(project, opts);
      mutated = result.project;
      const bytes = serializeFLPProject(mutated);
      writeFileSync(resolve(path), bytes);
      return {
        ok: true,
        kind,
        result: {
          path: resolve(path),
          bytes_written: bytes.byteLength,
          mutations_applied: result.mutationsApplied,
          plan: result.plan,
        },
      };
    } else if (kind === "add_pattern_note") {
      const patternId = Number(args["pattern_id"]);
      if (!Number.isFinite(patternId)) {
        throw new MutationError(
          "INVALID_ARGS",
          "args.pattern_id is required (positive integer)",
        );
      }
      mutated = addPatternNote(project, patternId, parseNoteArgs(args));
    } else if (kind === "set_pattern_notes") {
      const patternId = Number(args["pattern_id"]);
      if (!Number.isFinite(patternId)) {
        throw new MutationError(
          "INVALID_ARGS",
          "args.pattern_id is required (positive integer)",
        );
      }
      const rawNotes = args["notes"];
      if (!Array.isArray(rawNotes)) {
        throw new MutationError(
          "INVALID_ARGS",
          "args.notes is required (array of note objects, possibly empty)",
        );
      }
      const notes: Note[] = rawNotes.map((n, i) => {
        if (!n || typeof n !== "object") {
          throw new MutationError("INVALID_ARGS", `args.notes[${i}] must be an object`);
        }
        return parseNoteArgs(n as Record<string, unknown>);
      });
      mutated = setPatternNotes(project, patternId, notes);
    } else if (kind === "remove_pattern_note") {
      const patternId = Number(args["pattern_id"]);
      const index = Number(args["index"]);
      if (!Number.isFinite(patternId)) {
        throw new MutationError(
          "INVALID_ARGS",
          "args.pattern_id is required (positive integer)",
        );
      }
      if (!Number.isFinite(index)) {
        throw new MutationError(
          "INVALID_ARGS",
          "args.index is required (non-negative integer)",
        );
      }
      mutated = removePatternNote(project, patternId, index);
    } else if (kind === "add_pattern_controller") {
      const patternId = Number(args["pattern_id"]);
      if (!Number.isFinite(patternId)) {
        throw new MutationError(
          "INVALID_ARGS",
          "args.pattern_id is required (positive integer)",
        );
      }
      mutated = addPatternController(project, patternId, parseControllerArgs(args));
    } else if (kind === "set_pattern_controllers") {
      const patternId = Number(args["pattern_id"]);
      if (!Number.isFinite(patternId)) {
        throw new MutationError(
          "INVALID_ARGS",
          "args.pattern_id is required (positive integer)",
        );
      }
      const rawCtrls = args["controllers"];
      if (!Array.isArray(rawCtrls)) {
        throw new MutationError(
          "INVALID_ARGS",
          "args.controllers is required (array of controller objects, possibly empty)",
        );
      }
      const ctrls: Controller[] = rawCtrls.map((c, i) => {
        if (!c || typeof c !== "object") {
          throw new MutationError("INVALID_ARGS", `args.controllers[${i}] must be an object`);
        }
        return parseControllerArgs(c as Record<string, unknown>);
      });
      mutated = setPatternControllers(project, patternId, ctrls);
    } else if (kind === "remove_pattern_controller") {
      const patternId = Number(args["pattern_id"]);
      const index = Number(args["index"]);
      if (!Number.isFinite(patternId)) {
        throw new MutationError(
          "INVALID_ARGS",
          "args.pattern_id is required (positive integer)",
        );
      }
      if (!Number.isFinite(index)) {
        throw new MutationError(
          "INVALID_ARGS",
          "args.index is required (non-negative integer)",
        );
      }
      mutated = removePatternController(project, patternId, index);
    } else {
      return {
        ok: false,
        kind,
        error: "UNKNOWN",
        message: `write dispatcher fell through for kind=${kind}`,
      };
    }

    const bytes = serializeFLPProject(mutated);
    writeFileSync(resolve(path), bytes);
    return {
      ok: true,
      kind,
      result: { path: resolve(path), bytes_written: bytes.byteLength },
    };
  } catch (err) {
    if (err instanceof MutationError) {
      return { ok: false, kind, error: err.code, message: err.message };
    }
    if (err instanceof BridgeError) {
      return { ok: false, kind, error: err.code, message: err.message };
    }
    return {
      ok: false,
      kind,
      error: "UNKNOWN",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}


function requirePath(args: Record<string, unknown> | undefined): string {
  const path = args?.["path"];
  if (typeof path !== "string" || !path) {
    throw new BridgeError("INVALID_ARGS", "args.path is required (non-empty string)");
  }
  return path;
}

function execute(req: BridgeRequest): BridgeResponse {
  const { kind, args: rawArgs } = req;

  if (!READ_KINDS.has(kind) && !WRITE_KINDS.has(kind)) {
    const all = [...READ_KINDS, ...WRITE_KINDS].sort();
    return {
      ok: false,
      kind,
      error: "UNSUPPORTED_KIND",
      message: `unknown kind ${JSON.stringify(kind)}; supported: ${all.join(", ")}`,
    };
  }

  let args: Record<string, unknown>;
  try {
    args = normaliseArgs(kind, rawArgs);
  } catch (err) {
    if (err instanceof BridgeError) {
      return { ok: false, kind, error: err.code, message: err.message };
    }
    return {
      ok: false,
      kind,
      error: "UNKNOWN",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const path = requirePath(args);
    const project = loadProject(path);

    if (WRITE_KINDS.has(kind)) {
      return executeWrite(kind, args, path, project);
    }

    switch (kind) {
      case "describe":
        return { ok: true, kind, result: toFlpInfoJson(project) };

      case "get_tempo": {
        const tempo = getTempo(project);
        return {
          ok: true,
          kind,
          result: { tempo_bpm: tempo },
        };
      }

      case "list_channels": {
        const summary = buildProjectSummary(project);
        return { ok: true, kind, result: summary.channels };
      }

      case "list_mixer": {
        const summary = buildProjectSummary(project);
        return { ok: true, kind, result: summary.inserts };
      }

      case "list_patterns": {
        const summary = buildProjectSummary(project);
        return { ok: true, kind, result: summary.patterns };
      }

      case "list_plugins": {
        const summary = buildProjectSummary(project);
        const plugins: Array<{
          scope: "channel" | "mixer";
          channel_index?: number;
          insert_index?: number;
          slot_index?: number;
          name: string;
          vendor: string | null;
        }> = [];
        for (const ch of summary.channels) {
          if (ch.plugin) {
            plugins.push({
              scope: "channel",
              channel_index: ch.iid,
              name: ch.plugin.name,
              vendor: ch.plugin.vendor,
            });
          }
        }
        for (const ins of summary.inserts) {
          for (const slot of ins.slots) {
            if (slot.plugin) {
              plugins.push({
                scope: "mixer",
                insert_index: ins.index,
                slot_index: slot.index,
                name: slot.plugin.name,
                vendor: slot.plugin.vendor,
              });
            }
          }
        }
        return { ok: true, kind, result: plugins };
      }

      case "list_arrangements": {
        const channels = buildChannels(project.events, project.metadata);
        const patterns = buildPatterns(project.events, project.metadata);
        const arrs = buildArrangements(project.events, channels, patterns, project.metadata);
        return {
          ok: true,
          kind,
          result: arrs.map((a) => ({
            id: a.id,
            name: a.name ?? null,
            track_count: a.tracks.length,
            clip_count: a.clips.length,
            timemarker_count: a.timemarkers.length,
          })),
        };
      }

      case "list_tracks": {
        const arrIdx = Number((args["arrangement"] ?? 0) as unknown);
        const channels = buildChannels(project.events, project.metadata);
        const patterns = buildPatterns(project.events, project.metadata);
        const arrs = buildArrangements(project.events, channels, patterns, project.metadata);
        if (!Number.isInteger(arrIdx) || arrIdx < 0 || arrIdx >= arrs.length) {
          return {
            ok: false,
            kind,
            error: "INVALID_ARGS",
            message: `args.arrangement out of range; project has ${arrs.length} arrangement(s)`,
          };
        }
        // Filter to user-customised tracks only — tracks with a name
        // OR locked OR disabled OR grouped (group children are
        // user-set even on tracks left otherwise default). FL emits
        // 500 default tracks per arrangement.
        const all = arrs[arrIdx]!.tracks;
        const named = all.filter(
          (t) =>
            t.name !== undefined ||
            t.locked === true ||
            t.enabled === false ||
            t.grouped === true,
        );
        // Compute parent track per index: the nearest earlier track
        // with grouped=false. Track 0 is always its own parent.
        const parentByIndex = new Map<number, number>();
        let lastParent = 0;
        for (const t of all) {
          if (t.grouped !== true || t.index === 0) lastParent = t.index;
          parentByIndex.set(t.index, lastParent);
        }
        return {
          ok: true,
          kind,
          result: {
            arrangement: arrIdx,
            total_tracks: all.length,
            tracks: named.map((t) => {
              const parent = parentByIndex.get(t.index)!;
              return {
                index: t.index,
                iid: t.iid,
                name: t.name ?? null,
                color: t.color ?? null,
                enabled: t.enabled ?? null,
                locked: t.locked ?? null,
                height: t.height ?? null,
                grouped: t.grouped ?? false,
                parent_index: parent === t.index ? null : parent,
              };
            }),
          },
        };
      }

      case "list_clips": {
        const arrIdx = Number((args["arrangement"] ?? 0) as unknown);
        const channels = buildChannels(project.events, project.metadata);
        const patterns = buildPatterns(project.events, project.metadata);
        const arrs = buildArrangements(project.events, channels, patterns, project.metadata);
        if (!Number.isInteger(arrIdx) || arrIdx < 0 || arrIdx >= arrs.length) {
          return {
            ok: false,
            kind,
            error: "INVALID_ARGS",
            message: `args.arrangement out of range; project has ${arrs.length} arrangement(s)`,
          };
        }
        const PATTERN_BASE = 20480;
        const TRACK_MAX = 499;
        return {
          ok: true,
          kind,
          result: arrs[arrIdx]!.clips.map((c) => {
            const isPattern = c.item_index > PATTERN_BASE;
            return {
              position_ticks: c.position,
              length_ticks: c.length,
              // Un-reverse track index so 0 = top track in FL's display.
              track_index: TRACK_MAX - c.track_rvidx,
              kind: isPattern ? "pattern" : "channel",
              ref_id: isPattern ? c.item_index - PATTERN_BASE : c.item_index,
              group: c.group,
              flags: c.item_flags,
            };
          }),
        };
      }
    }
    return {
      ok: false,
      kind,
      error: "UNKNOWN",
      message: `dispatcher fell through for kind=${kind}`,
    };
  } catch (err) {
    if (err instanceof BridgeError) {
      return { ok: false, kind, error: err.code, message: err.message };
    }
    return {
      ok: false,
      kind,
      error: "UNKNOWN",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function bridgeMain(): Promise<number> {
  let raw: string;
  try {
    raw = readStdinSync().trim();
  } catch (err) {
    process.stderr.write(`bridge: stdin read failed: ${err}\n`);
    return 1;
  }
  if (!raw) {
    process.stderr.write("bridge: empty stdin (expected one JSON object)\n");
    return 1;
  }

  let req: BridgeRequest;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { kind?: unknown }).kind !== "string"
    ) {
      throw new Error("expected object with string `kind`");
    }
    req = parsed as BridgeRequest;
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        kind: "?",
        error: "INVALID_REQUEST",
        message: err instanceof Error ? err.message : String(err),
      }) + "\n",
    );
    return 0;
  }

  const response = execute(req);
  await writeStdoutAndFlush(JSON.stringify(response) + "\n");
  return 0;
}


async function writeStdoutAndFlush(data: string): Promise<void> {
  // Bun/Node's process.stdout is buffered. For large payloads (e.g.
  // describe ~100KB) the process can exit before the write drains,
  // truncating the JSON delivered to the parent. Explicitly wait
  // for the write callback before returning.
  await new Promise<void>((resolveCb, rejectCb) => {
    const flushed = process.stdout.write(data, (err) => {
      if (err) rejectCb(err);
      else resolveCb();
    });
    if (flushed) {
      // Buffer accepted synchronously — the callback may still fire
      // later; wait for it just in case.
    }
  });
}
