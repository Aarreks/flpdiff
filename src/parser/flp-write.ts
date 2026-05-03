/**
 * FLP serializer — inverse of `parseFLPFile`.
 *
 * Phase 3.0.3 of MCP-SPEC.md.
 *
 * Round-trip guarantee: `serializeFLPProject(parseFLPFile(bytes))`
 * returns bytes identical to the input for every supported FL
 * version. The parser retains every event's payload as-is (unknown
 * opcodes pass through as `blob`), and `FLPEventSchema.write()`
 * already inverses `read()` per-event. This module is the
 * file-level wrapper: emit the FLhd + FLdt frames and the event
 * stream in order.
 *
 * Design choice: full rewrite, not delta-write. Investigated against
 * MCP-SPEC.md Open Question 8. Verdict: full rewrite costs <1 ms on
 * a typical 100 KB FLP and avoids the bookkeeping required to track
 * byte-offset shifts after variable-length edits. Delta-write becomes
 * worth it only at the multi-MB scale, which is not the v0.1 target.
 */
import { Measurer } from "typed-binary";
import type { FLPProject } from "./flp-project.ts";
import { flpEvent } from "./event.ts";

const FLHD_MAGIC = [0x46, 0x4c, 0x68, 0x64]; // "FLhd"
const FLDT_MAGIC = [0x46, 0x4c, 0x64, 0x74]; // "FLdt"
const FLHD_BODY_BYTES = 6; // uint16 format + uint16 n_channels + uint16 ppq

export function serializeFLPProject(project: FLPProject): Uint8Array {
  const eventsBytes = measureEventsBytes(project);
  const totalBytes = 4 + 4 + FLHD_BODY_BYTES + 4 + 4 + eventsBytes;
  // FLhd magic (4) + FLhd length (4) + FLhd body (6)
  // + FLdt magic (4) + FLdt length (4)
  // + events stream

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);
  let pos = 0;

  // FLhd magic
  for (const b of FLHD_MAGIC) out[pos++] = b;
  // FLhd length (always 6 for the modern body)
  view.setUint32(pos, FLHD_BODY_BYTES, true);
  pos += 4;
  // FLhd body
  view.setUint16(pos, project.header.format, true);
  pos += 2;
  view.setUint16(pos, project.header.n_channels, true);
  pos += 2;
  view.setUint16(pos, project.header.ppq, true);
  pos += 2;

  // FLdt magic
  for (const b of FLDT_MAGIC) out[pos++] = b;
  // FLdt body length
  view.setUint32(pos, eventsBytes, true);
  pos += 4;

  // Event stream — write each event into the output buffer.
  const writer = new ByteSliceOutput(out, pos);
  for (let i = 0; i < project.events.length; i++) {
    const ev = project.events[i]!;
    flpEvent.write(writer, ev);
  }

  if (writer.position !== out.length) {
    throw new Error(
      `serializer wrote ${writer.position} bytes, expected ${out.length} ` +
        `(${eventsBytes} of events + 18 of headers)`,
    );
  }
  return out;
}

/** Sum the on-disk size of every event in the stream via the schema's measure(). */
function measureEventsBytes(project: FLPProject): number {
  const measurer = new Measurer();
  for (const ev of project.events) {
    flpEvent.measure(ev, measurer);
  }
  return measurer.size;
}

/**
 * Minimal ISerialOutput implementation backed by a fixed-size
 * Uint8Array. typed-binary writes one byte / int at a time; this
 * shim writes them little-endian into a pre-sized output buffer.
 */
class ByteSliceOutput {
  position: number;
  private readonly view: DataView;

  constructor(
    private readonly buffer: Uint8Array,
    start: number,
  ) {
    this.position = start;
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  writeUint8(value: number): void {
    this.buffer[this.position++] = value & 0xff;
  }

  writeInt8(value: number): void {
    this.view.setInt8(this.position++, value);
  }

  writeUint16(value: number): void {
    this.view.setUint16(this.position, value, true);
    this.position += 2;
  }

  writeInt16(value: number): void {
    this.view.setInt16(this.position, value, true);
    this.position += 2;
  }

  writeUint32(value: number): void {
    this.view.setUint32(this.position, value, true);
    this.position += 4;
  }

  writeInt32(value: number): void {
    this.view.setInt32(this.position, value, true);
    this.position += 4;
  }

  writeUint64(value: bigint | number): void {
    this.view.setBigUint64(this.position, BigInt(value), true);
    this.position += 8;
  }

  writeInt64(value: bigint | number): void {
    this.view.setBigInt64(this.position, BigInt(value), true);
    this.position += 8;
  }

  writeFloat32(value: number): void {
    this.view.setFloat32(this.position, value, true);
    this.position += 4;
  }

  writeFloat64(value: number): void {
    this.view.setFloat64(this.position, value, true);
    this.position += 8;
  }

  writeBool(value: boolean): void {
    this.writeUint8(value ? 1 : 0);
  }

  writeString(value: string): void {
    // typed-binary's default string writer treats strings as
    // null-terminated UTF-8. We don't use it for FLP (all strings
    // are inside opcode-blob payloads), but keep the method so the
    // ISerialOutput surface is satisfied.
    for (let i = 0; i < value.length; i++) {
      this.writeUint8(value.charCodeAt(i) & 0xff);
    }
    this.writeUint8(0);
  }

  writeByte(value: number): void {
    this.writeUint8(value);
  }

  skipBytes(bytes: number): void {
    this.position += bytes;
  }

  get currentByteOffset(): number {
    return this.position;
  }
}
