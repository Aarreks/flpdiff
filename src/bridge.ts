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
  clonePattern,
  MutationError,
  type RGBA,
} from "./mutations/index.ts";

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
  "clone_pattern",
]);

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
  const { kind, args } = req;

  if (!READ_KINDS.has(kind) && !WRITE_KINDS.has(kind)) {
    const all = [...READ_KINDS, ...WRITE_KINDS].sort();
    return {
      ok: false,
      kind,
      error: "UNSUPPORTED_KIND",
      message: `unknown kind ${JSON.stringify(kind)}; supported: ${all.join(", ")}`,
    };
  }

  try {
    const path = requirePath(args);
    const project = loadProject(path);

    if (WRITE_KINDS.has(kind)) {
      return executeWrite(kind, args!, path, project);
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
        const arrIdx = Number((args!["arrangement"] ?? 0) as unknown);
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
        // OR locked OR disabled. FL emits 500 default tracks per
        // arrangement, all with the same default color + enabled=true,
        // so color/enable alone are not user-customisation signals.
        const all = arrs[arrIdx]!.tracks;
        const named = all.filter(
          (t) => t.name !== undefined || t.locked === true || t.enabled === false,
        );
        return {
          ok: true,
          kind,
          result: {
            arrangement: arrIdx,
            total_tracks: all.length,
            tracks: named.map((t) => ({
              index: t.index,
              iid: t.iid,
              name: t.name ?? null,
              color: t.color ?? null,
              enabled: t.enabled ?? null,
              locked: t.locked ?? null,
              height: t.height ?? null,
            })),
          },
        };
      }

      case "list_clips": {
        const arrIdx = Number((args!["arrangement"] ?? 0) as unknown);
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
