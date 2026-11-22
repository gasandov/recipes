import type { PhotoInput } from "../contracts";

export const acceptedPhotoTypes = "image/jpeg,image/png,image/webp";
const supportedTypes = new Set(acceptedPhotoTypes.split(","));
const maxInputBytes = 30 * 1024 * 1024;
const maxDimension = 1600;
const outputQuality = 0.85;

export class PhotoError extends Error {
  readonly userMessage: string;

  constructor(userMessage: string, cause?: unknown) {
    super(userMessage, { cause });
    this.userMessage = userMessage;
  }
}

type Decoded = { source: CanvasImageSource; width: number; height: number; release: () => void };

async function decode(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Fall back to an image element below.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw new PhotoError("No pudimos leer esa imagen. Prueba con otra foto en formato JPG, PNG o WebP.", error);
  }
}

function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, outputQuality));
}

/** Validates a chosen file and returns a locally resized copy ready to store. */
export async function prepareLocalPhoto(file: File): Promise<PhotoInput> {
  if (!supportedTypes.has(file.type)) {
    throw new PhotoError("Ese tipo de archivo no es compatible. Elige una foto JPG, PNG o WebP.");
  }
  if (file.size === 0) throw new PhotoError("El archivo está vacío. Elige otra foto.");
  if (file.size > maxInputBytes) throw new PhotoError("La foto pesa demasiado. Elige una de menos de 30 MB.");

  const decoded = await decode(file);
  try {
    if (!decoded.width || !decoded.height) {
      throw new PhotoError("No pudimos leer esa imagen. Prueba con otra foto.");
    }
    const scale = Math.min(1, maxDimension / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new PhotoError("Tu navegador no pudo procesar la foto.");
    // JPEG has no transparency, so transparent areas get the page's cream background.
    context.fillStyle = "#f7f4ed";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingQuality = "high";
    context.drawImage(decoded.source, 0, 0, width, height);

    // Prefer WebP when the browser can encode it; Safari answers with PNG, so fall back to JPEG.
    let blob = await encode(canvas, "image/webp");
    if (!blob || blob.type !== "image/webp") blob = await encode(canvas, "image/jpeg");
    if (!blob || !blob.size) throw new PhotoError("Tu navegador no pudo reducir la foto.");
    return { blob, width, height };
  } finally {
    decoded.release();
  }
}
