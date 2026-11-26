import { createTesseractEngine, localAssets } from "./engine";
import type { OcrEngine } from "./engine";

/**
 * Same-origin folder with the engine files. `VITE_OCR_ASSET_BASE` may relocate it, but only within this origin:
 * a value that points elsewhere is ignored so the model can never come from a third party by configuration mistake.
 */
export function resolveAssetBase(configured: unknown, documentBase: string): URL {
  const fallback = new URL("ocr/", documentBase);
  if (typeof configured !== "string" || !configured.trim()) return fallback;
  try {
    const url = new URL(configured.trim().replace(/\/?$/, "/"), documentBase);
    return url.origin === fallback.origin ? url : fallback;
  } catch {
    return fallback;
  }
}

/** The production engine. Creating it is free: nothing downloads until the first image is read. */
export function defaultOcrEngine(): OcrEngine {
  const base = resolveAssetBase(import.meta.env.VITE_OCR_ASSET_BASE, document.baseURI);
  return createTesseractEngine(localAssets(base));
}
