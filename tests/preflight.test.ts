import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FLPProject } from "../src/parser/flp-project.ts";
import {
  analyzePreflight,
  classifySamplePath,
  formatBytes,
  preflightHasErrors,
  preflightHasWarnings,
  renderPreflight,
} from "../src/preflight.ts";

type ProjectDeps = Pick<FLPProject, "channels" | "inserts">;

function projectWithSamples(paths: string[]): ProjectDeps {
  return {
    channels: paths.map((sample_path, iid) => ({
      iid,
      kind: "sampler" as const,
      name: `Sample ${iid + 1}`,
      sample_path,
    })),
    inserts: [],
  };
}

describe("preflight — path classification", () => {
  test("recognises FL tokens, Windows absolute, POSIX absolute, and relative paths", () => {
    expect(classifySamplePath("%FLStudioFactoryData%/Data/Patches/Kick.wav")).toEqual({
      kind: "token",
      token: "FLStudioFactoryData",
      remainder: "Data/Patches/Kick.wav",
    });
    expect(classifySamplePath("C:\\Samples\\Kick.wav").kind).toBe("absolute");
    expect(classifySamplePath("\\\\server\\share\\Kick.wav").kind).toBe("absolute");
    expect(classifySamplePath("//server/share/Kick.wav").kind).toBe("absolute");
    expect(classifySamplePath("/samples/Kick.wav").kind).toBe("absolute");
    expect(classifySamplePath("samples/Kick.wav").kind).toBe("relative");
  });
});

describe("preflight — filesystem analysis", () => {
  test("resolves project-local audio and flags missing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "flpdiff-preflight-"));
    await mkdir(join(root, "samples"));
    await writeFile(join(root, "samples", "kick.wav"), new Uint8Array([1, 2, 3, 4]));

    const project = projectWithSamples(["samples/kick.wav", "samples/missing.wav"]);
    const report = await analyzePreflight(project, join(root, "song.flp"));

    expect(report.stats.sampleReferences).toBe(2);
    expect(report.stats.uniqueSamplePaths).toBe(2);
    expect(report.stats.resolvedSamples).toBe(1);
    expect(report.stats.missingSamples).toBe(1);
    expect(report.stats.resolvedBytes).toBe(4);
    expect(preflightHasErrors(report)).toBe(true);
    expect(report.issues.some((i) => i.code === "missing-sample")).toBe(true);
  });

  test("coalesces slash variants of the same referenced path", async () => {
    const root = await mkdtemp(join(tmpdir(), "flpdiff-preflight-"));
    await mkdir(join(root, "samples"));
    await writeFile(join(root, "samples", "kick.wav"), new Uint8Array([1]));
    const project = projectWithSamples(["samples/kick.wav", "samples\\kick.wav"]);
    const report = await analyzePreflight(project, join(root, "song.flp"));

    expect(report.stats.sampleReferences).toBe(2);
    expect(report.stats.uniqueSamplePaths).toBe(1);
    expect(report.samples[0]!.referencedBy).toHaveLength(2);
  });

  test("preserves case-distinct reference spellings", async () => {
    const root = await mkdtemp(join(tmpdir(), "flpdiff-preflight-"));
    const report = await analyzePreflight(
      projectWithSamples(["kick.wav", "KICK.wav"]),
      join(root, "song.flp"),
    );

    expect(report.stats.uniqueSamplePaths).toBe(2);
  });

  test("token mappings make FL library paths verifiable", async () => {
    const root = await mkdtemp(join(tmpdir(), "flpdiff-preflight-"));
    const factory = join(root, "factory");
    await mkdir(join(factory, "Data", "Patches"), { recursive: true });
    await writeFile(join(factory, "Data", "Patches", "Kick.wav"), new Uint8Array([7, 8]));
    const project = projectWithSamples(["%FLStudioFactoryData%/Data/Patches/Kick.wav"]);

    const unmapped = await analyzePreflight(project, join(root, "song.flp"));
    expect(unmapped.stats.unresolvedSamples).toBe(1);
    expect(preflightHasWarnings(unmapped)).toBe(true);
    expect(unmapped.issues.some((i) => i.code === "unresolved-token")).toBe(true);

    const mapped = await analyzePreflight(project, join(root, "song.flp"), {
      tokenRoots: { FLStudioFactoryData: factory },
    });
    expect(mapped.stats.resolvedSamples).toBe(1);
    expect(mapped.stats.unresolvedSamples).toBe(0);
    expect(mapped.samples[0]!.sizeBytes).toBe(2);
  });


  test("resolves relative samples through an additional search root", async () => {
    const root = await mkdtemp(join(tmpdir(), "flpdiff-preflight-"));
    const projectRoot = join(root, "project");
    const libraryRoot = join(root, "library");
    await mkdir(projectRoot);
    await mkdir(join(libraryRoot, "packs"), { recursive: true });
    await writeFile(join(libraryRoot, "packs", "kick.wav"), new Uint8Array([3, 1, 4]));

    const project = projectWithSamples(["packs/kick.wav"]);
    const withoutSearchPath = await analyzePreflight(project, join(projectRoot, "song.flp"));
    expect(withoutSearchPath.stats.missingSamples).toBe(1);

    const withSearchPath = await analyzePreflight(project, join(projectRoot, "song.flp"), {
      searchPaths: [libraryRoot],
    });
    expect(withSearchPath.stats.resolvedSamples).toBe(1);
    expect(withSearchPath.samples[0]!.sizeBytes).toBe(3);
    expect(withSearchPath.issues.filter((i) => i.code === "relative-outside-root")).toHaveLength(1);
  });

  test("does not count two path spellings of one file as duplicate storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "flpdiff-preflight-"));
    await mkdir(join(root, "samples"));
    const payload = new TextEncoder().encode("one physical file");
    await writeFile(join(root, "samples", "take.wav"), payload);

    const project = projectWithSamples([
      "samples/take.wav",
      "samples/../samples/take.wav",
    ]);
    const report = await analyzePreflight(project, join(root, "song.flp"), { hash: true });

    expect(report.stats.resolvedSamples).toBe(2);
    expect(report.stats.resolvedBytes).toBe(payload.byteLength);
    expect(report.duplicateContent).toHaveLength(0);
    expect(report.stats.redundantBytes).toBe(0);
    expect(report.stats.contentUniqueBytes).toBe(payload.byteLength);
  });

  test("reports path-portability hazards even when the referenced file is missing", async () => {
    const parent = await mkdtemp(join(tmpdir(), "flpdiff-preflight-"));
    const root = join(parent, "project");
    await mkdir(root);
    const report = await analyzePreflight(
      projectWithSamples(["../missing.wav"]),
      join(root, "song.flp"),
    );

    expect(report.issues.filter((i) => i.code === "relative-outside-root")).toHaveLength(1);
    expect(report.issues.some((i) => i.code === "missing-sample")).toBe(true);
  });

  test("--hash-style analysis finds duplicate audio by content, not filename", async () => {
    const root = await mkdtemp(join(tmpdir(), "flpdiff-preflight-"));
    const payload = new TextEncoder().encode("same audio bytes");
    await writeFile(join(root, "take-a.wav"), payload);
    await writeFile(join(root, "take-b.wav"), payload);
    await writeFile(join(root, "different.wav"), new TextEncoder().encode("different"));

    const project = projectWithSamples(["take-a.wav", "take-b.wav", "different.wav"]);
    const report = await analyzePreflight(project, join(root, "song.flp"), { hash: true });

    expect(report.stats.hashedSamples).toBe(3);
    expect(report.samples[0]!.sha256).toBe(
      "aafe9f6cb200b33109672a43c8ea1e40835484abeb0520632cdc9362ce1f58a1",
    );
    expect(report.duplicateContent).toHaveLength(1);
    expect(report.duplicateContent[0]!.paths).toHaveLength(2);
    expect(report.duplicateContent[0]!.redundantBytes).toBe(payload.byteLength);
    expect(report.stats.redundantBytes).toBe(payload.byteLength);
    expect(report.stats.contentUniqueBytes).toBe(report.stats.resolvedBytes - payload.byteLength);
  });
});

