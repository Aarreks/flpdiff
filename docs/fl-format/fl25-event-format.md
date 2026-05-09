# FL Studio 25 — Event Format Findings

How FL Studio 25's FLP event stream differs from earlier-version
saves. Tested against **FL Studio 25.2.4 Producer Edition
[build 4960]** on macOS.

## TL;DR

FL 25 introduced new event opcodes that **do not follow the standard
opcode-range sizing rules** (BYTE 0–63 → 1B payload, WORD 64–127 →
2B, DWORD 128–191 → 4B, TEXT/DATA 192–255 → varint-prefixed). At
least one opcode in the DWORD range (`0xAC`) carries a 3-byte
payload, not 4. Without correct event partitioning, downstream
parsing fails — the 0xAC misparse swallows the next event's opcode
byte, corrupting the rest of the stream.

This doc catalogs the FL 25 deviations and how the TS parser handles
them via its override table.

## The empirical finding — tempo

Tempo is at **file byte offset 155, as `bpm × 1000` uint32 LE** on a
minimal-project shape (empty title, empty comments, one channel).

```
Verified by running the Python-side RE harness at multiple BPM values:

  tempo=100  bytes[155:159] = a0 86 01 00   u32 LE = 100000   (100 × 1000) ✓
  tempo=120  bytes[155:159] = c0 d4 01 00   u32 LE = 120000   (120 × 1000) ✓
  tempo=130  bytes[155:159] = d0 fb 01 00   u32 LE = 130000   (130 × 1000) ✓
  tempo=145  bytes[155:159] = 68 36 02 00   u32 LE = 145000   (145 × 1000) ✓
  tempo=160  bytes[155:159] = 00 71 02 00   u32 LE = 160000   (160 × 1000) ✓
```

**Important caveat**: byte 155 is only the *correct* offset for this
specific minimal-project shape. Larger projects with content before
the tempo field will push the offset around. Tempo's position is
**inside some event's payload**, not a file-header field. Finding
that enclosing event requires correctly parsing the event stream.
Once `0xAC`'s 3-byte sizing is handled correctly the unified `0x9C`
tempo event surfaces as a normal DWORD event and `tempo / 1000`
gives the right BPM.

## The real problem — event range rules are wrong on FL 25

Standard event categorisation:

```
0-63     BYTE    → 1-byte payload
64-127   WORD    → 2-byte payload
128-191  DWORD   → 4-byte payload
192-255  TEXT/DATA → VarInt size prefix + payload
```

This works for FL 12-24. For FL 25, `0xAC` violates the range
convention. Catalogue so far (from inspecting `base_empty.flp`):

### `0xAC` — 3-byte payload (DWORD-range violation)

**Range rule says**: DWORD, 4-byte payload.
**Actually**: 3-byte payload, no size prefix.

Evidence (event stream from `base_empty.flp`, FL 25.2.4 build 4960):

```
byte 48: ac           (opcode)
bytes 49-51: 01 01 00 (3-byte payload, semantic content TBD)
byte 52: c0           (next opcode — TEXT range, version banner)
byte 53: 36           (varint length = 54)
bytes 54-107: UTF-16-LE "FL Studio 25.2.4.4960.4960\0"
              — 54 bytes = 27 UTF-16 code units
```

Naïve 4-byte parsing of `0xAC` consumes byte 52 (`0xC0`) as part of
the payload, then reads byte 53 (`0x36`) as the next opcode. `0x36`
in the BYTE range nominally takes a 1-byte payload — which would
fragment the version banner into ~27 fake BYTE events. The TS
parser previously hid this by overriding `0x36` as a
`utf16_zterm` opcode (read until `00 00`); both interpretations
consume the same byte range but the event identity was wrong. See
issue #1 for the discovery.

The TS parser now treats `0xAC` as a 3-byte blob (override table
in `src/parser/event.ts`). The version banner falls out as a normal
`0xC0` TEXT event with varint-prefixed UTF-16-LE payload — no
override needed.

### `0xC0` — historical note

