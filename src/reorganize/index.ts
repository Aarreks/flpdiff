/**
 * Code-level Ableton-style reorganize for FL Studio projects.
 *
 * Pure deterministic logic — no LLM. Classifies channels via regex
 * matching on name + sample_path, falling back to MIDI-pitch buckets
 * for unnamed plugin channels (e.g. Serum). Then assigns each enabled
 * channel a dedicated mixer insert (1, 2, 3, ...), applies semantic
 * names + palette colors per group, and recolors patterns by the
 * dominant channel they reference.
 *
 * Decision: this module owns the rule layer (orchestration + classifier).
 * The atomic mutations (`setChannelName`, `setChannelRouting`, etc.)
 * remain in `mutations/index.ts` — we just compose them.
 *
 * Invariants the algorithm guarantees on a successful run (verified by
 * the harness in `mcp/tests/e2e/harness/invariants.py`):
 *   1. Every named channel/insert/pattern has a semantic name.
 *   2. Every enabled channel routes to its own non-Master insert (1..N).
 *   3. Colors come from `PALETTE`.
 *   4. Clip count + per-pattern note count unchanged.
 *   5. Bit-exact round-trip via the canonical serializer.
 */

import type { FLPProject } from "../parser/flp-project.ts";
import type { Note, Pattern } from "../model/pattern.ts";
import type { Channel, RGBA } from "../model/channel.ts";
import {
  setChannelColor,
  setChannelName,
  setChannelRouting,
  setInsertColor,
  setInsertName,
  setPatternColor,
  setPatternName,
} from "../mutations/index.ts";

// --------------------------------------------------------------------------- //
// Palette + classifier                                                         //
// --------------------------------------------------------------------------- //

export type GroupKey =
  | "drums_hard"
  | "drums_soft"
  | "bass"
  | "lead"
  | "pad"
  | "fx"
  | "vocal";

export type Group = {
  /** Logical bucket. Drives palette choice. */
  key: GroupKey;
  /** Default semantic name for a freshly-classified channel in this group. */
  name: string;
  /** Color RGB (alpha defaults to 0 to match how the bridge round-trips user-set FL colors). */
  rgb: { r: number; g: number; b: number };
};

/**
 * Ordered (keyword, Group) pairs. Earlier entries take precedence on
 * ambiguous matches. Order matters: most-specific first.
 *
 * (We use an array, not a plain object, because JS sorts numeric-like
 * object keys ahead of string keys — `"808"` would jump to the front
 * of `Object.keys` and shadow `kick` for inputs like "808 Kick".)
 */
const PALETTE_DRUMS_HARD = { r: 233, g: 75, b: 60 };
const PALETTE_DRUMS_SOFT = { r: 255, g: 140, b: 66 };
const PALETTE_BASS = { r: 59, g: 130, b: 246 };
const PALETTE_LEAD = { r: 34, g: 197, b: 94 };
const PALETTE_PAD = { r: 139, g: 92, b: 246 };
const PALETTE_FX = { r: 236, g: 72, b: 153 };
const PALETTE_VOCAL = { r: 250, g: 204, b: 21 };

export const GROUP_ENTRIES: Array<[string, Group]> = [
  // Drums first — most specific.
  ["kick", { key: "drums_hard", name: "Kick", rgb: PALETTE_DRUMS_HARD }],
  ["snare", { key: "drums_hard", name: "Snare", rgb: PALETTE_DRUMS_HARD }],
  ["clap", { key: "drums_hard", name: "Clap", rgb: PALETTE_DRUMS_HARD }],
  ["rim", { key: "drums_hard", name: "Rim", rgb: PALETTE_DRUMS_HARD }],
  ["hat", { key: "drums_soft", name: "HiHat", rgb: PALETTE_DRUMS_SOFT }],
  ["perc", { key: "drums_soft", name: "Perc", rgb: PALETTE_DRUMS_SOFT }],
  ["tom", { key: "drums_soft", name: "Tom", rgb: PALETTE_DRUMS_SOFT }],
  ["shaker", { key: "drums_soft", name: "Shaker", rgb: PALETTE_DRUMS_SOFT }],
  ["cymbal", { key: "drums_soft", name: "Cymbal", rgb: PALETTE_DRUMS_SOFT }],
  // Vocal before lead — "Lead Vox" reads as a vocal track, not a lead synth.
  ["vox", { key: "vocal", name: "Vocal", rgb: PALETTE_VOCAL }],
  ["vocal", { key: "vocal", name: "Vocal", rgb: PALETTE_VOCAL }],
  // Bass.
  ["bass", { key: "bass", name: "Bass", rgb: PALETTE_BASS }],
  ["sub", { key: "bass", name: "Sub Bass", rgb: PALETTE_BASS }],
  ["808", { key: "bass", name: "808", rgb: PALETTE_BASS }],
  // Lead/melody/synth.
  ["lead", { key: "lead", name: "Lead", rgb: PALETTE_LEAD }],
  ["melody", { key: "lead", name: "Melody", rgb: PALETTE_LEAD }],
  ["arp", { key: "lead", name: "Arp", rgb: PALETTE_LEAD }],
  ["synth", { key: "lead", name: "Synth", rgb: PALETTE_LEAD }],
  ["piano", { key: "lead", name: "Piano", rgb: PALETTE_LEAD }],
  // Pad/atmosphere.
  ["pad", { key: "pad", name: "Pad", rgb: PALETTE_PAD }],
  ["string", { key: "pad", name: "Strings", rgb: PALETTE_PAD }],
  ["atmos", { key: "pad", name: "Atmos", rgb: PALETTE_PAD }],
  // FX last — riser/sweep are often suffixes of named FX channels.
  ["fx", { key: "fx", name: "FX", rgb: PALETTE_FX }],
  ["riser", { key: "fx", name: "Riser", rgb: PALETTE_FX }],
  ["sweep", { key: "fx", name: "Sweep", rgb: PALETTE_FX }],
  ["impact", { key: "fx", name: "Impact", rgb: PALETTE_FX }],
];

