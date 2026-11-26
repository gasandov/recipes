import { Inflate, zipSync } from "fflate";
import type { Zippable } from "fflate";
import { BackupError, backupLimits } from "./types";
import { requireBackup } from "./validate";

const endSignature = 0x06054b50;
const centralSignature = 0x02014b50;
const localSignature = 0x04034b50;
const utf8 = new TextDecoder("utf-8", { fatal: true });
export const manifestPath = "manifest.json";
export const photoPath = (index: number): string => `photos/${index + 1}`;

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

type Entry = { path: string; method: number; crc: number; offset: number; end: number; size: number; local: number };

function inspectZip(bytes: Uint8Array): Entry[] {
  if (bytes.length > backupLimits.archiveBytes) throw new BackupError("limit", "The ZIP exceeds the backup size limit.");
  const end = bytes.length - 22;
  requireBackup(end >= 0, "The ZIP is incomplete.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);

  requireBackup(u32(end) === endSignature && u16(end + 4) === 0 && u16(end + 6) === 0 && u16(end + 20) === 0,
    "The ZIP uses an unsupported layout.");
  const count = u16(end + 10);
  const directory = u32(end + 16);
  requireBackup(count > 0 && count === u16(end + 8) && directory + u32(end + 12) === end,
    "Invalid ZIP directory.");
  if (count > backupLimits.photos + 1) throw new BackupError("limit", "The ZIP contains too many files.");

  const entries: Entry[] = [];
  const paths = new Set<string>();
  let totalSize = 0;
  let central = directory;
  for (let index = 0; index < count; index++) {
    requireBackup(central + 46 <= end && u32(central) === centralSignature, "Invalid ZIP directory entry.");
    const flags = u16(central + 8);
    const method = u16(central + 10);
    const crc = u32(central + 16);
    const compressed = u32(central + 20);
    const size = u32(central + 24);
    const nameSize = u16(central + 28);
    const extraSize = u16(central + 30);
    const commentSize = u16(central + 32);
    const disk = u16(central + 34);
    const local = u32(central + 42);
    const nameStart = central + 46;
    central = nameStart + nameSize + extraSize + commentSize;
    requireBackup(central <= end && disk === 0 && (flags & ~0x800) === 0 && (method === 0 || method === 8),
      "The ZIP contains an unsupported entry.");

    const path = utf8.decode(bytes.subarray(nameStart, nameStart + nameSize));
    requireBackup((path === manifestPath || /^photos\/[1-9]\d{0,3}$/u.test(path)) && !paths.has(path),
      "Invalid or duplicate ZIP path.");
    paths.add(path);
    totalSize += size;
    if (size > (path === manifestPath ? backupLimits.manifestBytes : backupLimits.photoBytes)
        || totalSize > backupLimits.expandedBytes) throw new BackupError("limit", "The ZIP expands beyond the backup size limit.");

    requireBackup(local + 30 <= directory && u32(local) === localSignature
      && u16(local + 6) === flags && u16(local + 8) === method && u32(local + 14) === crc
      && u32(local + 18) === compressed && u32(local + 22) === size && u16(local + 26) === nameSize,
    "The ZIP file header disagrees with its directory.");
    const offset = local + 30 + nameSize + u16(local + 28);
    const fileEnd = offset + compressed;
    requireBackup(fileEnd <= directory && (method !== 0 || size === compressed)
      && bytes.subarray(local + 30, local + 30 + nameSize).every((byte, index) => byte === bytes[nameStart + index]),
    "The ZIP contains an invalid file segment.");
    entries.push({ path, method, crc, offset, end: fileEnd, size, local });
  }
  requireBackup(central === end && paths.has(manifestPath), "The ZIP directory is incomplete.");

  let next = 0;
  for (const entry of entries.sort((left, right) => left.local - right.local)) {
    requireBackup(entry.local === next, "The ZIP contains overlapping or unlisted file segments.");
    next = entry.end;
  }
  requireBackup(next === directory, "The ZIP contains unlisted data.");
  return entries;
}

function unzipEntry(archive: Uint8Array, entry: Entry): Uint8Array<ArrayBuffer> {
  if (entry.method === 0) return new Uint8Array(archive.subarray(entry.offset, entry.end));

  const output = new Uint8Array(entry.size);
  let written = 0;
  const inflate = new Inflate((chunk) => {
    requireBackup(written + chunk.length <= output.length, "The ZIP entry expanded beyond its declared size.");
    output.set(chunk, written);
    written += chunk.length;
  });

  // Feed bounded chunks so a falsified expanded size cannot trigger a large temporary allocation.
  const input = archive.subarray(entry.offset, entry.end);
  const chunkSize = 4096;
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    const next = offset + chunkSize;
    inflate.push(input.subarray(offset, next), next >= input.length);
  }
  requireBackup(written === output.length, "The ZIP entry did not expand to its declared size.");
  return output;
}

export function readZip(bytes: Uint8Array): Map<string, Uint8Array<ArrayBuffer>> {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const entry of inspectZip(bytes)) {
    const content = unzipEntry(bytes, entry);
    requireBackup(crc32(content) === entry.crc, "The ZIP file checksum does not match.");
    files.set(entry.path, content);
  }
  return files;
}

export function writeZip(manifest: Uint8Array, photos: ArrayBuffer[]): Uint8Array<ArrayBuffer> {
  if (manifest.length > backupLimits.manifestBytes
      || photos.reduce((size, bytes) => size + bytes.byteLength, manifest.length) > backupLimits.expandedBytes) {
    throw new BackupError("limit", "The backup exceeds the size limit.");
  }
  const files: Zippable = { [manifestPath]: [manifest, { level: 6 }] };
  photos.forEach((bytes, index) => { files[photoPath(index)] = [new Uint8Array(bytes), { level: 0 }]; });
  const zip = zipSync(files);
  if (zip.length > backupLimits.archiveBytes) throw new BackupError("limit", "The ZIP exceeds the backup size limit.");
  return new Uint8Array(zip);
}
