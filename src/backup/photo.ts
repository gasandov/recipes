import type { StoredPhoto } from "../data/database";
import { BackupError, backupLimits } from "./types";

const letters = (bytes: Uint8Array, offset: number, text: string) =>
  [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0));

function imageDimensions(bytes: Uint8Array, mimeType: string): [number, number] | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (mimeType === "image/png" && bytes.length >= 45
      && bytes[0] === 137 && letters(bytes, 1, "PNG\r\n\x1a\n")
      && view.getUint32(8) === 13 && letters(bytes, 12, "IHDR")
      && view.getUint32(bytes.length - 12) === 0 && letters(bytes, bytes.length - 8, "IEND")) {
    return [view.getUint32(16), view.getUint32(20)];
  }

  if (mimeType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8
      && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    for (let offset = 2; offset + 4 < bytes.length;) {
      if (bytes[offset++] !== 0xff) return;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length || marker === 0xda) return;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8) {
        return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
      }
      offset += length;
    }
  }

  if (mimeType === "image/webp" && bytes.length >= 25 && letters(bytes, 0, "RIFF")
      && letters(bytes, 8, "WEBP") && view.getUint32(4, true) + 8 === bytes.length) {
    const length = view.getUint32(16, true);
    if (20 + length > bytes.length) return;
    if (letters(bytes, 12, "VP8X") && length === 10) {
      return [(view.getUint32(24, true) & 0xffffff) + 1,
        (view.getUint32(26, true) >>> 8) + 1];
    }
    if (letters(bytes, 12, "VP8L") && length >= 5 && bytes[20] === 0x2f) {
      const header = view.getUint32(21, true);
      return [(header & 0x3fff) + 1, ((header >>> 14) & 0x3fff) + 1];
    }
    if (letters(bytes, 12, "VP8 ") && length >= 10
        && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
    }
  }
}

export function validatePhotoData(photo: StoredPhoto): void {
  if (photo.bytes.byteLength > backupLimits.photoBytes
      || photo.width > backupLimits.photoDimension || photo.height > backupLimits.photoDimension) {
    throw new BackupError("limit", "A photo exceeds the backup size or dimension limits.");
  }

  const dimensions = imageDimensions(new Uint8Array(photo.bytes), photo.mimeType);
  if (!dimensions || dimensions[0] !== photo.width || dimensions[1] !== photo.height) {
    throw new BackupError("invalid", "A photo's bytes, format, and declared dimensions do not match.");
  }
}

/** Browser imports also check that the image decoder can read the complete file. */
export async function decodeBackupPhotos(photos: readonly StoredPhoto[]): Promise<void> {
  if (typeof Image === "undefined") return;
  for (const photo of photos) {
    const url = URL.createObjectURL(new Blob([photo.bytes], { type: photo.mimeType }));
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (image.naturalWidth !== photo.width || image.naturalHeight !== photo.height) {
        throw new Error("Decoded dimensions do not match the saved photo.");
      }
    } catch {
      throw new BackupError("invalid", "A photo could not be decoded.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
