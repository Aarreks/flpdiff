# flpdiff Preflight — Easy Real-World Test Plan

Run these tests from the root of this fork (the folder containing `package.json`).

The goal is to test both:

1. **Control:** nothing is wrong / nothing changed.
2. **Treatment:** we deliberately create a real difference or broken dependency and make sure `flpdiff` notices it.

Do all destructive-looking tests on **copies**, not on the only copy of a real music project.

---

## 0. One-time setup

Open the cloned `flpdiff` folder in File Explorer, click the address bar, type:

```text
powershell
```

and press Enter.

If Bun is not installed:

```powershell
powershell -c "irm bun.sh/install.ps1|iex"
```

Close and reopen PowerShell, then check:

```powershell
bun --version
```

Install dependencies:

```powershell
bun install
```

Run the existing automated tests:

```powershell
bun test
```

**Expected:** existing tests pass.

---

# Test A — Semantic diff

This tests the existing core feature: can it tell that an FL Studio project actually changed?

## A1. Control — no difference

Take one real FLP and make a plain file copy:

```text
song-control.flp
song-identical.flp
```

Do **not** open or modify either one.

Run:

```powershell
bun run src/cli.ts "C:\path\song-control.flp" "C:\path\song-identical.flp"
```

Then:

```powershell
$LASTEXITCODE
```

**Expected:**

- It reports no semantic differences.
- Exit code is `0`.

If two byte-for-byte copies produce a meaningful diff, report that.

---

## A2. Treatment — difference IS present

Now create a project with one intentional change.

1. Open `song-control.flp` in FL Studio.
2. Immediately use **Save As** and create:

```text
song-treatment.flp
```

3. Change **exactly one obvious thing**. The easiest first test is BPM, for example:

```text
140 BPM -> 141 BPM
```

4. Save `song-treatment.flp`.
5. Close FL Studio.

Run:

```powershell
bun run src/cli.ts "C:\path\song-control.flp" "C:\path\song-treatment.flp"
```

Then:

```powershell
$LASTEXITCODE
```

**Expected:**

- It reports a project difference.
- The output should describe the BPM change correctly.
- Exit code is `1`.

For this command, **exit code 1 means "differences found," not "the program crashed."**

### Then try a few one-change treatments

Make a fresh treatment copy from the control for each test if possible.

Try one at a time:

- Move one playlist clip.
- Change one mixer channel's volume.
- Add one note.
- Delete one note.
- Change one plugin/preset/state value.
- Add one audio clip.
- Replace one sample.

For each case, ask:

> Does the output describe what a producer would actually say changed?

Write down anything missing, wrong, excessively noisy, or confusing.

---

# Test B — New `preflight` feature

This is the feature added in the modified repo.

It checks whether the FLP's external audio dependencies are available and flags
portability hazards before backup or handoff.

## B1. Control — healthy project

Use a project for which all normal samples are currently available.

Run:

```powershell
bun run src/cli.ts preflight "C:\path\song.flp"
```

**Expected:**

- It inventories referenced audio.
- It inventories plugins.
- Files that really exist should generally be reported as resolvable/present.
- It should not invent missing files that are actually there.

If it says a real file is missing, save the exact output and the real location of that file.
If the file lives in an FL Studio sample-library/search folder rather than beside
the project, retry with an additional lookup root:

```powershell
bun run src/cli.ts preflight "C:\path\song.flp" --search-path "D:\Samples"
```

The file should resolve, but preflight should still warn that the project depends
on data outside its own root.

---

## B2. Treatment — deliberately make one referenced WAV unavailable

Do this only in a **test copy of the project folder**.

1. Copy the whole relevant project folder somewhere temporary.
2. Pick one WAV that the copied FLP actually uses **and that preflight resolves
   inside that copied folder**. Do not use this treatment for an absolute
   reference that still points back to the original folder.
3. Temporarily rename it. Example:

```text
vocal_take_07.wav
```

becomes:

```text
vocal_take_07.wav.HIDDEN
```

4. Do **not** open and re-save the FLP after renaming it. We want the FLP still pointing at the old filename.

Run preflight on the copied FLP:

```powershell
bun run src/cli.ts preflight "C:\TEST-COPY\song.flp"
```

Then:

```powershell
$LASTEXITCODE
```

**Expected:**

- It should identify `vocal_take_07.wav` as missing/unresolved.
- Exit code should be `1` if the missing dependency is classified as an error.

After the test, rename the WAV back to its original name.

This is the main **positive treatment** for the new feature: we know a
dependency is broken, so the tool should detect it.

### If the project uses absolute or tokenized paths

Do not rename a sample in the real/original location just to make the test work.
Instead, force a harmless bad resolution against an empty temporary directory.

For a relative sample:

```powershell
$empty = Join-Path $env:TEMP "flpdiff-empty"
New-Item -ItemType Directory -Force $empty | Out-Null
bun run src/cli.ts preflight "C:\path\song.flp" --root $empty
```

For a tokenized sample such as `%FLStudioFactoryData%/...`:

```powershell
$empty = Join-Path $env:TEMP "flpdiff-empty"
New-Item -ItemType Directory -Force $empty | Out-Null
bun run src/cli.ts preflight "C:\path\song.flp" --token "FLStudioFactoryData=$empty"
```

**Expected:** references that normally resolve through that root/token should now
be reported missing. This creates a controlled positive treatment without
touching the real audio.

---

# Test C — Duplicate-content treatment

This tests the new `--hash` path and whether it can find wasted storage.

Use a copied project, not the original.

## C1. Make a deliberate duplicate

1. Pick a WAV already used by the project, for example:

```text
vocal.wav
```

2. Make a byte-for-byte copy:

```text
vocal-COPY.wav
```

3. In a **treatment copy** of the FL Studio project, add `vocal-COPY.wav`
   somewhere so that the FLP references both files.
4. Save that FLP.

Now run:

```powershell
bun run src/cli.ts preflight "C:\TEST-COPY\song-duplicate-treatment.flp" --hash
```

**Expected:**

- Both files should resolve.
- Their SHA-256 hashes should match.
- The tool should put them in the same duplicate-content group.
- It should report redundant bytes/storage.

If the two files are byte-for-byte identical and both referenced, but no duplicate is reported, that is a bug.

`--hash` reads the referenced audio files, so try this on a modest project before pointing it at 100+ GB.

---

# Test D — Machine-readable JSON

Run:

```powershell
bun run src/cli.ts preflight "C:\path\song.flp" --hash --format json > preflight.json
```

Open `preflight.json`.

**Expected:**

- Valid JSON.
- Referenced samples are represented.
- Paths/statuses make sense.
- Hashes appear for successfully hashed files.
- Duplicate groups appear if duplicates were found.
- Plugin inventory is represented.

If PowerShell output or logging corrupts the JSON, report it.

---

# What to send back

For each weird result, send:

```text
FL Studio version:
Approx project size:
Command run:

Expected:
Actual:

Was this control or treatment?

Relevant file/path:
Screenshot or pasted output:
```

And after trying it normally, answer these:

```text
1. Did anything crash?
2. Any real samples falsely reported missing?
3. Any missing samples it failed to detect?
4. Any plugin names obviously wrong?
5. Did the deliberate semantic change show up correctly?
6. Did the deliberately missing WAV show up correctly?
7. Did the deliberate duplicate show up with --hash?
8. Was any output too noisy or confusing?
9. What is the first thing you wish the tool told you that it does not?
```

Question 9 is especially useful for deciding what to build next.
