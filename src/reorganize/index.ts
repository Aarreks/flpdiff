/**
 * Code-level Ableton-style reorganize for FL Studio projects.
 *
 * v1: **playlist-tracks-only**. We classify each clip in the
 * arrangement, lay out the playlist tracks in family blocks
 * (`[Drums]` / `[Bass]` / `[Lead]` / ...), then move clips to their
 * target track + set track name + color. We **never touch channels,
 * mixer inserts, or patterns** — those carry intentional engineering
 * (channel→insert routing, parallel chains, sample-name-as-source-info,
 * pattern reuse semantics) that an automated tool would destroy.
 *
 * The previous v0 (channel renames / insert renames / routing changes /
 * pattern recolors) was a design flaw — see commit message of the
 * rewrite for the discussion.
 *
 * Algorithm:
 *
 *   1. For each clip in the arrangement:
 *        - kind="channel" → classify the referenced channel
 *        - kind="pattern" → classify the pattern by its dominant channel
 *      Result: each clip belongs to a *lane* (one lane per unique
 *      channel/pattern reference) with a content `Group`.
 *
 *   2. Sort lanes by family in fixed order
 *      (drums_hard → drums_soft → bass → lead → pad → fx → vocal →
 *      other), then by min(referenced_iid) within family.
 *
 *   3. Allocate a sequential block of playlist tracks per family,
 *      with an empty `[Family]` separator track between blocks
 *      (toggleable via `addFamilySeparators`).
 *
 *   4. Emit mutations: move every clip to its lane's target track
 *      (via `moveClip`), set name + color on each used track. NEVER
 *      touch channels / inserts / patterns.
 *
 * Invariants this guarantees:
 *   * Every channel/insert/pattern is byte-identical before/after.
 *   * Every clip is preserved (count + per-pattern note count).
 *   * Tracks 0..N have palette colors + semantic names; tracks above
 *     stay default.
 *   * Bit-exact round-trip via the canonical serializer.
 */

