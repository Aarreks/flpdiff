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
    | { offset: number;
        fieldType: "u8" | "u16" | "u32" | "f32" | "i32_bipolar";
        scale?: number; // required when fieldType === "i32_bipolar"
      }
    | null;
};

const PLUGIN_PARAM_LAYOUTS: Record<string, PluginLayout> = {
  "Fruity Parametric EQ 2": EQ2_LAYOUT,
  "Fruity parametric EQ 2": EQ2_LAYOUT,
  // … add new plugins here
};
```

`paramRefToOffset` is the per-plugin function that maps an LLM-supplied
`PluginParamRef` (one of `{kind:"main_level"}`, `{kind:"band", band, field}`,
`{kind:"param", index}`) to an offset + field type. Encoder writes the
normalized [0,1] value as:
- `u8`: `round(v * 0xFF)`, 1 byte
- `u16`: `round(v * 0xFFFF)`, 2 bytes LE
- `u32`: `round(v * 0xFFFFFFFF)`, 4 bytes LE
- `f32`: IEEE-754 single-precision, 4 bytes LE (raw `v`, no scaling)
- `i32_bipolar`: `round((v * 2 - 1) * scale)` written as int32 LE.
  `0.0 → -scale`, `0.5 → 0`, `1.0 → +scale`. **Most common 4-byte
  encoding** for FL native knobs (verified on Reeverb 2 Stereo
  separation scale=64, Limiter Comp ratio + knee scale=1000).

For 4-byte slots discovered by the sweep tool (emitted as
`u32-or-f32`), **probe FL first** — most are `i32_bipolar` with a
plugin-specific scale. Set normalized values 0.0/0.5/1.0 via FL IPC,
save, byte-diff at the offset:
- 0.0 → all-negative-ones with high bit set, 0.5 → all zeros,
  1.0 → small positive value → `i32_bipolar`, scale = abs(int32(0.0)).
- 0.5 → `0x00 0x00 0x00 0x3F` → `f32`.
- 0.5 → `0xFF 0xFF 0xFF 0x7F` → `u32`.

See `python/tools/re_harness/sweep_plugin_layout.py` for the IPC
driver pattern, and the per-plugin probe scripts in `/tmp/probe_*.py`
for examples of the byte-classification step.

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

### End-to-end pipeline (no manual FL save needed)

The synthesis tool `flpdiff/src/synth/craft-plugin-fixture.ts` builds
a clean single-plugin FLP from a donor file (any FLP that already has
the plugin instantiated). Combined with `sweep_plugin_layout.py`, the
full flow takes ~1 minute per plugin and runs without touching FL's
UI.

```bash
# Pick a donor FLP that has the plugin you want to RE.
DONOR=tests/corpus/local/junie.flp           # has many native plugins
BASELINE=tests/corpus/re_base/fl25/base_empty.flp
PLUGIN="Fruity Limiter"
OUT=/tmp/base_limiter.flp

# 1. Craft a clean fixture: base_empty + the plugin's slot scope
#    spliced into master at file-slot-marker 7 (FL IPC slot 8).
bun src/synth/craft-plugin-fixture.ts \
    --baseline "$BASELINE" \
    --donor "$DONOR" \
    --plugin "$PLUGIN" \
    --out "$OUT"
# Output: extracts 6 events from donor, writes ~46 KB FLP, prints
# "FL IPC slot index = 8"

# 2. Cold-restart FL with the fixture (most reliable IPC recovery).
cd python && FLPDIFF_HARNESS_INBOX="$HOME/Documents/Image-Line/FL Studio/Settings/Hardware/flstudio-mcp/runtime" \
  python -c "
from pathlib import Path
from tools.re_harness.autodrive import restart_fl, wait_for_clean_fl
restart_fl(flp_path=Path('$OUT'), wait_seconds=22.0)
print('IPC:', wait_for_clean_fl(max_attempts=12, dismiss_per_attempt=3, retry_delay=3.0))
"

# 3. Sweep the plugin's params via FL IPC. Note: target-slot uses
#    the FL IPC slot index (= file-slot-marker + 1), so for a fixture
#    crafted at default slot-marker=7, pass --slot 8.
FLPDIFF_HARNESS_INBOX="$HOME/Documents/Image-Line/FL Studio/Settings/Hardware/flstudio-mcp/runtime" \
  python -m tools.re_harness.sweep_plugin_layout \
    --baseline "$OUT" \
    --scope mixer --insert 0 --slot 8 \
    --plugin-name "$PLUGIN" \
    --output /tmp/limiter_layout.ts
# Output: per-param diff offsets, blob size info, TS snippet ready
# to paste into PLUGIN_PARAM_LAYOUTS

# 4. Review limiter_layout.ts. Sanity-check:
#    - All params have non-empty differing_offsets (no missed/no-op
#      params).
#    - Offsets are sensibly clustered (no apparent garbage).
#    - For u32-or-f32 slots (4-byte diffs), manually verify by
#      checking whether the patched bytes match round(0.5 * 0xFFFFFFFF)
#      (u32) or 0x3F000000 (f32 = 0.5). Encoder doesn't yet support
#      these field types, so they're commented out in the snippet.
#    - minSize/maxSize make sense (cross-check against real-corpus
#      survey of the plugin's blob size).

# 5. Paste the layout into flpdiff/src/mutations/index.ts under
#    PLUGIN_PARAM_LAYOUTS (with both name variants if FL emits
#    capitalisation drift), add a real-corpus blob-size survey
#    comment, commit.
```

**Important env quirk**: `FLPDIFF_HARNESS_INBOX` must point to the
`flstudio-mcp/runtime` directory under `~/Documents/Image-Line/FL
Studio/Settings/Hardware/`. Without it, `default_inbox()` falls back
to the legacy `flpdiff-harness/runtime` path and IPC silently writes
into the wrong directory (probes time out though FL is fine). Set it
inline on each `python` invocation — Bash subprocesses don't inherit
`export` from sibling commands.

### IPC instability — what to do when handshake fails

FL's MIDI script polling can stall after project switches. Symptoms:
`noop` works once after a fresh boot, then subsequent commands time
out. Recovery options (`autodrive` helpers, in order of effort):

1. **`wait_for_clean_fl(restart_after=N)`**: dismisses up to N modals
   then force-restarts FL with the baseline. Auto-wired into
   `sweep_plugin_layout`.
2. **Manual `restart_fl(flp_path)`**: kills FL via `kill -9`, waits
   3 s for macOS reaping, relaunches with the FLP loaded. Cold boot
   re-initialises the script's polling loop reliably.
3. **Worst case**: open FL → Options → MIDI Settings → toggle the
   IAC Bus 1 row's "Enable" off then on, set Controller type back
   to `flstudio-mcp`. Save settings. (D-32 — hot-reload doesn't
   work; only fresh boot does.)

## Plugin coverage status

Pending RE (priority by corpus frequency):

| Plugin | Local-corpus instances | Priority |
|---|--:|---|
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

| Plugin | Status | Coverage |
|---|---|---|
| Fruity Parametric EQ 2 (both name variants) | ✅ F2.4 | structured refs (band/main_level) |
| Fruity Reeverb 2 (both name variants) | ✅ via sweep + i32_bipolar verify | 15/15 (Stereo separation = i32_bipolar scale=64, FL-verified) |
| Fruity Limiter | ✅ via sweep + i32_bipolar verify | 18/18 (Comp ratio + knee = i32_bipolar scale=1000, FL-verified) |

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
