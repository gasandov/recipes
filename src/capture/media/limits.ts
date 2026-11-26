/**
 * Bounds for reading text from images. Everything here is a ceiling, not a target: an input over any
 * limit is refused with a message instead of being truncated into a partial or wrong result.
 */
export const mediaLimits = {
  /** Images read per request. Matches the importer's `maxMedia`. */
  maxImages: 4,
  /** Largest file accepted, from a page or from the device. */
  maxImageBytes: 8 * 1024 * 1024,
  /** Largest decoded image. A small file can still decode to a huge bitmap. */
  maxSourcePixels: 40_000_000,
  /** Longest side sent to the engine. Larger images are scaled down; smaller ones are left alone. */
  maxEdgePixels: 2_200,
  /** Time to download one public image. */
  fetchTimeoutMs: 15_000,
  /** Time to start the engine, including the first model download. */
  engineStartTimeoutMs: 90_000,
  /** Time to read one image once the engine is running. */
  recognizeTimeoutMs: 45_000,
  /** Approximate one-time download of the engine and Spanish model, for the consent text. */
  approxDownloadMb: 5,
} as const;

export type MediaLimits = typeof mediaLimits;
