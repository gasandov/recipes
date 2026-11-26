import { decodeBackupPhotos } from "./photo";
import { BackupError, backupLimits } from "./types";
import type { PersonalSnapshot } from "./types";
import { list, object, requireBackup, validateSnapshot } from "./validate";
import { manifestPath, photoPath, readZip, writeZip } from "./zip";

export const backupFormat = "recetario-personal";
export const backupVersion = 1;

/** Serializes a snapshot as a versioned ZIP with a JSON manifest and binary photos. */
export function encodeBackup(value: PersonalSnapshot): Uint8Array<ArrayBuffer> {
  const snapshot = validateSnapshot(value);
  const photos = snapshot.photos.map(({ bytes: _bytes, ...photo }) => photo);
  const manifest = new TextEncoder().encode(JSON.stringify({
    format: backupFormat, version: backupVersion, ...snapshot, photos,
  }));
  return writeZip(manifest, snapshot.photos.map(({ bytes }) => bytes));
}

/** Validates an untrusted ZIP without opening IndexedDB. */
export async function readBackup(input: Blob | Uint8Array): Promise<PersonalSnapshot> {
  try {
    const size = input instanceof Uint8Array ? input.byteLength : input.size;
    if (size > backupLimits.archiveBytes) throw new BackupError("limit", "The ZIP exceeds the backup size limit.");
    const files = readZip(input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer()));
    const manifest = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(files.get(manifestPath))));
    requireBackup(manifest.format === backupFormat, "This ZIP is not a Recetario backup.");
    if (manifest.version !== backupVersion) throw new BackupError("version", "Unsupported backup version.");

    const photos = list(manifest.photos, backupLimits.photos).map((metadata, index) => {
      const file = files.get(photoPath(index));
      requireBackup(file, "A photo file is missing from the ZIP.");
      return { ...object(metadata), bytes: file.buffer };
    });
    requireBackup(files.size === photos.length + 1, "The ZIP contains unexpected photo files.");
    const snapshot = validateSnapshot({ ...manifest, photos });
    await decodeBackupPhotos(snapshot.photos);
    return snapshot;
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("invalid", "The backup archive could not be read.");
  }
}
