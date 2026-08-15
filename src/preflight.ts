/**
 * Project portability / backup preflight.
 *
 * FLP files often reference audio outside the project file itself. A semantic
 * diff can tell a producer what changed, but it cannot tell them whether a
 * collaborator or restore machine will actually be able to open the project.
 * This module inventories those external dependencies, resolves what it can,
 * optionally fingerprints audio by SHA-256, and reports portability hazards.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
  win32,
  posix,
} from "node:path";
import type { FLPProject } from "./parser/flp-project.ts";

export type SamplePathKind = "token" | "absolute" | "relative";
export type SampleResolutionStatus = "resolved" | "missing" | "unresolved";
export type PreflightSeverity = "info" | "warning" | "error";

export type SampleReference = {
  rawPath: string;
  filename: string;
  kind: SamplePathKind;
  token?: string;
  referencedBy: Array<{ iid: number; name?: string }>;
  resolvedPath?: string;
  status: SampleResolutionStatus;
  sizeBytes?: number;
  sha256?: string;
  issues: PreflightIssue[];
};

export type PluginDependency = {
  name: string;
  vendor?: string;
  isVst: boolean;
  occurrences: number;
};

export type DuplicateContentGroup = {
  sha256: string;
  sizeBytes: number;
  paths: string[];
  redundantBytes: number;
};

export type PreflightIssue = {
  severity: PreflightSeverity;
  code:
    | "missing-sample"
    | "unresolved-token"
    | "foreign-absolute-path"
    | "absolute-sample-path"
    | "relative-outside-root"
    | "external-vst"
    | "duplicate-content";
  message: string;
  path?: string;
};

export type PreflightStats = {
  sampleReferences: number;
  uniqueSamplePaths: number;
  resolvedSamples: number;
  missingSamples: number;
  unresolvedSamples: number;
  resolvedBytes: number;
  hashedSamples: number;
  contentUniqueBytes?: number;
  redundantBytes?: number;
  vstPlugins: number;
  nativePlugins: number;
};

export type PreflightReport = {
  file: string;
  root: string;
  samples: SampleReference[];
  plugins: PluginDependency[];
  duplicateContent: DuplicateContentGroup[];
  issues: PreflightIssue[];
  stats: PreflightStats;
};

export type PreflightOptions = {
  /** Directory relative sample paths are resolved against. Defaults to the FLP directory. */
  root?: string;
  /** Optional FL token mappings, e.g. { FLStudioFactoryData: "C:/..." }. */
  tokenRoots?: Readonly<Record<string, string>>;
  /** Additional roots to try for relative sample references, in order. */
  searchPaths?: readonly string[];
  /** Hash resolved sample files with SHA-256 to detect byte-identical duplicates. */
  hash?: boolean;
};

type ProjectDependencies = Pick<FLPProject, "channels" | "inserts">;

type ParsedSamplePath = {
  kind: SamplePathKind;
  token?: string;
  remainder?: string;
};

/** Classify an FL sample path without touching the filesystem. */
export function classifySamplePath(rawPath: string): ParsedSamplePath {
  const tokenMatch = /^%([^%]+)%[\\/]*(.*)$/.exec(rawPath);
  if (tokenMatch) {
    return {
      kind: "token",
      token: tokenMatch[1]!,
      remainder: tokenMatch[2] ?? "",
    };
  }
  if (win32.isAbsolute(rawPath) || posix.isAbsolute(rawPath)) {
    return { kind: "absolute" };
  }
  return { kind: "relative" };
}

/**
 * Inventory all sample and plugin dependencies referenced by a parsed project.
 * Filesystem checks are intentionally best-effort: paths from another OS are
 * marked unresolved rather than incorrectly reported missing.
 */
