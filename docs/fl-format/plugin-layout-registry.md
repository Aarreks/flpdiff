# Native FL plugin parameter layouts — registry + RE process

`setNativePluginParam` (Epic 5 / F2.4) byte-patches a single parameter
inside a native FL plugin's `0xD5` state blob. Each plugin needs an
entry in `PLUGIN_PARAM_LAYOUTS` (`flpdiff/src/mutations/index.ts`)
mapping its parameter indices to byte offsets + field types.

## Registry shape

```ts
type PluginLayout = {
  minSize: number; // last param byte + 1; smaller blobs reject
  maxSize: number; // generous upper bound (rejects unrelated blobs)
  paramRefToOffset: (ref: PluginParamRef) =>
    { offset: number; fieldType: "u8" | "u16" } | null;
};

const PLUGIN_PARAM_LAYOUTS: Record<string, PluginLayout> = {
  "Fruity Parametric EQ 2": EQ2_LAYOUT,
  "Fruity parametric EQ 2": EQ2_LAYOUT,
  // … add new plugins here
};
```

`paramRefToOffset` is the per-plugin function that maps an LLM-supplied
`PluginParamRef` (one of `{kind:"main_level"}`, `{kind:"band", band, field}`,
`{kind:"param", index}`) to a `(offset, fieldType)` pair. The encoder
writes `round(value * 0xFFFF)` for `u16` slots and
`round(value * 0xFF)` for `u8` slots, both LE.

For new plugins, use the generic `{kind:"param", index}` ref — the
auto-sweep tool emits layouts in that shape.

## Auto-sweep tool

`python -m tools.re_harness.sweep_plugin_layout`
(`python/tools/re_harness/sweep_plugin_layout.py`)

Drives FL via the existing IPC harness to discover a plugin's layout:

1. Loads a baseline FLP that already has the target plugin instantiated.
2. Calls `plugins.getParamCount` + `plugins.getParamName` over IPC to
   enumerate the plugin's parameters.
3. For each `paramIdx`:
   a. Sets `paramIdx` to a low value (default 0.0) via
      `plugins.setParamValue`.
   b. Triggers File → Save through `save_via_menu()`.
   c. Re-parses the FLP, extracts the `0xD5` blob.
   d. Repeats with a high value (default 1.0).
   e. Diffs low vs high blobs — bytes that differ are the param's slot.
4. Classifies field type by diff width:
   - 1 byte → `u8`
   - 2 consecutive bytes → `u16` LE
   - 4 consecutive bytes → flagged as `u32-or-f32` (caller picks)
5. Emits a TS snippet ready to paste into `PLUGIN_PARAM_LAYOUTS`.

Run cost: ~0.5 s per parameter (set + save + re-parse). Fruity Limiter
(~10 params) takes ~10 s; EQ 2 (36 params) takes ~30 s.

Prerequisites: Mac unlocked, FL Studio installed with Accessibility
permissions, MIDI script live (`verify_setup` returns ok).

### Example: RE'ing Fruity Reeverb 2

```bash
# 1. Make a baseline FLP with Reeverb 2 in a known mixer slot.
#    (Drag the plugin onto, e.g., insert 1 / slot 0, save as
#    base_reeverb.flp.)

# 2. Run the sweep:
python -m tools.re_harness.sweep_plugin_layout \
    --baseline path/to/base_reeverb.flp \
    --scope mixer --insert 1 --slot 0 \
    --plugin-name "Fruity Reeverb 2" \
    --output reeverb2_layout.ts

# 3. Review reeverb2_layout.ts. Sanity-check:
#    - All params have non-empty differing_offsets (no missed/no-op
#      params).
#    - Offsets are sensibly clustered (no apparent garbage).
#    - For u32-or-f32 slots, manually verify by checking whether the
#      patched bytes match round(0.5 * 0xFFFFFFFF) (u32) or
#      0x3F000000 (f32 = 0.5).
#    - minSize and maxSize make sense for the blob's true scope.

# 4. Paste the snippet into
#    flpdiff/src/mutations/index.ts::PLUGIN_PARAM_LAYOUTS,
#    add a test, commit.
```

## Plugin coverage status

Pending RE (priority by corpus frequency):

| Plugin | Local-corpus instances | Priority |
|---|--:|---|
| Fruity Reeverb 2 | 225 | high |
| Fruity Limiter | 174 | high |
| Maximus | 88 | medium |
| Soundgoodizer | 88 | medium |
| Fruity Balance | 82 | medium |
| Fruity PanOMatic | 70 | medium |
| Fruity Filter | 60 | medium |
| Fruity Delay 2 | 45 | low |
| Fruity Delay 3 | 40 | low |
| Fruity Compressor | 38 | low |
| Fruity Fast Dist | 34 | low |
| Fruity WaveShaper | 32 | low |
| Fruity Stereo Shaper | 30 | low |
| Fruity Blood Overdrive | 25 | low |

Shipped:

| Plugin | Status |
|---|---|
| Fruity Parametric EQ 2 (both name variants) | ✅ F2.4 |

## VST plugins explicitly out of scope

VST-wrapped plugins (Serum, Sylenth1, Massive, FabFilter, Soundtoys,
LFOTool, soothe2, Decapitator, etc.) embed session-internal state in
their `0xD5` blob that drifts across same-value saves — fixed-offset
RE doesn't translate.

For VST parameters, use the live MIDI-script path:
`live_execute(kind="set_plugin_param", args={...})`. The live path
calls FL's `plugins.setParamValue` directly, so the plugin sees the
change as a normal automation event regardless of its serialization
shape. (Decision D-54.)