`0xC0` (TEXT range, VarInt size + payload) was reused for per-channel
UTF-16 names through FL 24. In FL 25 minimal saves the first `0xC0`
event is the project's UTF-16 version banner; PyFLP additionally
documents larger `0xC0` payloads on FL 25 saves as an opaque
project-properties blob. `getFLVersionBanner` disambiguates by
requiring the decoded UTF-16 string to start with "FL Studio".

## Why this matters for flpdiff

Without correct event partitioning, we can't:

- Map tempo, time signature, pan law, title, etc. to their real
  opcodes.
- Tell users "tempo changed from 120 to 145 BPM" in diff output.
- Match channels, patterns, inserts by stable identity — every
  downstream piece of the canonical model assumes events have been
  correctly walked.

With correct partitioning, all of the above becomes mostly a
mapping exercise once we know which opcodes carry which fields.

## How to discover more FL 25 opcodes

A Python-side RE harness drives FL Studio via the MIDI scripting API
to produce sweep fixtures (lives in the dev-side `python/tools/re_harness/`,
not part of this TS package). Method:

1. Start from a known-state base FLP (e.g., `base_empty.flp`).
2. Run a "sweep": modify one field to multiple known values
   (tempo 100, 130, 160; or time sig 3/4, 4/4, 5/4; or title
   "a", "ab", "abc").
3. Byte-diff the resulting files. Bytes that change monotonically
   with the field are its encoding. The *enclosing event* is
   whatever event starts at a nearby offset and whose size is
   consistent across all sweep values.
