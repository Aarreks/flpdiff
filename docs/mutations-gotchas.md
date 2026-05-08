# Mutations + encoder gotchas

Lessons learned the hard way while building `src/mutations/` and
`src/reorganize/`. If you're writing a new mutation helper, a new
bridge kind, or batching existing helpers, read this first.

## 1. `moveClip` / `removeClip` are bulk-match per call

A single invocation of `moveClip(arrId, match, to)` patches **every
record** matching `{track_index, ref_id, kind}` (and optionally
`position_ticks`). It is not a one-shot per record.

If you write a "move a list of clips" loop that emits one `moveClip`
call per clip, the FIRST call will move all matching records and the
2nd+ calls will throw `EVENT_NOT_FOUND: no clips matched in
arrangement N` because the match is already gone.

**Fix:** dedupe by `(fromTrack, refId, refKind)` before generating
mutations. One unique tuple → one move.

```ts
const seen = new Set<string>();
for (const clip of clipsInLane) {
  const key = `${fromTrack}|${refKind}|${refId}`;
  if (seen.has(key)) continue;
  seen.add(key);
  // emit one moveClip for this tuple
}
```

This is what `src/reorganize/index.ts::planReorganize` does. Same trap
applies to any future tool that batches `removeClip`.

(Decision D-37 in MCP-SPEC.md.)

## 2. `target_insert` is a signed int8

The on-disk opcode `0x16` (channel routing) stores the target insert
as a single signed byte. Range:

- `-1` → auto / unrouted
- `0` → Master
- `1..127` → inserts 1 through 127

You cannot represent insert 128. Real producer projects with 130+
enabled channels do exist (orchestral templates, big EDM productions).
They handle the limit by routing multiple channels into shared bus
inserts (drum bus, vocal bus) — that's a mixing decision the user
made, not something a tool can sequentially overwrite.

If a future tool needs to assign N>127 routings, it must group by
content family and route to shared inserts (or refuse with a clear
error). The `reorganize_project` v2 sidesteps the limit entirely by
no longer touching routing at all.

(Decision D-38.)

## 3. JS Object iteration order has a numeric-key trap

```ts
Object.keys({ "808": ..., kick: ... })  // → ["808", "kick"]
```

Numeric-string keys are sorted ahead of letter keys regardless of
insertion order. If a keyword priority table is implemented as a plain
object, `"808 Kick"` will classify as `bass` (the `808` keyword) instead
of `drums_hard` (the `kick` keyword) even though `kick` was inserted
first.

**Fix:** any priority lookup that depends on insertion order must use
an array of `[key, value]` tuples:

```ts
const GROUP_ENTRIES: Array<[string, Group]> = [
  ["kick", { ... }],
  ["snare", { ... }],
  ["808", { ... }],   // safely after letter keys
];
```

(Decision D-40.)

## 4. CamelCase tokenization for keyword regex

`\bhat\b` does NOT match `"HiHat"`. `\b` is the boundary between word
and non-word characters; `i` and `H` are both word characters, so
there's no boundary inside `HiHat`.

FL channel/sample names regularly use camelCase (`HiHat`, `OpenHat`,
`KickTop`). Pre-process input to expose the boundaries:

```ts
text.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
// "HiHat"   → "Hi Hat"
// "Hatchet" → "Hatchet" (no transition; correctly stays unmatched)
```

Applied at `src/reorganize/index.ts::splitCamelCase`.

(Decision D-41.)

## 5. `dry_run` must NOT call apply

When implementing a "macro" mutation that bundles multiple sub-mutations
(like `reorganize_project`), it's tempting to write:

```ts
const result = reorganizeProject(project, opts);
if (dry_run) return { plan: result.plan };  // BUG: already applied
```

`reorganizeProject` calls `applyReorganize` internally, which can
throw `EVENT_NOT_FOUND` or other errors on edge-case inputs that you
DON'T want to surface in a preview. The user gets a bridge error for
something they were just inspecting.

**Fix:** in `dry_run` branches, call only the planning function:

```ts
if (dry_run) {
  const plan = planReorganize(project, opts);
  return { plan, mutations_applied: 0 };
}
const result = reorganizeProject(project, opts);
```

Pattern applies to any bundled-mutation kind in `src/bridge.ts`.

(Decision D-43.)

## 6. Channel `targetInsert` (camelCase) vs `target_insert` (snake)

The `Channel` type exposes `targetInsert` (camelCase) — that's the
post-parser TS field.

The bridge JSON output (`describe`, `list_channels`) uses
`target_insert` (snake_case) for Python parity.

The mutation helpers / bridge kind args also use `target_insert`
(snake) at the user-facing boundary, then route to the camelCase TS
field internally.

When writing an invariant validator on the **TS side**, read
`channel.targetInsert`. When writing one on the **Python side** (e.g.
the e2e harness), read `channel["target_insert"]` from the describe
payload.

## 7. `describe.mixer.inserts[]` — not top-level `describe.inserts`

The bridge `describe` payload nests inserts under `mixer`:

```json
{
  "channels": [...],
  "patterns": [...],
  "mixer": {
    "inserts": [
      { "index": 0, "name": null, "color": null, "slots": [...], ... },
      { "index": 1, ... }
    ]
  },
  "arrangements": [...]
}
```

`describe.inserts` is `null`. If a Python invariant naively reads
`describe.get("inserts") or describe.get("mixer")` it'll fall back to
the `mixer` object (a dict, not a list) and `len(dict)` silently
returns the dict's key count (~8) as the "insert count". Always
traverse via `describe["mixer"]["inserts"]`.

(Decision D-42.)

## 8. PyFLP `c.Struct` field comments are CUMULATIVE END offsets, not starts