/** Convenience map keyword → Group (read-only). */
export const GROUPS: Readonly<Record<string, Group>> = Object.fromEntries(GROUP_ENTRIES);

const KEYWORD_REGEXES: Array<[string, RegExp]> = GROUP_ENTRIES.map(([kw]) => [
  kw,
  new RegExp(`\\b${kw.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}\\b`, "i"),
]);

/**
 * Classify a channel by regex-matching keywords against its name + sample path.
 * Returns the first matching `Group` (insertion order wins) or `null` for
 * unknown content — caller can fall back to `classifyByPitchRange`.
 */
/**
 * Insert spaces at lowercase→uppercase transitions so camelCase compound
 * names like "HiHat" expose word boundaries to the keyword regex.
 * "HiHat" → "Hi Hat" (matches \bhat\b); "Hatchet" stays "Hatchet"
 * (no transition; \bhat\b correctly does NOT match).
 */
function splitCamelCase(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

export function classifyChannel(
  name: string | undefined,
  samplePath: string | undefined,
): Group | null {
  const raw = [name ?? "", samplePath ?? ""].join(" ");
  if (!raw.trim()) return null;
  const text = splitCamelCase(raw);
  for (let i = 0; i < KEYWORD_REGEXES.length; i++) {
    const entry = KEYWORD_REGEXES[i]!;
    if (entry[1].test(text)) return GROUP_ENTRIES[i]![1];
  }
  return null;
}

/**
 * Fallback for channels with no name match (e.g. a bare "Serum" plugin
 * channel): bucket by the average MIDI key of notes targeting this
 * channel. Returns null when the channel has no notes anywhere.
 */
export function classifyByPitchRange(notes: readonly Note[]): Group | null {
  if (notes.length === 0) return null;
  const avg = notes.reduce((acc, n) => acc + n.key, 0) / notes.length;
  if (avg < 48) return GROUPS["bass"]!;
  if (avg < 72) return GROUPS["lead"]!;
  return GROUPS["pad"]!;
}

// --------------------------------------------------------------------------- //
// Plan                                                                         //
// --------------------------------------------------------------------------- //

export type ChannelMutation = {
  iid: number;
  name: string;
  rgb: { r: number; g: number; b: number };
  /** Insert index 1..N this channel will route to. */
  target_insert: number;
};

export type InsertMutation = {
  index: number;
  name: string;
  rgb: { r: number; g: number; b: number };
};

export type PatternMutation = {
  iid: number;
  /** New name — undefined means "keep existing name". */
  name?: string;
  rgb: { r: number; g: number; b: number };
};

export type ReorganizePlan = {
  channels: ChannelMutation[];
  inserts: InsertMutation[];
  patterns: PatternMutation[];
};

export type ReorganizeOptions = {
  /**
   * If true, channels whose existing name is already semantic (passes
   * `isSemanticName`) keep their original name. Default: true.
   */
  preserveExistingNames?: boolean;
  /**
   * If true, pattern names that look like defaults ("Pattern", "Pattern 3")
   * get rewritten to their dominant-channel group name; existing custom
   * names are kept regardless. Default: true.
   */
  renameDefaultPatterns?: boolean;
};

const DEFAULT_NAME_RE = /^(Sample|Track|Insert|Channel|Pattern|Audio Track)\s*\d*$/i;

function isDefaultName(name: string | undefined): boolean {
  if (!name) return true;
  return DEFAULT_NAME_RE.test(name.trim());
}

/**
 * Compute the mutation plan from a parsed project. No project state mutated.
 *
 * Algorithm:
 *   1. Walk channels in iid order; classify each enabled one.
 *   2. Assign sequential inserts (1..N), de-dup names ("Kick" / "Kick 2" / ...).
 *   3. Per pattern, count notes-per-group and pick the winner; recolor +
 *      optionally rename if the existing name is a default.
 */
export function planReorganize(
  project: FLPProject,
  options: ReorganizeOptions = {},
): ReorganizePlan {
  const preserveExisting = options.preserveExistingNames ?? true;
  const renameDefaults = options.renameDefaultPatterns ?? true;

  const channels = project.channels;
  const patterns = project.patterns;

  const allNotes = patterns.flatMap((p) => p.notes);
  const notesByChannel = new Map<number, Note[]>();
  for (const note of allNotes) {
    const list = notesByChannel.get(note.channel_iid) ?? [];
    list.push(note);
    notesByChannel.set(note.channel_iid, list);
  }

  const channelMutations: ChannelMutation[] = [];
  const insertMutations: InsertMutation[] = [];
  const iidToGroup = new Map<number, Group>();
  const usedNames = new Map<string, number>();
  let nextInsert = 1;

  for (const ch of channels) {
    if (ch.enabled === false) continue;
    let group = classifyChannel(ch.name, ch.sample_path);
    if (group === null) {
      group =
        classifyByPitchRange(notesByChannel.get(ch.iid) ?? []) ?? GROUPS["synth"]!;
    }
    iidToGroup.set(ch.iid, group);

    let semanticName = group.name;
    if (preserveExisting && ch.name && !isDefaultName(ch.name)) {
      semanticName = ch.name;
    } else {
      const used = (usedNames.get(group.name) ?? 0) + 1;
      usedNames.set(group.name, used);
      semanticName = used === 1 ? group.name : `${group.name} ${used}`;
    }

    channelMutations.push({
      iid: ch.iid,
      name: semanticName,
      rgb: group.rgb,
      target_insert: nextInsert,
    });
    insertMutations.push({
      index: nextInsert,
      name: semanticName,
      rgb: group.rgb,
    });
    nextInsert += 1;
  }

  const patternMutations: PatternMutation[] = [];
  for (const pat of patterns) {
    const votes = new Map<GroupKey, number>();
    for (const note of pat.notes) {
      const g = iidToGroup.get(note.channel_iid);
      if (g) votes.set(g.key, (votes.get(g.key) ?? 0) + 1);
    }
    if (votes.size === 0) continue;
    let winnerKey: GroupKey = "lead";
    let max = -1;
    for (const [k, v] of votes) {
      if (v > max) {
        max = v;
        winnerKey = k;
      }
    }
    const winner = Object.values(GROUPS).find((g) => g.key === winnerKey)!;

    const newName =
      renameDefaults && isDefaultName(pat.name) ? winner.name : undefined;

    patternMutations.push({
      iid: pat.id,
      name: newName,
      rgb: winner.rgb,
    });
  }

  return {
    channels: channelMutations,
    inserts: insertMutations,
    patterns: patternMutations,
  };
}

// --------------------------------------------------------------------------- //
// Apply                                                                        //
// --------------------------------------------------------------------------- //

/** Apply a `ReorganizePlan` to an `FLPProject`. Returns a new project. */
export function applyReorganize(
  project: FLPProject,
  plan: ReorganizePlan,
): FLPProject {
  let p = project;
  for (const ch of plan.channels) {
    p = setChannelName(p, ch.iid, ch.name);
    p = setChannelColor(p, ch.iid, asRGBA(ch.rgb));
    p = setChannelRouting(p, ch.iid, ch.target_insert);
  }
  for (const ins of plan.inserts) {
    p = setInsertName(p, ins.index, ins.name);
    p = setInsertColor(p, ins.index, asRGBA(ins.rgb));
  }
  for (const pat of plan.patterns) {
    if (pat.name) p = setPatternName(p, pat.iid, pat.name);
    p = setPatternColor(p, pat.iid, asRGBA(pat.rgb));
  }
  return p;
}

function asRGBA(rgb: { r: number; g: number; b: number }): RGBA {
  return { r: rgb.r, g: rgb.g, b: rgb.b, a: 0 };
}

/**
 * One-shot: plan + apply atomically. Returns the mutated project plus
 * the plan (callers may want the plan for reporting/dry-run).
 */
export function reorganizeProject(
  project: FLPProject,
  options: ReorganizeOptions = {},
): { project: FLPProject; plan: ReorganizePlan; mutationsApplied: number } {
  const plan = planReorganize(project, options);
  const mutationsApplied =
    plan.channels.length * 3 +
    plan.inserts.length * 2 +
    plan.patterns.reduce((acc, p) => acc + (p.name ? 2 : 1), 0);
  const mutated = applyReorganize(project, plan);
  return { project: mutated, plan, mutationsApplied };
}

// Shut up unused-import lint in setups that strip the type re-export.
const _UnusedTypes: Channel | Pattern | undefined = undefined;
void _UnusedTypes;
