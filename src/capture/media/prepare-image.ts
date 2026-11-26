import { mediaLimits } from "./limits";
import type { MediaFailure } from "./messages";

export type PrepareResult = { ok: true; blob: Blob; width: number; height: number } | { ok: false; failure: MediaFailure };

/** Dimensions after scaling the longest side down to `maxEdge`. Never scales up. */
export function scaledSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const acceptedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);

/**
 * Decodes an image on the device, applies its EXIF rotation, flattens transparency onto white and scales it
 * down. The result is a PNG Blob in memory; the decoded bitmap is closed immediately.
 */
export async function prepareImage(source: Blob, maxEdge: number = mediaLimits.maxEdgePixels): Promise<PrepareResult> {
  if (source.size > mediaLimits.maxImageBytes) return { ok: false, failure: "too-large" };
  // Files from a picker sometimes have no type. Let decoding decide in that case.
  if (source.type && !acceptedTypes.has(source.type.toLowerCase())) return { ok: false, failure: "not-image" };
  if (typeof createImageBitmap !== "function") return { ok: false, failure: "engine-unsupported" };

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
  } catch {
    return { ok: false, failure: "unreadable" };
  }

  try {
    if (bitmap.width * bitmap.height > mediaLimits.maxSourcePixels) return { ok: false, failure: "too-many-pixels" };
    const { width, height } = scaledSize(bitmap.width, bitmap.height, maxEdge);

    let blob: Blob | null;
    if (typeof OffscreenCanvas === "function") {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) return { ok: false, failure: "unreadable" };
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      blob = await canvas.convertToBlob({ type: "image/png" });
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return { ok: false, failure: "unreadable" };
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    }
    return blob ? { ok: true, blob, width, height } : { ok: false, failure: "unreadable" };
  } catch {
    return { ok: false, failure: "unreadable" };
  } finally {
    bitmap.close();
  }
}
