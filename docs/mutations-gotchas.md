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

## 8. Prefer rule-based logic over LLM for invariant-checkable tasks

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
