import type { MediaText, MediaTextExtractor, ProviderResult } from "../link/providers";
import { OcrError } from "./engine";
import type { OcrEngine } from "./engine";
import { fetchPublicImage } from "./fetch-image";
import { mediaLimits } from "./limits";
import { mediaMessages } from "./messages";
import type { MediaFailure } from "./messages";
import { prepareImage } from "./prepare-image";
import type { PrepareResult } from "./prepare-image";

/** An image to read: one a public page lists, or a file the user picked on their own device. */
export type MediaInput =
  | { origin: "page"; url: string }
  | { origin: "user-file"; file: Blob };

export type MediaProgress = {
  phase: "downloading" | "preparing" | "reading";
  /** 1-based position of the image being processed. */
  index: number;
  total: number;
};

export type ReadMediaResult =
  | {
      status: "ok";
      text: string;
      /** Mean confidence of the images that produced text, from 0 to 1. */
      confidence: number;
      read: number;
      /** Images that could not be read, in input order. */
      skipped: MediaFailure[];
    }
  | { status: "failed"; failure: MediaFailure; message: string };

export type ReadMediaDeps = {
  engine: OcrEngine;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: MediaProgress) => void;
  /** Replaceable so tests can run without a browser. */
  prepare?: (blob: Blob) => Promise<PrepareResult>;
};

const failed = (failure: MediaFailure): ReadMediaResult => ({ status: "failed", failure, message: mediaMessages[failure] });

/** Removes engine noise without changing wording: control characters, stray symbols and runs of blank lines. */
export function cleanOcrText(raw: string): string {
  const lines = raw
    .normalize("NFC")
    .split(/\r?\n/)
    // Control characters become spaces; invisible format characters (zero-width, BOM) disappear.
    .map((line) => line.replace(/\p{Cc}/gu, " ").replace(/\p{Cf}/gu, "").replace(/[ \t]+/g, " ").trim())
    // A line with fewer than two letters or digits is almost always a border, icon or smudge.
    .filter((line) => line === "" || (line.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 2);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const hasContent = (text: string) => (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 12;

async function acquire(input: MediaInput, deps: ReadMediaDeps): Promise<{ ok: true; blob: Blob } | { ok: false; failure: MediaFailure }> {
  if (input.origin === "user-file") return { ok: true, blob: input.file };
  return fetchPublicImage(input.url, { fetch: deps.fetch, signal: deps.signal });
}

/**
 * Reads text from up to `maxImages` images, one at a time, entirely on the device. Page images are fetched
 * straight from their host; the app never relays them. Image bytes exist only in memory during this call.
 */
export async function readMediaText(inputs: readonly MediaInput[], deps: ReadMediaDeps): Promise<ReadMediaResult> {
  const queue = inputs.slice(0, mediaLimits.maxImages);
  if (queue.length === 0) return failed("unreadable");
  const prepare = deps.prepare ?? prepareImage;

  const texts: string[] = [];
  const confidences: number[] = [];
  const skipped: MediaFailure[] = [];

  for (const [position, input] of queue.entries()) {
    if (deps.signal?.aborted) return failed("aborted");
    const progress = (phase: MediaProgress["phase"]) => deps.onProgress?.({ phase, index: position + 1, total: queue.length });

    if (input.origin === "page") progress("downloading");
    const acquired = await acquire(input, deps);
    if (!acquired.ok) {
      if (acquired.failure === "aborted") return failed("aborted");
      skipped.push(acquired.failure);
      continue;
    }

    progress("preparing");
    const prepared = await prepare(acquired.blob);
    if (!prepared.ok) {
      skipped.push(prepared.failure);
      continue;
    }

    progress("reading");
    try {
      const page = await deps.engine.recognize(prepared.blob, { signal: deps.signal });
      const text = cleanOcrText(page.text);
      if (hasContent(text)) {
        texts.push(text);
        confidences.push(page.confidence);
      } else {
        skipped.push("no-text");
      }
    } catch (error) {
      const failure = error instanceof OcrError ? error.failure : "unreadable";
      // The engine cannot start or the user cancelled: later images would fail the same way.
      if (failure === "aborted" || failure === "engine-unavailable" || failure === "engine-unsupported") return failed(failure);
      skipped.push(failure);
    }
  }

  if (texts.length === 0) return failed(skipped.find((failure) => failure !== "no-text") ?? "no-text");
  return {
    status: "ok",
    text: texts.join("\n\n"),
    confidence: confidences.reduce((sum, value) => sum + value, 0) / confidences.length,
    read: texts.length,
    skipped,
  };
}

/** Adapts local OCR to the `MediaTextExtractor` contract used by `link/providers`. Videos and audio are unsupported. */
export function createOcrExtractor(engine: OcrEngine, fetcher?: typeof fetch): MediaTextExtractor {
  return {
    capability: "ocr",
    availability: { status: "available" },
    async extract(media, { signal }): Promise<ProviderResult<MediaText>> {
      if (media.kind !== "image") return { status: "unsupported", reason: "Solo se leen imágenes; los videos no se procesan." };
      let blob: Blob;
      if (media.origin === "user-file") {
        // The URL is an object URL the user's own file produced; it never leaves the device.
        if (!media.url.startsWith("blob:")) return { status: "unsupported", reason: mediaMessages["blocked-source"] };
        blob = await (await (fetcher ?? fetch)(media.url)).blob();
      } else {
        const result = await fetchPublicImage(media.url, { fetch: fetcher, signal });
        if (!result.ok) return { status: result.failure === "timeout" ? "failed" : "inaccessible", reason: mediaMessages[result.failure] };
        blob = result.blob;
      }
      const outcome = await readMediaText([{ origin: "user-file", file: blob }], { engine, signal });
      if (outcome.status === "failed") return { status: "failed", reason: outcome.message };
      return { status: "ok", value: { text: outcome.text, language: "es", confidence: outcome.confidence } };
    },
  };
}