4. When a candidate event's opcode + nominal size rule would
   underrun or overrun a reasonable payload (e.g., `0xAC` in DWORD
   range whose "4th byte" is always the next event's opcode),
   you've found a range-rule violation.

Keep a catalog: `opcode → actual size rule → semantic field`.
Add new entries to the override table in `src/parser/event.ts`.

## Methodology reminder — reproducibility

The tempo-sweep artifacts that backed this doc were generated via
the Python-side RE harness driving FL Studio's MIDI scripting API
(set tempo → save → snapshot, repeat at known values). They aren't
committed — regenerate locally as needed.

## VST plugin-state payload — FL serialization marker

When `0xD5` (plugin state) carries a VST (not a native FL plugin)
the payload begins with a 4-byte little-endian `type` field. Its
first byte is an FL-serialization marker that tracks the **FL Studio
version that wrote the file**, not the plugin vendor. The identical
Ozone 10 (iZotope, VST3) instance appears as marker 10 in an FL
21.1 save and marker 11 in an FL 24.1 save. Best hypothesis: FL
bumps the byte whenever it changes the surrounding event's
serialization format between releases.

Mapping observed so far:

| FL version | Marker | Source |
|---|---|---|
| 9     | 6  | `4frontpiano.flp`, `TheCastle_19.flp`, `ambience.flp` |
| 12–20 | 8, 10 | older corpus |
| 20.5  | 9  | `phlegma_dogs_9.flp` (Sylenth1) |
| 21.1  | 10 | `salut-vera_4.flp` (Ozone 10 etc.) |
| 24.1  | 11 | `dorn-girls.flp` (Ozone 10, soothe2) |
| 25.2  | 12 | `base_one_serum.flp` (Serum) |

The byte is stored as `type` and never used to branch — payloads
parse identically regardless. New FL releases simply add new
markers to the allowlist.

## `0xE1` MixerParams sparse packing on FL 25

Opcode `0xE1` (MixerParams blob) still appears in FL 25 saves and
still packs per-channel / per-slot mixer parameters in its payload
— but the `channel_data` bit-packing produces a much sparser index
than FL 24 did. On a minimal FL 25 save (`base_empty.flp`), the
populated insert indices are `{0, 53, 64, 65, ..., 80}` — master,
one scratch index, then 17 default inserts — whereas the mixer
walks 127 insert positions overall.

The TS parser handles this by silently dropping records whose
`insertIdx` falls outside the visible-insert range (they target
slots FL allocated but didn't surface via `0x93`). See
`buildMixerInserts` in `src/parser/project-builder.ts`.

## `0xD5` plugin state — Fruity Parametric EQ 2 RE

Opcode `0xD5` is the per-slot plugin-state blob, one event per
plugin instance. Content is plugin-specific.

Reverse-engineered Fruity Parametric EQ 2 (FL's native 7-band
parametric EQ) via the `plugins.setParamValue` harness handler + a
per-parameter save/diff sweep. Blob is 354 bytes on FL 25.2.4;
layout is uniform 4-byte slots with a 4-byte header and 144 bytes
of trailing un-decoded state. 36 parameters across 7 bands + main
level. Scale factor: normalized param value `v` stores as
`round(v * 0xFFFF)` for uint16 fields.

Serum's VST state blob occupies `0xD5` too, but its payload size
drifts across same-value saves (session-internal state) — so the
fixed-offset RE approach that worked for EQ 2 doesn't translate.
Full VST chunk decoding or differential-noise RE is needed;
deferred.

## `0xE3` RemoteController — automation→target link

Opcode `0xE3` = DATA + 19 in PyFLP's enum scheme. PyFLP's
`RemoteControllerEvent` knows about this event but its `STRUCT` does
NOT decode the destination/parameter binding (only `parameter_data`
gets exposed via `RemoteController.parameter`, and even that is
TODO-tagged in `Channel.controllers`). flpdiff RE'd the rest by
diffing automation-tagged fixtures against their "nolink" siblings
(`tests/corpus/local/test_track_color=red;icon=empty;automations=link*.flp`)
plus surveying every `0xE3` blob across the local corpus.

20-byte payload layout (FL 25):

```
offset  size  field                meaning
0-1     u16   _u1                  ~always 0; possibly version flag (saw 1, 2 in legacy)
2-3     u16   source_iid           the AUTOMATION channel emitting this control
4-5     u16   _u2                  ~always 0
6-7     u16   _u3                  often 0; sometimes mirrors source_iid
8-9     u16   parameter_data       high bit (0x8000) = controls a VST plugin param;
                                   low 15 bits = parameter id within the target
10-11   u16   destination          target channel iid (or encoded mixer-slot ref —
                                   see "When destination is a mixer slot" below)
12-15   u32   _u4                  ~always 8 (constant magic)
16-19   u32   _u5                  ~always 469 = 0x1D5 (format marker)
```

The two payload uints we care about for nesting automation lanes are
`source_iid` (offset 2) and `destination` (offset 10).

### When destination is a channel

If `destination` is a small u16 that matches an existing
`Channel.iid` in the project, the automation controls a parameter
on that channel directly. Example from `automations=link.flp`:
auto channel iid=3 named `"3x Osc - Osc 1 coarse pitch"` →
`source_iid=3`, `destination=0`, project has `Channel{iid: 0,
name: "3x Osc"}`. Round-trips: yes; both bytes literally name the
linked channel.

### When destination is a mixer slot

Real producer FLPs (`pp4_j1_129`, `h3_ys_64`, `edz_chords_28`)
have automation channels controlling **mixer-slot plugin
parameters** — e.g. `"Param. EQ 2 (Slot 7) - Serum - Band 1 freq"`.
For those, the destination uint16 packs the (insert, slot) pair:

```
bit  13 (0x2000) → mixer-slot marker (1 = this kind, 0 = channel iid)
bits  6..12      → mixer insert index (0..127)
bits  0..5       → slot index (0..63)
```

Decode: `insert = (dest >> 6) & 0x7F`, `slot = dest & 0x3F`.
Encode: `dest = 0x2000 | (insert << 6) | slot`.

Verified across 57/57 mixer-slot `0xE3` samples in the local
producer corpus (2026-05-09, D-57). Cross-validated against
the FLP's named mixer inserts: where the auto channel name
references an insert by name, the decoded `insert` matches the
mixer's `MixerInsert.index` for that name. Many decodes also
land on now-empty slots — users routinely delete plugins while
keeping the legacy automation channel; the decode is still
correct, the plugin just isn't there anymore.

### How flpdiff uses this

Reorganize v3 (next phase):

1. For every automation channel, look up the matching `0xE3` event by
   `source_iid == channel.iid` and surface a `Channel.automationTarget`
   with `kind: "channel" | "unknown"` plus the resolvable channel iid
   when applicable.
2. When laying out playlist tracks, place each automation lane
   *immediately after* its target's lane, with `track.grouped = true`
   so FL renders the auto as a collapsible child of the instrument.
3. Mixer-slot automations: find the dominant channel routed to the
   target insert (max clip count on the playlist) and nest the auto
   under that channel's lane, inheriting its family. Falls back to
   the auto's own name-based classification when no channel is
   routed there (e.g. master-bus effects).
4. Automations of `kind: "unknown"` stay in their own family block
   (no nesting attempted).

### What's NOT covered

- The `_u4`/`_u5` magic constants — never seen anything other than
  `8` and `0x1D5` across 800+ events on the local corpus
- Multiple linked targets per automation (haven't seen >1 `0xE3`
  per source_iid in the corpus)
- The 6 high bits of `destination` (`bits 14..15`, mask `0xC000`).
  Mostly zero in the corpus — single observed exception (`0x7481`,
  insert ~82) had bits 14 and 12 set; cause not yet investigated

## `0xEE` TrackData — `grouped` flag at byte 47 + FL UI parent-inference

Track-data blob (per arrangement track, 70 bytes on FL 25). Layout
copied from PyFLP's `TrackEvent.STRUCT`:

```
offset  size  field            notes
0-3     u32   iid              FL-assigned track id
4-7     u32   color            0xAARRGGBB; high byte usually 0
8-11    u32   icon             icon id
12      u8    enabled          mute toggle
13-16   f32   height           1.0 = "100%"
17-20   i32   locked_height
21      u8    content_locked
22-25   u32   motion           enum
26-29   u32   press            enum
30-33   u32   trigger_sync     enum
34-37   u32   queued           4-byte bool
38-41   u32   tolerant         4-byte bool
42-45   u32   position_sync    enum
46      u8    grouped          "grouped with track above" Boolean
47      u8    locked           "lock to content" Boolean
48+     ?     trailing          undocumented
```

**Off-by-one fixed 2026-05-07.** PyFLP's struct comments use cumulative
END offsets, not start offsets. Earlier flpdiff builds had `grouped`
at byte 47 and `locked` at byte 48, which silently flipped the wrong
flag — FL UI showed "Lock to content" enabled instead of "Group with
above track" on every reorganized auto track. Fixed in flpdiff@8c26f16
after Roman caught the symptom in FL's track menu. See
`docs/mutations-gotchas.md` section 8 for the general rule about
porting PyFLP struct definitions.

### FL UI parent-inference rule

FL implements playlist-track grouping **positionally**: track N is a
child of the *nearest track at index <N* with `grouped == false`. So
the grouping is implied by sequence order — no separate "parent
pointer" is stored. Walking up:

```
idx=0  Drums    grouped=false   ← parent
idx=1  Kick     grouped=true    ← child of Drums
idx=2  Snare    grouped=true    ← child of Drums
idx=3  Bass     grouped=false   ← new parent
idx=4  Sub      grouped=true    ← child of Bass
```

A track at index 0 is always a parent regardless of its flag.

### Implication for `reorganize_project` v3

To nest an automation track under its target instrument:

1. Place the auto track *immediately after* the target's playlist
   row (positional adjacency is the only way FL recognises the
   parent).
2. Set `grouped = true` (byte 47) on the auto track via
   `setTrackGrouped`.
3. The target above MUST have `grouped == false` — if a chain of
   already-grouped tracks separates it from the auto, FL walks
   further up and resolves to the wrong parent.

### Round-trip caveat

`grouped` is preserved bit-exact through `parse → serialize → parse`
(verified on the v3 reorganize output). FL UI's *visual* rendering
of nesting (subtle indent + a fold-arrow on the parent) requires the
parent to be in the expanded state — controlled by FL at runtime, not
encoded in the file as far as we've observed. So a freshly-saved FLP
from our reorganize lands the children in expanded view by default.

If FL doesn't appear to render the indent visually after a fresh
load, click the parent track's name once — FL will show the children
as collapsible. None of the local-corpus FLPs surveyed (85 producer
projects) used playlist-track grouping, so we have no reference for
"how it should look user-saved" beyond what FL renders on our
generated output.

## `0xE0` Pattern notes + `0xDF` Pattern controllers — encoder-side reference

Both opcodes are pattern-scoped (live between `0x41 patternId` markers
in the event stream) and both carry a dense array of fixed-size
records. Multiple events of the same opcode within a pattern get
concatenated on read — FL reads `[0xE0 a, 0xE0 b]` as if it were one
`0xE0 a+b` blob. flpdiff's encoders coalesce to a single event per
opcode when rewriting; FL accepts both shapes.

### `0xE0` notes — 24 bytes per record

Cross-checked against PyFLP `NotesEvent.STRUCT` (cumulative-end
offsets corrected per D-45):

| Bytes | Field | Type | Notes |
|------:|-------|------|-------|
| 0..3 | `position` | u32 LE | tick offset within the pattern (PPQ) |
| 4..5 | `flags` | u16 LE | bit `0x08` = slide note; other bits unassigned |
| 6..7 | `channel_iid` | u16 LE | targets `Channel.iid` |
| 8..11 | `length` | u32 LE | length in PPQ ticks |
| 12..13 | `key` | u16 LE | FL MIDI range `[0, 131]` (60 = C5) |
| 14..15 | `group` | u16 LE | chord/slide group id (0 = ungrouped) |
| 16 | `fine_pitch` | u8 | 0..240 (120 = no shift) |
| 17 | reserved (PyFLP `_u1`) | u8 | encoder writes 0 |
| 18 | `release` | u8 | 0..128 (64 = neutral) |
| 19 | `midi_channel` | u8 | MIDI channel override |
| 20 | `pan` | u8 | 0..128 (64 = center) |
| 21 | `velocity` | u8 | 0..127 |
| 22 | `mod_x` | u8 | 0..255 |
| 23 | `mod_y` | u8 | 0..255 |

Encoder: `flpdiff/src/mutations/index.ts::encodeNote`. Round-trip
verified through FL: `addPatternNote` → `parseFLPFile` → FL load → FL
File→Save → re-parse preserves every field byte-exact (D-50 / F2.1.5;
only 5 bytes of FL save-counter metadata change anywhere in the file).

### `0xDF` controllers — 12 bytes per record

| Bytes | Field | Type | Notes |
|------:|-------|------|-------|
| 0..3 | `position` | u32 LE | tick offset within pattern |
| 4..5 | reserved (PyFLP `_u1` + `_u2`) | 2 × u8 | encoder writes 0 |
| 6 | `channel` | u8 | targets the channel by iid (truncated to u8) |
| 7 | `flags` | u8 | semantics not fully RE'd; encoder preserves what's set |
| 8..11 | `value` | float32 LE | normalized parameter value |

Encoder: `flpdiff/src/mutations/index.ts::encodeController`. Per-pattern
keyframe-automation points; FL's "event editor" on a piano roll renders
them as a step/curve over the pattern. Round-trip verified at the
parser level (re-serialize → re-parse preserves all 5 in our 5-point
ramp fixture; non-`0xDF` event stream byte-identical to baseline);
live-FL save round-trip pending Roman's next FL session (F2.2.3).

### Pattern-scope walker

Both encoders use a `findPatternScope` helper that returns
`{startIdx, endIdx}` for the slice from the `0x41` opcode that opens
the pattern through the byte before the next pattern boundary
(`0x41` or `0x63 ARRANGEMENT_NEW`, whichever comes first). When
rewriting `0xE0` / `0xDF`, the walker:

1. Drops every existing event of the target opcode within the scope
2. Inserts the new (single, coalesced) event right after the `0xC1`
   pattern-name event (or right after the `0x41` marker if the
   pattern has no name).

Mirrors FL's typical event order on freshly-saved files.

## Section ordering — channels, patterns, mixer, arrangement

Empirical observation across the FL 25 corpus (5 synthetic fixtures +
85 real producer projects):

```
[FLhd 14 bytes][FLdt header 8 bytes]
  ├ project metadata (tempo, time-sig, version banner, etc.)
  ├ channel + pattern openers — INTERLEAVED (0x40 and 0x41
  │   appear in mixed order), each carrying their full scope-event
  │   train until the next opener of either type
  ├ 0x63 ARRANGEMENT_NEW — opens the arrangement section
  │   (track-data 0xEE, track-name 0xEF, playlist 0xE9, time markers …)
  ├ 0xEC INSERT_FLAGS / 0x93 INSERT_END — opens the mixer section
  │   (per-insert 0x62 NEW_SLOT scopes, mixer params 0xE1, routing 0xE7)
  └ 0x33, 0xAA, …  trailing project state
```

Implication for encoders: a NEW channel or pattern slots in just
before the first `0x63` (after the channel/pattern interleave block,
before arrangements). FL accepts this placement and re-emits in the
same shape on save. See `findInsertionBeforeArrangements` in
`flpdiff/src/mutations/index.ts`.

## `0x40` Channel + `0x41` Pattern minimum-viable scopes (encoder side)

Both opcodes open a new scope (channel or pattern) with a u16 id; the
follow-up events inside that scope are what FL reads as the channel /
pattern's content. Most opcodes have FL-supplied defaults — encoders
need to emit only the bare minimum.

### Minimum new pattern (`createPattern`)

```
0x41  u16  newId           // OP_PATTERN_NEW: id = max(existing) + 1
0xC1  blob name (UTF-16LE) // OP_PATTERN_NAME, optional but recommended
```

That's it. FL renders length / color / looped / notes / controllers
from defaults on first read and re-emits explicit events on the next
save once the user touches them. `0xA4` length defaults to "use
project bar"; `0x96` color falls back to the palette default; `0x1A`
looped defaults to false.

### Minimum new channel (`createChannel`)

```
0x40  u16   newIid         // OP_NEW_CHANNEL: iid = max(existing) + 1
0x15  u8    kindByte       // OP_CHANNEL_TYPE: 0=sampler, 2=instrument,
                           //                  3=layer, 5=automation
0xCB  blob  name           // OP_NAME (channel scope)
[0xC9 blob  ""]            // optional: empty OP_PLUGIN_INTERNAL_NAME
                           //   for instrument kind, signals "placeholder
                           //   for a future plugin" to FL
```

The `0x15` byte is what FL uses to classify the channel — without it
the channel reads as `kind="unknown"` and FL renders an empty slot.
Sampler channels need only the byte; instrument channels also need
the `0xC9` slot present (even if empty) so FL knows to expect a
plugin DLL hookup. Other supporting opcodes (`0x80` color, `0x16`
routing, `0xCB` levels, `0xD7` plugin-state blob, …) all default
sensibly when absent — the first FL save round-trip emits them.

### `header.n_channels` is legacy

The `FLhd` header's u16 `n_channels` field is documented as legacy
(`flpdiff/src/parser/flp-project.ts:14-18`) — modern FL always writes
`0` and derives the real count from the event stream. `createChannel`
intentionally does NOT bump this field; the new `0x40` event alone is
sufficient for FL to surface the new channel in the rack. (Decision
D-53.)

## `0xD5` Fruity Parametric EQ 2 — encoder-side patch points

The blob's parameter region is layout-stable across FL 25.x:

| Offset (hex) | Field | Type | Notes |
|-------------:|-------|------|-------|
| `0x00..0x03` | header | 4 bytes | not yet decoded |
| `0x04..0x1f` | Band 1..7 **level** | 7 × `u16 LE` (4-byte slot stride) | normalized = `raw / 0xFFFF` |
| `0x20..0x3b` | Band 1..7 **freq** | 7 × `u16 LE` | |
| `0x3c..0x57` | Band 1..7 **width** | 7 × `u16 LE` | |
| `0x58..0x73` | Band 1..7 **type** | 7 × `u8` enum (0..7) | encoder skips (lossy 0..1 mapping) |
| `0x74..0x8f` | Band 1..7 **order** | 7 × `u8` enum | encoder skips |
| `0x90..0x91` | **Main level** | `u16 LE` | |
| `0x92..end`  | trailing opaque state | varies | FL 25.2.4 = 354 bytes total; older saves = 350 |

`setNativePluginParam` only writes the uint16 LE slots (level / freq
/ width / main_level). The encoder validates the blob size is in
`[0x92, 500]` to tolerate FL save-version drift while still rejecting
unrelated blobs at the same scope.

**VST plugins (Fruity Wrapper-hosted)** also live under `0xD5` but
their payload contains session-internal noise that drifts across
same-value saves. Fixed-offset RE doesn't translate; encoders refuse
unregistered plugin names with `UNSUPPORTED_PLUGIN`. (Decision D-54.)

## Mixer slot index — file vs FL UI / IPC

A subtle off-by-one between flpdiff's parser and FL's runtime API
surfaced while RE'ing plugin layouts:

- **flpdiff's parser**: each `0x62 N` (`OP_NEW_SLOT`, u16 value)
  attributes its scope's events to slot index N.
- **FL Studio's runtime** (`plugins.getPluginName(insert, slot)`,
  `plugins.setParamValue(value, param, insert, slot)`): slot index is
  `0x62 N + 1`. Specifically:
  - Events BEFORE the first `0x62` of an insert → FL slot 0.
  - Events between `0x62 (N-1)` and `0x62 N` → FL slot N.
  - Events between `0x62 N` and `0x62 (N+1)` → FL slot N+1.

So a plugin the file places between `0x62 7` and `0x62 8` is FL
slot 8, not slot 7. Verified empirically against `junie.flp`'s
master mixer: file-side `0x62 7 → 0xC9 "Fruity Limiter" → 0x62 8`
exposes via IPC as `getPluginName(0, 8) → "Fruity Limiter"`.

flpdiff's existing parser surface uses file-side slot numbers (no
shift). Code that needs to address FL's runtime API must add `+1`
to its `slot` value at the boundary, or special-case "events before
first `0x62`" as FL slot 0.

