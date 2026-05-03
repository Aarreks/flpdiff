import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFLPFile } from "../src/parser/flp-project.ts";
import { serializeFLPProject } from "../src/parser/flp-write.ts";

const CORPUS_ROOT = join(import.meta.dir, "corpus");

function listFLPs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) {
      // Skip user-local corpus (gitignored, may not exist on CI)
      if (name === "local") continue;
      out.push(...listFLPs(full));
    } else if (name.endsWith(".flp")) {
      out.push(full);
    }
  }
  return out;
}

const corpus = listFLPs(CORPUS_ROOT);

describe("FLP serializer round-trip", () => {
  test("corpus has at least one FLP", () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  for (const path of corpus) {
    const rel = path.slice(CORPUS_ROOT.length + 1);
    test(`bit-exact round-trip: ${rel}`, () => {
      const original = readFileSync(path);
      const project = parseFLPFile(
        original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength),
      );
      const reserialized = serializeFLPProject(project);

      expect(reserialized.byteLength).toBe(original.byteLength);

      // Byte-exact compare. Walk in chunks so the failure message
      // points at the first divergence rather than dumping entire
      // payloads.
      let firstDiff = -1;
      const limit = Math.min(reserialized.byteLength, original.byteLength);
      for (let i = 0; i < limit; i++) {
        if (reserialized[i] !== original[i]) {
          firstDiff = i;
          break;
        }
      }
      if (firstDiff !== -1) {
        const ctx = (buf: Uint8Array) =>
          Array.from(buf.slice(Math.max(0, firstDiff - 8), firstDiff + 8))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(" ");
        throw new Error(
          `byte mismatch at offset ${firstDiff}\n  orig:  ${ctx(original)}\n  rewr:  ${ctx(reserialized)}`,
        );
      }
    });
  }
});