A high-impact off-by-one we hit during reorganize v3. PyFLP source
defines the playlist `TrackEvent` like this:

```python
STRUCT = c.Struct(
    "iid" / c.Optional(c.Int32ul),                    # 4
    "color" / c.Optional(c.Int32ul),                  # 8
    "icon" / c.Optional(c.Int32ul),                   # 12
    ...
    "position_sync" / c.Optional(StdEnum[...](c.Int32ul)),  # 46
    "grouped" / c.Optional(c.Flag),                   # 47   ← byte 46!
    "locked" / c.Optional(c.Flag),                    # 48   ← byte 47!
)
```

Each `# N` comment is the **end** offset of that field — i.e. the
total bytes consumed up through and including that field. So the
field actually starts at the previous field's end-offset.

We read those comments as start offsets and shipped a parser/encoder
that toggled `locked` whenever asked to toggle `grouped`. FL UI on the
output showed "Lock to content" enabled instead of "Group with above
track" — caught in live-FL verify on 2026-05-07.

**Rule:** when porting a PyFLP `c.Struct` definition, ALWAYS:

1. Compute cumulative byte offsets explicitly (sum the `c.IntNN` /
   `c.Bytes(K)` sizes top-down) before referencing any byte by index
2. Cross-check the resulting layout against a real fixture's bytes
3. If a struct uses `c.Optional`, remember those fields can still
   occupy bytes when present — `c.Optional` doesn't make them shorter

(Decision D-45.)

## 9. Live-FL acceptance verify is fragile on cross-machine FLPs

Real producer FLPs almost always reference plugins or samples not
installed on the verifier machine. Two failure modes that block FL
even before our automation can run a menu click:

1. **Missing-plugins / missing-samples modal** — FL's standard
   "Problems loading the project" dialog. Dismissable with
   `keystroke return` once or twice.
2. **PACE License Support fatal-error dialog** — third-party plugins
   (e.g. Soundtoys DevilLoc Deluxe in `pp6_refl.flp`) trigger a
   licensing-failure popup that comes from PACE, not FL. FL then
   freezes — `osascript` querying FL's menu bar starts returning
   `Can't get menu bar 1 of process "OsxFL". Invalid index.` because
   FL's accessibility tree has collapsed. Pressing OK on the dialog
   doesn't always unfreeze FL.

**Implication:** for stress / scale testing, prefer byte-level
verification — re-parse the post-reorganize FLP via
`parseFLPFile` and assert on `Channel`/`Track`/`Clip` state. Live-FL
is the bonus visual check; reserve it for small clean fixtures
without external plugin dependencies. The
`mcp/scripts/reorganize_stress.py` harness uses byte-level + the
existing harness invariants, which is what passes 85/85 on the
local corpus. The `mcp/scripts/fl_verify_reorganize.py` is for
visual confirmation on a single fixture you've curated for
reachable plugins/samples.

(Decision D-49.)

## 10. Prefer rule-based logic over LLM for invariant-checkable tasks

If a task's success criteria can be expressed as a programmatic
invariant set (palette colors, naming conventions, routing
distinctness, structural preservation), the task is rule-based — write
deterministic code, don't reach for an LLM.

We built an LLM-driven harness for the reorganize-project flow first
(judge 4–5/5, $0.40/run, 56 s on real producer FLPs). Then a TS
implementation: 100% on the same invariants, 355 ms/run, $0. Reserve
LLM-shaped tasks for genuinely creative work (compose a melody,
suggest a chord progression) — **not** classification + lookup.

(Decision D-35.)

## 11. Pattern-scoped opcodes need a scope-walker, not a global rewrite

Pattern notes (`0xE0`) and pattern controllers (`0xDF`) live inside
the slice `[0x41 patternId, ..., next 0x41 or 0x63]` — they are NOT
top-level. A naïve "drop every `0xE0` in the events array" is wrong:
it nukes notes from sibling patterns too.

Use `findPatternScope(events, patternId)` to bound the rewrite:

```ts
const scope = findPatternScope(events, patternId);  // {startIdx, endIdx}
const newEvents = events.filter((ev, i) => {
  if (i > scope.startIdx && i < scope.endIdx && ev.opcode === OP_PATTERN_NOTES) {
    return false; // drop only inside target scope
  }
  return true;
});
```

The scope spans from the matching `0x41` marker through the byte
before the next `0x41` (next pattern) or `0x63` (start of arrangement
section). `setPatternNotes` and `setPatternControllers` both follow
this pattern.

Re-find the scope after any drop pass — the indices shift when events
are removed. (See `setPatternNotes` and `setPatternControllers` in
`src/mutations/index.ts` for the canonical shape.)

Insertion position matters too: place the new (single, coalesced)
event right after the pattern's `0xC1` name event, or after the
`0x41` marker if there's no name. FL emits its own events in this
order on freshly-saved files.

(Decisions D-50/F2.1, D-50/F2.2.)

## 12. Multiple `0xE0` / `0xDF` events per pattern are concatenated, not the latest-wins

FL emits a single `0xE0` per pattern on save, but the parser
accepts and concatenates multiple — `[0xE0 a, 0xE0 b]` reads as
`a + b` notes. The encoder helpers exploit this: when adding one
note via `addPatternNote`, we COULD just append a tiny new `0xE0`
event with one record (24 bytes) and FL would still see all the
notes. We chose to coalesce instead — drop existing + emit one
combined blob — because:

1. Re-saved files match FL's typical save shape (one event per opcode)
2. Future tooling that diffs `0xE0` payloads byte-by-byte sees a
   minimal diff vs scattered new events

Either approach round-trips. The coalesce strategy makes byte-diff
tooling honest about what changed.
