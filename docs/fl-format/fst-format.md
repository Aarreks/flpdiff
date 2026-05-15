# `.fst` — FL Studio preset format

Native FL plugin presets live as standalone `.fst` files alongside the
project format (`.flp`). FL bundles ~7,000 of them under
`/Applications/FL Studio 2025.app/Contents/Resources/FL/Data/Patches/Plugin presets/`,
plus another ~250 under `Channel presets/`.

This document covers what flpdiff needs to splice a `.fst` preset into
a target `.flp` as a fully-loaded channel (generator presets) or as a
mixer-slot plugin (effect presets). The on-disk format is small — most
of the complexity is in the splice path (Phase F9.2 + downstream).

## Top-level structure

Identical magic to `.flp`:

```
FLhd <hdr_size:u32> <container_kind:u16> <n_channels:u16> <ppq:u16>
FLdt <payload_size:u32> <event_stream>
```

Only the `container_kind` byte at FLhd offset 8 differs:

| Container | `container_kind` | What's inside |
|-----------|------------------|---------------|
| `.flp` arrangement project | `0x0010` | Full project: channels + mixer + patterns + arrangement |
| `.fst` plugin preset | `0x0030` | Single plugin scope: `0xC9` + `0xD4` + `0xD5` + supporting channel-scope opcodes |

Verified across 5 representative `.fst` files (Fruity DX10, FL Keys,
Sytrus, Drumaxx, Fruity Reeverb 2) — **all carry `container_kind=0x0030`**,
including effect presets. There is no separate "effect preset" container.
Generator-vs-effect distinction is **not encoded in the file**; callers
infer it from the source directory (`Plugin presets/Generators/` vs
`Plugin presets/Effects/`) or by looking up the plugin internal name
in a known-types registry.

`n_channels` defaults to a non-zero value (4–6 observed) but FL ignores
it inside `.fst` files — only the `FLdt` event stream matters.

## Event stream

The stream is **plain channel-scope events**, NOT wrapped by a `0x40`
channel-opener marker. The minimal preset (Fruity DX10 Steel Guitar,
192 bytes total):

```
0xC7  blob[6]  "3.3.2\0"             — FL version the preset was saved with
0xC9  blob[12] "Fruity DX10\0"       — plugin internal name (UTF-16LE NUL-terminated)
0xD4  blob[52] <runtime data>         — 52-byte plugin runtime descriptor (same shape as F6.6)
0xD5  blob[92] <plugin state>         — plugin-specific state blob
```

Extended presets (Sytrus, Drumaxx) add channel-decoration events that
FL persists alongside the plugin:

```
0x1C  u8       <channel kind byte>    — FL "instrument" classifier
0xCB  blob     "<display name>\0"     — preset display name (UTF-16LE)
0x9B  u32      <flags>                — channel flags
0x80  u32      <color>                — channel color (BGRA / 0xAABBGGRR)
0x29  u8       <metadata>             — channel metadata bit
0x9F  u32      <build>                — FL build number that saved
0x25  u8       <mode>                 — channel mode
```

These map 1:1 to channel-scope opcodes inside a regular `.flp`. When
spliced, they become part of the new channel's scope.

## Splice contract

`extractPluginScopeFromFst(donor)` returns the donor's full event
list with `0xC7` (FL version banner) stripped. The version banner is
local-to-the-preset metadata, not transferable.

Callers wrap the returned scope in a channel-opener envelope appropriate
for the target FLP:

```
0x40 newIid      <- new channel marker (caller-assigned iid)
0x15 kindByte    <- FL channel kind (1 = instrument)
0xCB displayName <- caller-chosen channel name
...donor scope (0xC9 + 0xD4 + 0xD5 + optional channel decoration)
```

Insertion point in the target events list matches `createChannel`
(F2.3): immediately before the first `0x63` arrangement-opener.

## Effects vs generators (splice asymmetry)

Both effect and generator `.fst` files use the same container + event
shape, but they splice into different scopes in the target FLP:

- **Generator** → splice as new top-level channel (channel rack entry).
  Wrap with the `0x40 + 0x15 + 0xCB` envelope above; place inside the
  channels section.
- **Effect** → splice into a mixer slot. Reuse the F6.6
  `instantiateNativePlugin` path: scope goes between
  `0x62 slotMarker` and the next `0x62` of the target insert.

The classification belongs to the caller (the manifest already
records `kind ∈ {generator, effect, channel_state}` based on source
directory). The extractor itself returns scope + plugin-internal-name
and lets callers route.

## Sample-bundled presets

Some FL native generators reference external sample files via `0xC4`
(channel sample path, UTF-16LE) inside their saved scope — FPC drum
kits, FLEX patches, Slicex slices, etc. These paths reference
`%FLStudioFactoryData%/...` for factory presets and resolve cleanly on
healthy FL installs. User-saved presets may point at absolute or
relative paths that don't survive splicing into a different machine —
out of scope for v1 (see R25 in MCP-SPEC.md).

## References

- `flpdiff/src/synth/extract-fst.ts` — channel-scope extractor.
- `flpdiff/src/synth/craft-plugin-fixture.ts` — F6.6 mixer-slot
  extractor (analogous shape for `.flp` donors).
- `MCP-SPEC.md` Epic 9 — splice helpers + MCP wiring.