import type { FLPProject } from "../parser/flp-project.ts";
import type { Note } from "../model/pattern.ts";
import {
  moveClip,
  setTrackColor,
  setTrackGrouped,
  setTrackName,
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
  | "vocal"
  | "other";

export type Group = {
  /** Logical bucket. Drives palette choice + family ordering. */
  key: GroupKey;
  /** Default name for a freshly-classified content track in this group. */
  name: string;
  /** Color RGB (alpha defaults to 0 to match how the bridge round-trips user-set FL colors). */
  rgb: { r: number; g: number; b: number };
};

const PALETTE_DRUMS_HARD = { r: 233, g: 75, b: 60 };
const PALETTE_DRUMS_SOFT = { r: 255, g: 140, b: 66 };
const PALETTE_BASS = { r: 59, g: 130, b: 246 };
const PALETTE_LEAD = { r: 34, g: 197, b: 94 };
const PALETTE_PAD = { r: 139, g: 92, b: 246 };
const PALETTE_FX = { r: 236, g: 72, b: 153 };
const PALETTE_VOCAL = { r: 250, g: 204, b: 21 };
const PALETTE_OTHER = { r: 100, g: 116, b: 139 }; // slate gray

/**
 * Ordered (keyword, Group) pairs. Earlier entries take precedence on
 * ambiguous matches. Order matters: most-specific first.
 */
export const GROUP_ENTRIES: Array<[string, Group]> = [
  ["kick", { key: "drums_hard", name: "Kick", rgb: PALETTE_DRUMS_HARD }],
  ["snare", { key: "drums_hard", name: "Snare", rgb: PALETTE_DRUMS_HARD }],
  ["clap", { key: "drums_hard", name: "Clap", rgb: PALETTE_DRUMS_HARD }],
  ["rim", { key: "drums_hard", name: "Rim", rgb: PALETTE_DRUMS_HARD }],
  ["hat", { key: "drums_soft", name: "HiHat", rgb: PALETTE_DRUMS_SOFT }],
  ["perc", { key: "drums_soft", name: "Perc", rgb: PALETTE_DRUMS_SOFT }],
  ["tom", { key: "drums_soft", name: "Tom", rgb: PALETTE_DRUMS_SOFT }],
  ["shaker", { key: "drums_soft", name: "Shaker", rgb: PALETTE_DRUMS_SOFT }],
  ["cymbal", { key: "drums_soft", name: "Cymbal", rgb: PALETTE_DRUMS_SOFT }],
  ["crash", { key: "drums_soft", name: "Crash", rgb: PALETTE_DRUMS_SOFT }],
  ["ride", { key: "drums_soft", name: "Ride", rgb: PALETTE_DRUMS_SOFT }],
  ["drum", { key: "drums_hard", name: "Drum", rgb: PALETTE_DRUMS_HARD }],
  ["vox", { key: "vocal", name: "Vocal", rgb: PALETTE_VOCAL }],
  ["vocal", { key: "vocal", name: "Vocal", rgb: PALETTE_VOCAL }],
  ["bass", { key: "bass", name: "Bass", rgb: PALETTE_BASS }],
  ["sub", { key: "bass", name: "Sub Bass", rgb: PALETTE_BASS }],
  ["808", { key: "bass", name: "808", rgb: PALETTE_BASS }],
  ["lead", { key: "lead", name: "Lead", rgb: PALETTE_LEAD }],
  ["melody", { key: "lead", name: "Melody", rgb: PALETTE_LEAD }],
  ["arp", { key: "lead", name: "Arp", rgb: PALETTE_LEAD }],
  ["synth", { key: "lead", name: "Synth", rgb: PALETTE_LEAD }],
  ["piano", { key: "lead", name: "Piano", rgb: PALETTE_LEAD }],
  ["pad", { key: "pad", name: "Pad", rgb: PALETTE_PAD }],
  ["string", { key: "pad", name: "Strings", rgb: PALETTE_PAD }],
  ["atmos", { key: "pad", name: "Atmos", rgb: PALETTE_PAD }],
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

/** Family display order — matches Ableton's typical session view. */
export const FAMILY_ORDER: GroupKey[] = [
  "drums_hard",
  "drums_soft",
  "bass",
  "lead",
  "pad",
  "fx",
  "vocal",
  "other",
];

/** Family display name + representative palette color (used for separator tracks). */
export const FAMILY_LABELS: Record<GroupKey, { label: string; rgb: { r: number; g: number; b: number } }> = {
  drums_hard: { label: "Drums", rgb: PALETTE_DRUMS_HARD },
  drums_soft: { label: "Drums (Soft)", rgb: PALETTE_DRUMS_SOFT },
  bass: { label: "Bass", rgb: PALETTE_BASS },
  lead: { label: "Lead", rgb: PALETTE_LEAD },
  pad: { label: "Pad", rgb: PALETTE_PAD },
  fx: { label: "FX", rgb: PALETTE_FX },
  vocal: { label: "Vocal", rgb: PALETTE_VOCAL },
  other: { label: "Other", rgb: PALETTE_OTHER },
};

const OTHER_GROUP: Group = {
  key: "other",
  name: "Other",
  rgb: PALETTE_OTHER,
};

/**
 * Insert spaces at lowercase→uppercase transitions so camelCase compound
 * names like "HiHat" expose word boundaries to the keyword regex.
 */
function splitCamelCase(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/**
 * Classify a channel by regex-matching keywords against its name + sample path.
 */
export function classifyChannel(
  name: string | undefined,
  samplePath: string | undefined,
): Group | null {
  const raw = [name ?? "", samplePath ?? ""].join(" ");
  if (!raw.trim()) return null;
  const text = splitCamelCase(raw);
  for (let i = 0; i < KEYWORD_REGEXES.length; i++) {
    if (KEYWORD_REGEXES[i]![1].test(text)) return GROUP_ENTRIES[i]![1];
  }
  return null;
}

/**
 * Fallback: bucket by the average MIDI key of notes targeting this lane.
 *
 * Note: "pad" isn't really pitch-determined (pads are typically
 * sustained chords, not necessarily high notes), so we only use the
 * pitch bucket for bass-vs-melodic discrimination. Anything ≥ 48
 * defaults to "lead" — name-keyword matches still upgrade to "pad"
 * for explicitly-named pad/atmos/string content.
 */
export function classifyByPitchRange(notes: readonly Note[]): Group | null {
  if (notes.length === 0) return null;
  const avg = notes.reduce((acc, n) => acc + n.key, 0) / notes.length;
  if (avg < 48) return GROUPS["bass"]!;
  return GROUPS["lead"]!;
}

// --------------------------------------------------------------------------- //
// Plan                                                                         //
// --------------------------------------------------------------------------- //

const PATTERN_BASE = 20480;

type LaneKind = "channel" | "pattern";

/** A unique playlist lane — one per (kind, ref_id) referenced by clips. */
type Lane = {
  kind: LaneKind;
  refId: number;
  group: Group;
  /** Display name we'll set on the lane's playlist track. */
  displayName: string;
  /** Channel iid (or pattern's dominant channel iid) — used for in-family ordering. */
  sortKey: number;
  /** Indices into `arrangement.clips` that belong to this lane. */
  clipIndices: number[];
  /**
   * True for automation lanes. When set, the lane will be placed
   * immediately after its `automationTargetIid` lane (when known) and
   * rendered as a `grouped=true` child track in FL's playlist.
   */
  isAutomation?: boolean;
  /**
   * Channel iid of the automation's target instrument, when the auto
   * directly controls a channel parameter (kind="channel" in
   * `Channel.automationTarget`). Mixer-slot automations leave this
   * undefined and stay in their own family block as standalone rows.
   */
  automationTargetIid?: number;
};

export type TrackMutation = {
  trackIndex: number;
  name?: string;
  rgb?: { r: number; g: number; b: number };
  grouped?: boolean;
  /** True for empty `[Family]` separator rows (no clip moves into them). */
  isFamilySeparator?: boolean;
};

export type ClipMoveMutation = {
  /** Position of the clip in `arrangement.clips` before mutation. */
  fromTrackIndex: number;
  fromPositionTicks: number;
  refId: number;
  refKind: LaneKind;
  toTrackIndex: number;
};

export type ReorganizePlan = {
  arrangementId: number;
  tracks: TrackMutation[];
  clipMoves: ClipMoveMutation[];
};

export type ReorganizeOptions = {
  /** Which arrangement to reorganize. Default 0. */
  arrangementId?: number;
  /** Insert empty `[Family]` separator tracks between family blocks. Default true. */
  addFamilySeparators?: boolean;
};

function notesByChannelIid(project: FLPProject): Map<number, Note[]> {
  const out = new Map<number, Note[]>();
  for (const pat of project.patterns) {
    for (const n of pat.notes) {
      const list = out.get(n.channel_iid) ?? [];
      list.push(n);
      out.set(n.channel_iid, list);
    }
  }
  return out;
}

function dominantChannelIid(noteList: readonly Note[]): number | undefined {
  if (noteList.length === 0) return undefined;
  const counts = new Map<number, number>();
  for (const n of noteList) counts.set(n.channel_iid, (counts.get(n.channel_iid) ?? 0) + 1);
  let bestIid = -1;
  let bestCount = -1;
  for (const [iid, c] of counts) {
    if (c > bestCount) {
      bestCount = c;
      bestIid = iid;
    }
  }
  return bestIid >= 0 ? bestIid : undefined;
}

/**
 * Walk the arrangement's clips, classify each into a `Lane`, return the
 * keyed map ready for sorting + layout.
 */
function collectLanes(project: FLPProject, arrangementId: number): Map<string, Lane> {
  const arr = project.arrangements.find((a) => a.id === arrangementId);
  if (!arr) return new Map();
  const channelsByIid = new Map(project.channels.map((c) => [c.iid, c]));
  const patternsById = new Map(project.patterns.map((p) => [p.id, p]));
  const allNotesByCh = notesByChannelIid(project);

  const lanes = new Map<string, Lane>();
  for (let i = 0; i < arr.clips.length; i++) {
    const clip = arr.clips[i]!;
    const isPattern = clip.item_index > PATTERN_BASE;
    const kind: LaneKind = isPattern ? "pattern" : "channel";
    const refId = isPattern ? clip.item_index - PATTERN_BASE : clip.item_index;
    const key = `${kind}:${refId}`;
    let lane = lanes.get(key);
    if (!lane) {
      let group: Group | null = null;
      let displayName = "";
      let sortKey = refId;

      let isAutomation = false;
      let automationTargetIid: number | undefined;
      if (kind === "channel") {
        const ch = channelsByIid.get(refId);
        const chNotes = allNotesByCh.get(refId) ?? [];
        group = classifyChannel(ch?.name, ch?.sample_path) ?? classifyByPitchRange(chNotes);
        displayName = ch?.name?.trim() || `Channel ${refId}`;
        sortKey = refId;
        // Automation channel that targets another channel directly
        // → inherit target's family + remember the target so layout
        // can nest us under that target's track.
        if (
          ch?.kind === "automation" &&
          ch.automationTarget?.kind === "channel" &&
          ch.automationTarget.targetChannelIid !== undefined
        ) {
          isAutomation = true;
          automationTargetIid = ch.automationTarget.targetChannelIid;
          const target = channelsByIid.get(automationTargetIid);
          if (target) {
            const targetNotes = allNotesByCh.get(target.iid) ?? [];
            const targetGroup =
              classifyChannel(target.name, target.sample_path) ??
              classifyByPitchRange(targetNotes);
            if (targetGroup) group = targetGroup;
          }
        } else if (ch?.kind === "automation") {
          // Mixer-slot or unknown automation: keep its own
          // name-based classification but mark as auto so layout
          // doesn't nest it (no target available).
          isAutomation = true;
        }
      } else {
        const pat = patternsById.get(refId);
        const dominantIid = dominantChannelIid(pat?.notes ?? []);
        const dominantCh =
          dominantIid !== undefined ? channelsByIid.get(dominantIid) : undefined;
        group =
          classifyChannel(dominantCh?.name, dominantCh?.sample_path) ??
          classifyByPitchRange(pat?.notes ?? []);
        displayName = pat?.name?.trim() || dominantCh?.name?.trim() || `Pattern ${refId}`;
        sortKey = dominantIid ?? refId + 100_000; // unknown patterns sort last in family
      }
      if (!group) group = OTHER_GROUP;
      lane = {
        kind,
        refId,
        group,
        displayName,
        sortKey,
        clipIndices: [],
        isAutomation,
        automationTargetIid,
      };
      lanes.set(key, lane);
    }
    lane.clipIndices.push(i);
  }
  return lanes;
}

/**
 * Compute the mutation plan for a single arrangement. No project state mutated.
 */
export function planReorganize(
  project: FLPProject,
  options: ReorganizeOptions = {},
): ReorganizePlan {
  const arrangementId = options.arrangementId ?? 0;
  const addSeparators = options.addFamilySeparators ?? true;

  const arr = project.arrangements.find((a) => a.id === arrangementId);
  const lanes = collectLanes(project, arrangementId);

  // Bucket lanes by family.
  const byFamily = new Map<GroupKey, Lane[]>();
  for (const lane of lanes.values()) {
    const list = byFamily.get(lane.group.key) ?? [];
    list.push(lane);
    byFamily.set(lane.group.key, list);
  }

  // Within each family, order:
  //   1. Non-auto lanes sorted by sortKey
  //   2. After each non-auto lane: any auto lanes whose
  //      automationTargetIid points to this lane's refId,
  //      sorted by their own sortKey
  //   3. Standalone autos (mixer-slot / unknown / orphaned) tacked on
  //      at family end, sorted by sortKey
  const orderedByFamily = new Map<GroupKey, Lane[]>();
  for (const [family, list] of byFamily) {
    const nonAuto = list.filter((l) => !l.isAutomation).sort((a, b) => a.sortKey - b.sortKey);
    const autosByTarget = new Map<number, Lane[]>();
    const autoOrphans: Lane[] = [];
    for (const l of list) {
      if (!l.isAutomation) continue;
      if (l.automationTargetIid !== undefined) {
        const arr = autosByTarget.get(l.automationTargetIid) ?? [];
        arr.push(l);
        autosByTarget.set(l.automationTargetIid, arr);
      } else {
        autoOrphans.push(l);
      }
    }
    for (const arr of autosByTarget.values()) arr.sort((a, b) => a.sortKey - b.sortKey);
    autoOrphans.sort((a, b) => a.sortKey - b.sortKey);

    const ordered: Lane[] = [];
    for (const parent of nonAuto) {
      if (parent.kind !== "channel") {
        ordered.push(parent);
        continue;
      }
      ordered.push(parent);
      const children = autosByTarget.get(parent.refId);
      if (children) {
        ordered.push(...children);
        autosByTarget.delete(parent.refId);
      }
    }
    // Autos whose target lives in a different family (rare but
    // possible — auto for a "lead" channel ending up in a "bass"
    // bucket because the auto's name regex misclassified) get
    // appended as orphans here.
    for (const arr of autosByTarget.values()) ordered.push(...arr);
    ordered.push(...autoOrphans);
    orderedByFamily.set(family, ordered);
  }

  // Build the track-layout sequence.
  const trackMutations: TrackMutation[] = [];
  const laneToTrackIndex = new Map<string, number>();
  let cursor = 0;
  for (const family of FAMILY_ORDER) {
    const familyLanes = orderedByFamily.get(family);
    if (!familyLanes || familyLanes.length === 0) continue;
    if (addSeparators) {
      const fam = FAMILY_LABELS[family];
      trackMutations.push({
        trackIndex: cursor,
        name: `[${fam.label}]`,
        rgb: fam.rgb,
        grouped: false,
        isFamilySeparator: true,
      });
      cursor += 1;
    }
    for (const lane of familyLanes) {
      // Always rename target tracks: the lane is reassigned to this
      // track index, so any pre-existing user name no longer reflects
      // the content we're moving in. (Tracks BEYOND `cursor` stay
      // untouched since the loop never reaches them.)
      // grouped=true ONLY for automation lanes that have a known
      // target in this same family — those nest visually under the
      // ungrouped target track above. All other rows stay parents.
      const grouped = !!(lane.isAutomation && lane.automationTargetIid !== undefined);
      trackMutations.push({
        trackIndex: cursor,
        name: lane.displayName,
        rgb: lane.group.rgb,
        grouped,
      });
      laneToTrackIndex.set(`${lane.kind}:${lane.refId}`, cursor);
      cursor += 1;
    }
  }

  // Generate clip moves: every clip → the track its lane was assigned.
  // moveClip is BULK — a single call patches every record matching
  // {track_index, ref_id, kind}. Emitting per-clip mutations would
  // cause the 2nd+ call on the same (fromTrack, refId, kind) tuple to
  // throw EVENT_NOT_FOUND because the match is already gone. Dedupe
  // here so each unique (fromTrack, refId, kind) becomes ONE move.
  const clipMoves: ClipMoveMutation[] = [];
  if (arr) {
    const TRACK_MAX = 499; // mirrors mutations/index.ts
    const seen = new Set<string>();
    for (const lane of lanes.values()) {
      const target = laneToTrackIndex.get(`${lane.kind}:${lane.refId}`);
      if (target === undefined) continue;
      for (const idx of lane.clipIndices) {
        const clip = arr.clips[idx]!;
        const fromTrack = TRACK_MAX - clip.track_rvidx;
        if (fromTrack === target) continue; // already in place
        const moveKey = `${fromTrack}|${lane.kind}|${lane.refId}`;
        if (seen.has(moveKey)) continue;
        seen.add(moveKey);
        clipMoves.push({
          fromTrackIndex: fromTrack,
          // fromPositionTicks is informational — moveClip's match
          // omits position so it sweeps every clip on this track for
          // this lane in one call.
          fromPositionTicks: clip.position,
          refId: lane.refId,
          refKind: lane.kind,
          toTrackIndex: target,
        });
      }
    }
  }

  return { arrangementId, tracks: trackMutations, clipMoves };
}

// --------------------------------------------------------------------------- //
// Apply                                                                        //
// --------------------------------------------------------------------------- //

/** Apply a `ReorganizePlan` to an `FLPProject`. Returns a new project. */
export function applyReorganize(project: FLPProject, plan: ReorganizePlan): FLPProject {
  let p = project;
  // Move clips first — moveClip matches on current position+track, which
  // would shift if we touched track names/colors first (it doesn't, but
  // ordering is cleaner this way semantically).
  for (const mv of plan.clipMoves) {
    // Match by (track, ref_id, kind) only — moveClip is bulk and our
    // plan already deduplicated to one move per (fromTrack, ref, kind).
    p = moveClip(
      p,
      plan.arrangementId,
      {
        track_index: mv.fromTrackIndex,
        ref_id: mv.refId,
        kind: mv.refKind,
      },
      { track_index: mv.toTrackIndex },
    );
  }
  for (const t of plan.tracks) {
    if (t.name !== undefined) p = setTrackName(p, plan.arrangementId, t.trackIndex, t.name);
    if (t.rgb !== undefined) {
      p = setTrackColor(p, plan.arrangementId, t.trackIndex, {
        r: t.rgb.r,
        g: t.rgb.g,
        b: t.rgb.b,
        a: 0,
      });
    }
    if (t.grouped !== undefined) {
      p = setTrackGrouped(p, plan.arrangementId, t.trackIndex, t.grouped);
    }
  }
  return p;
}

/**
 * One-shot: plan + apply atomically. Returns the mutated project plus
 * the plan and a count of mutations actually applied.
 */
export function reorganizeProject(
  project: FLPProject,
  options: ReorganizeOptions = {},
): { project: FLPProject; plan: ReorganizePlan; mutationsApplied: number } {
  const plan = planReorganize(project, options);
  const trackMuts = plan.tracks.reduce(
    (acc, t) =>
      acc + (t.name !== undefined ? 1 : 0) + (t.rgb !== undefined ? 1 : 0) + (t.grouped !== undefined ? 1 : 0),
    0,
  );
  const mutationsApplied = trackMuts + plan.clipMoves.length;
  const mutated = applyReorganize(project, plan);
  return { project: mutated, plan, mutationsApplied };
}