export async function analyzePreflight(
  project: ProjectDependencies,
  flpPath: string,
  options: PreflightOptions = {},
): Promise<PreflightReport> {
  const root = resolve(options.root ?? dirname(resolve(flpPath)));
  const tokenRoots = normalizeTokenRoots(options.tokenRoots ?? {});
  const searchPaths = normalizeSearchPaths(options.searchPaths ?? []);
  const samples = collectSampleReferences(project);
  const hashCache = new Map<string, string>();

  for (const sample of samples) {
    const parsed = classifySamplePath(sample.rawPath);
    sample.kind = parsed.kind;
    if (parsed.token !== undefined) sample.token = parsed.token;

    const resolution = resolveSamplePaths(sample.rawPath, parsed, root, tokenRoots, searchPaths);
    if (resolution.issue !== undefined) sample.issues.push(resolution.issue);
    if (resolution.paths === undefined) {
      sample.status = "unresolved";
      continue;
    }

    // Portability is a property of the reference itself, not of whether the
    // target happens to exist on this machine. Report structural hazards even
    // when the same sample is also missing so the user gets the full diagnosis.
    const relativeEscapesRoot =
      parsed.kind === "relative" && !isWithinRoot(root, resolution.paths[0]!);
    if (parsed.kind === "absolute") {
      sample.issues.push({
        severity: "warning",
        code: "absolute-sample-path",
        message: "Absolute sample paths are machine-specific; prefer a project-local or tokenized path.",
        path: sample.rawPath,
      });
    }

    let fileStat: { size: number } | null = null;
    let foundPath: string | undefined;
    for (const candidate of resolution.paths) {
      const candidateStat = await safeFileStat(candidate);
      if (candidateStat !== null) {
        foundPath = candidate;
        fileStat = candidateStat;
        break;
      }
    }

    if (foundPath === undefined || fileStat === null) {
      sample.resolvedPath = resolution.paths[0];
      sample.status = "missing";
      if (relativeEscapesRoot) {
        sample.issues.push({
          severity: "warning",
          code: "relative-outside-root",
          message: "Relative sample path escapes the project root and may be omitted from a backup or handoff.",
          path: sample.rawPath,
        });
      }
      const locations = resolution.paths.length;
      sample.issues.push({
        severity: "error",
        code: "missing-sample",
        message:
          locations === 1
            ? `Referenced sample does not exist: ${resolution.paths[0]}`
            : `Referenced sample was not found in ${locations} configured locations (first: ${resolution.paths[0]}).`,
        path: sample.rawPath,
      });
      continue;
    }

    sample.resolvedPath = foundPath;
    sample.status = "resolved";
    sample.sizeBytes = fileStat.size;

    if (parsed.kind === "relative" && !isWithinRoot(root, foundPath)) {
      sample.issues.push({
        severity: "warning",
        code: "relative-outside-root",
        message: relativeEscapesRoot
          ? "Relative sample path escapes the project root and may be omitted from a backup or handoff."
          : "Relative sample resolves through an external search path and may be omitted from a project-only backup or handoff.",
        path: sample.rawPath,
      });
    }

    if (options.hash === true) {
      const pathKey = normalizeResolvedPathKey(foundPath);
      let digest = hashCache.get(pathKey);
      if (digest === undefined) {
        digest = await sha256File(foundPath);
        hashCache.set(pathKey, digest);
      }
      sample.sha256 = digest;
    }
  }

  const plugins = collectPluginDependencies(project);
  const duplicateContent = options.hash === true ? findDuplicateContent(samples) : [];
  const issues = samples.flatMap((s) => s.issues);

  for (const plugin of plugins) {
    if (!plugin.isVst) continue;
    issues.push({
      severity: "info",
      code: "external-vst",
      message:
        `${plugin.name}${plugin.vendor ? ` (${plugin.vendor})` : ""} must be installed ` +
        "separately on a restore or collaborator machine.",
    });
  }
  for (const group of duplicateContent) {
    issues.push({
      severity: "info",
      code: "duplicate-content",
      message:
        `${group.paths.length} sample files are byte-identical; content-addressed storage ` +
        `could avoid ${formatBytes(group.redundantBytes)} of duplicate data.`,
    });
  }

  return {
    file: resolve(flpPath),
    root,
    samples,
    plugins,
    duplicateContent,
    issues,
    stats: computeStats(samples, plugins, duplicateContent, options.hash === true),
  };
}