describe("preflight — plugin inventory and rendering", () => {
  test("inventories VST and native plugin dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "flpdiff-preflight-"));
    const project: ProjectDeps = {
      channels: [
        {
          iid: 0,
          kind: "instrument",
          plugin: { internalName: "Fruity Wrapper", name: "Serum", vendor: "Xfer Records" },
        },
      ],
      inserts: [
        {
          index: 0,
          slots: [
            { index: 0, hasPlugin: true, internalName: "Fruity Limiter", pluginName: "Fruity Limiter" },
            {
              index: 1,
              hasPlugin: true,
              internalName: "Fruity Wrapper",
              pluginVstName: "Serum",
              pluginVendor: "Xfer Records",
            },
          ],
        },
      ],
    };

    const report = await analyzePreflight(project, join(root, "song.flp"));
    expect(report.stats.vstPlugins).toBe(1);
    expect(report.stats.nativePlugins).toBe(1);
    const serum = report.plugins.find((p) => p.name === "Serum");
    expect(serum?.occurrences).toBe(2);
    expect(report.issues.some((i) => i.code === "external-vst")).toBe(true);

    const rendered = renderPreflight(report);
    expect(rendered).toContain("Plugins: 1 external VST, 1 native");
    expect(rendered).toContain("Serum");
    expect(rendered).toContain("Xfer Records");
  });

  test("formatBytes uses readable binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.00 KiB");
    expect(formatBytes(1024 * 1024 * 5)).toBe("5.00 MiB");
  });
});