## Synthesizing FLPs with single-plugin contents

Goal: programmatically craft a clean FLP carrying ONE specified
plugin in a known mixer slot, suitable as input to RE tools like
`sweep_plugin_layout`. Status as of 2026-05-09: **partial — FL UI
recognizes the plugin but IPC runtime API doesn't always bind it.**

What works:
- Splicing the 6-event slot scope (`0xC9` internal name + `0xD4`
  runtime data + `0x9B` / `0x80` / `0x29` metadata + `0xD5` plugin
  state) from a working donor FLP into a target slot of a clean
  base.
- flpdiff's parser correctly reports the spliced plugin at the new
  scope.
- FL opens the file without errors and renders the plugin's UI
  window when the slot is clicked.

What doesn't (yet):
- `plugins.getPluginName(insert, slot)` returns "Plugin not valid"
  for the spliced plugin in some cases.
- `plugins.setParamValue` refuses to bind a parameter on the slot.

Confirmed NOT the cause:
- `0xEC` INSERT_FLAGS payload (12 bytes) — byte-identical between
  the working donor and a base file.
- `0xE1` MixerParams record set — same 577 records, same 181
  distinct (insert, slot) combos.
- `0xE7` insert routing — copied as-is in the splice.

Suspected: a project-level metadata blob (still under
investigation) ties the slot to a "loaded" state that purely-static
event copying doesn't reproduce. Multi-hour follow-up RE deferred.