function collectSampleReferences(project: ProjectDependencies): SampleReference[] {
  const byPath = new Map<string, SampleReference>();
  for (const ch of project.channels) {
    const rawPath = ch.sample_path;
    if (!rawPath) continue;
    const key = normalizeReferenceKey(rawPath);
    let ref = byPath.get(key);
    if (ref === undefined) {
      ref = {
        rawPath,
        filename: crossPlatformBasename(rawPath),
        kind: classifySamplePath(rawPath).kind,
        referencedBy: [],
        status: "unresolved",
        issues: [],
      };
      byPath.set(key, ref);
    }
    ref.referencedBy.push({ iid: ch.iid, ...(ch.name ? { name: ch.name } : {}) });
  }
  return Array.from(byPath.values());
}

function collectPluginDependencies(project: ProjectDependencies): PluginDependency[] {
  const byIdentity = new Map<string, PluginDependency>();

  const add = (name: string | undefined, vendor: string | undefined, isVst: boolean): void => {
    if (!name) return;
    const key = `${isVst ? "vst" : "native"}\u0000${vendor ?? ""}\u0000${name}`.toLowerCase();
    const existing = byIdentity.get(key);
    if (existing !== undefined) {
      existing.occurrences++;
      return;
    }
    byIdentity.set(key, {
      name,
      ...(vendor ? { vendor } : {}),
      isVst,
      occurrences: 1,
    });
  };

  for (const ch of project.channels) {
    const plugin = ch.plugin;
    if (!plugin) continue;
    const isVst = plugin.internalName === "Fruity Wrapper";
    add(isVst ? plugin.name ?? plugin.internalName : plugin.internalName, plugin.vendor, isVst);
  }

  for (const insert of project.inserts) {
    for (const slot of insert.slots) {
      if (slot.hasPlugin !== true) continue;
      const isVst = slot.internalName === "Fruity Wrapper";
      const name = isVst
        ? slot.pluginVstName ?? slot.pluginName ?? slot.internalName
        : slot.pluginName ?? slot.internalName;
      add(name, slot.pluginVendor, isVst);
    }
  }

  return Array.from(byIdentity.values()).sort((a, b) => {
    if (a.isVst !== b.isVst) return a.isVst ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function normalizeTokenRoots(input: Readonly<Record<string, string>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(input)) {
    out.set(key.toLowerCase(), value);
  }
  return out;
}

function normalizeSearchPaths(input: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    const normalized = resolve(value);
    const key = normalizeResolvedPathKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function resolveSamplePaths(
  rawPath: string,
  parsed: ParsedSamplePath,
  root: string,
  tokenRoots: ReadonlyMap<string, string>,
  searchPaths: readonly string[],
): { paths?: string[]; issue?: PreflightIssue } {
  if (parsed.kind === "token") {
    const token = parsed.token!;
    const mappedRoot = tokenRoots.get(token.toLowerCase());
    if (mappedRoot === undefined) {
      return {
        issue: {
          severity: "warning",
          code: "unresolved-token",
          message: `Cannot verify %${token}% without a token mapping; pass --token ${token}=<directory>.`,
          path: rawPath,
        },
      };
    }
    if (isForeignAbsolute(mappedRoot)) {
      return {
        issue: {
          severity: "warning",
          code: "foreign-absolute-path",
          message: `Token %${token}% maps to a path for another operating system and cannot be verified here.`,
          path: rawPath,
        },
      };
    }
    return { paths: [resolve(mappedRoot, normalizeRelative(parsed.remainder ?? ""))] };
  }

  if (parsed.kind === "absolute") {
    if (isForeignAbsolute(rawPath)) {
      return {
        issue: {
          severity: "warning",
          code: "foreign-absolute-path",
          message: "Absolute sample path belongs to another operating system and cannot be verified here.",
          path: rawPath,
        },
      };
    }
    return { paths: [resolve(rawPath)] };
  }

  const relativePath = normalizeRelative(rawPath);
  const candidates = [root, ...searchPaths].map((base) => resolve(base, relativePath));
  const seen = new Set<string>();
  return {
    paths: candidates.filter((candidate) => {
      const key = normalizeResolvedPathKey(candidate);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

function normalizeRelative(value: string): string {
  return value.replace(/[\\/]+/g, sep);
}

function normalizeReferenceKey(value: string): string {
  // Treat slash direction as presentation only, but preserve case. FL Studio
  // also runs on macOS, and case-sensitive project volumes can legitimately
  // contain two different files whose names differ only by case.
  return value.replace(/\\/g, "/");
}

function normalizeResolvedPathKey(value: string): string {
  const normalized = resolve(value);
  // Native Windows filesystems are normally case-insensitive. Folding case on
  // Windows prevents alternate spellings of the same file from being counted
  // as duplicate storage. On POSIX, preserve case because it can be meaningful.
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function crossPlatformBasename(value: string): string {
  return basename(value.replace(/\\/g, "/"));
}

function isForeignAbsolute(value: string): boolean {
  // `path.win32.isAbsolute("/tmp/x")` is true because a leading slash is
  // drive-rooted on Windows, so it cannot distinguish a POSIX path from a
  // Windows one. Detect drive-letter / UNC syntax explicitly instead.
  const windowsStyle = /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/]/.test(value);
  const posixStyle = value.startsWith("/") && !windowsStyle;
  if (process.platform === "win32") return posixStyle;
  return windowsStyle;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function safeFileStat(path: string): Promise<{ size: number } | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? { size: s.size } : null;
  } catch (e) {
    const code = (e as { code?: string } | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
}

async function sha256File(path: string): Promise<string> {
  return await new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function distinctResolvedSamples(samples: readonly SampleReference[]): SampleReference[] {
  // Different FLP spellings can resolve to the same physical pathname (for
  // example `samples/kick.wav` and `samples/../samples/kick.wav`). Count that
  // file once when estimating bytes or duplicate storage.
  const byResolvedPath = new Map<string, SampleReference>();
  for (const sample of samples) {
    if (sample.status !== "resolved" || sample.resolvedPath === undefined) continue;
    const key = normalizeResolvedPathKey(sample.resolvedPath);
    if (!byResolvedPath.has(key)) byResolvedPath.set(key, sample);
  }
  return Array.from(byResolvedPath.values());
}

function findDuplicateContent(samples: readonly SampleReference[]): DuplicateContentGroup[] {
  const groups = new Map<string, SampleReference[]>();
  for (const sample of distinctResolvedSamples(samples)) {
    if (!sample.sha256 || sample.sizeBytes === undefined) continue;
    const key = `${sample.sizeBytes}:${sample.sha256}`;
    const group = groups.get(key);
    if (group) group.push(sample);
    else groups.set(key, [sample]);
  }

  const out: DuplicateContentGroup[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const first = group[0]!;
    const sizeBytes = first.sizeBytes!;
    out.push({
      sha256: first.sha256!,
      sizeBytes,
      paths: group.map((s) => s.rawPath),
      redundantBytes: sizeBytes * (group.length - 1),
    });
  }
  return out.sort((a, b) => b.redundantBytes - a.redundantBytes);
}

function computeStats(
  samples: readonly SampleReference[],
  plugins: readonly PluginDependency[],
  duplicateContent: readonly DuplicateContentGroup[],
  hashed: boolean,
): PreflightStats {
  const sampleReferences = samples.reduce((n, s) => n + s.referencedBy.length, 0);
  const resolved = samples.filter((s) => s.status === "resolved");
  const resolvedBytes = distinctResolvedSamples(samples).reduce(
    (n, s) => n + (s.sizeBytes ?? 0),
    0,
  );
  const redundantBytes = duplicateContent.reduce((n, g) => n + g.redundantBytes, 0);
  const stats: PreflightStats = {
    sampleReferences,
    uniqueSamplePaths: samples.length,
    resolvedSamples: resolved.length,
    missingSamples: samples.filter((s) => s.status === "missing").length,
    unresolvedSamples: samples.filter((s) => s.status === "unresolved").length,
    resolvedBytes,
    hashedSamples: samples.filter((s) => s.sha256 !== undefined).length,
    vstPlugins: plugins.filter((p) => p.isVst).length,
    nativePlugins: plugins.filter((p) => !p.isVst).length,
  };
  if (hashed) {
    stats.redundantBytes = redundantBytes;
    stats.contentUniqueBytes = resolvedBytes - redundantBytes;
  }
  return stats;
}

/** Render a concise human-readable preflight report. */
export function renderPreflight(report: PreflightReport, options: { hashed?: boolean } = {}): string {
  const s = report.stats;
  const lines: string[] = [];
  lines.push(`FLP Preflight: ${basename(report.file)}`);
  lines.push(`Root: ${report.root}`);
  lines.push("");
  lines.push(
    `Samples: ${s.sampleReferences} refs, ${s.uniqueSamplePaths} unique paths, ` +
      `${s.resolvedSamples} resolved, ${s.missingSamples} missing, ${s.unresolvedSamples} unverified`,
  );
  if (s.resolvedSamples > 0) {
    lines.push(`Resolved audio: ${formatBytes(s.resolvedBytes)}`);
  }
  if (options.hashed === true) {
    lines.push(
      `Content fingerprints: ${s.hashedSamples} hashed, ` +
        `${formatBytes(s.contentUniqueBytes ?? s.resolvedBytes)} unique content, ` +
        `${formatBytes(s.redundantBytes ?? 0)} duplicate bytes`,
    );
  }

  if (report.samples.length > 0) {
    lines.push("");
    lines.push("Referenced audio:");
    for (const sample of report.samples) {
      const marker = sample.status === "resolved" ? "OK" : sample.status === "missing" ? "!!" : "??";
      const detail = sample.status === "resolved" && sample.sizeBytes !== undefined
        ? ` (${formatBytes(sample.sizeBytes)})`
        : "";
      const refs = sample.referencedBy.length > 1 ? `, ${sample.referencedBy.length} channels` : "";
      lines.push(`  ${marker} ${sample.filename}${detail}${refs}`);
      lines.push(`     ${sample.rawPath}`);
      for (const issue of sample.issues) {
        lines.push(`     ${severityLabel(issue.severity)} ${issue.message}`);
      }
    }
  }

  if (report.plugins.length > 0) {
    lines.push("");
    lines.push(`Plugins: ${s.vstPlugins} external VST, ${s.nativePlugins} native`);
    for (const plugin of report.plugins) {
      const kind = plugin.isVst ? "VST" : "native";
      const vendor = plugin.vendor ? ` — ${plugin.vendor}` : "";
      const count = plugin.occurrences > 1 ? ` ×${plugin.occurrences}` : "";
      lines.push(`  ${kind.padEnd(6)} ${plugin.name}${vendor}${count}`);
    }
  }

  if (report.duplicateContent.length > 0) {
    lines.push("");
    lines.push("Duplicate audio content:");
    for (const group of report.duplicateContent) {
      lines.push(
        `  ${group.paths.length} copies × ${formatBytes(group.sizeBytes)} ` +
          `(${formatBytes(group.redundantBytes)} redundant)`,
      );
      for (const path of group.paths) lines.push(`    - ${path}`);
    }
  }

  const errors = report.issues.filter((i) => i.severity === "error").length;
  const warnings = report.issues.filter((i) => i.severity === "warning").length;
  const info = report.issues.filter((i) => i.severity === "info").length;
  lines.push("");
  if (errors > 0) {
    lines.push(
      `Result: FAIL — ${errors} error${errors === 1 ? "" : "s"}, ` +
        `${warnings} warning${warnings === 1 ? "" : "s"}`,
    );
  } else if (warnings > 0) {
    lines.push(
      `Result: OK WITH WARNINGS — ${warnings} warning${warnings === 1 ? "" : "s"}` +
        `${info ? `, ${info} info` : ""}`,
    );
  } else {
    lines.push(`Result: OK${info ? ` — ${info} info` : ""}`);
  }
  return lines.join("\n");
}

export function preflightHasErrors(report: PreflightReport): boolean {
  return report.issues.some((i) => i.severity === "error");
}

export function preflightHasWarnings(report: PreflightReport): boolean {
  return report.issues.some((i) => i.severity === "warning");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[i]}`;
}

function severityLabel(severity: PreflightSeverity): string {
  switch (severity) {
    case "error":
      return "ERROR:";
    case "warning":
      return "WARN:";
    case "info":
      return "INFO:";
  }
}