**Workaround**: have FL itself save a base fixture once per plugin
(drag plugin → File → Save As `base_<plugin>.flp`); the resulting
file is a valid sweep input. The on-disk shape is identical to
what synthesis tries to produce, but FL's "saved" version carries
whatever the missing context is.

## Changelog

- **2026-04-16** — Initial version. Tempo at bytes 155-158 as
  `bpm × 1000` u32 LE. Documented `0x36` and `0xC0` range-rule
  violations (later corrected — see 2026-05-02).
- **2026-05-02** — Issue #1 (Holzchopf) corrected the FL 25 banner
  classification: `0x36` is NOT an opcode; it's the varint length
  byte of a `0xC0` TEXT-range event. The real range-rule violation
  is `0xAC`, which carries a 3-byte (not 4-byte) payload. Override
  table now: `{0xAC: byte3}`; `0x36` removed.
- **2026-04-17** — Tempo end-to-end via the existing `0x9C` opcode
  once the FL 25 overrides realign the event stream. `0xE1`
  MixerParams sparse-packing documented.
- **2026-04-18** — VST plugin-state FL-serialization marker
  catalogued (FL 9 = 6, FL 20.5 = 9, FL 21.1 = 10, FL 24.1 = 11,
  FL 25.2 = 12). EQ 2 plugin-state RE captured.
