import { mediaLimits } from "./limits";
import type { MediaFailure } from "./messages";

/**
 * Local OCR engine: tesseract.js (Apache-2.0) running in a Web Worker on the device.
 *
 * Nothing about it is bundled. The loader, worker, WebAssembly core and Spanish model are static files served from
 * this app's own origin (`ocr/`, see README.md), fetched only when the user starts a read. They are not part of the
 * service worker precache, so they do not count toward the install size. No tesseract.js default (which points at a
 * public CDN) is ever used: every path below is passed explicitly.
 */

export type OcrInput = Blob | Uint8Array;

export type OcrPage = {
  text: string;
  /** 0 to 1. */
  confidence: number;
};

export type OcrEngine = {
  recognize(image: OcrInput, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<OcrPage>;
  /** Stops the worker and frees its memory. A later `recognize` starts a new one. */
  dispose(): Promise<void>;
};

export class OcrError extends Error {
  readonly failure: MediaFailure;
  constructor(failure: MediaFailure) {
    super(failure);
    this.name = "OcrError";
    this.failure = failure;
  }
}

/** The small part of tesseract.js this app uses. */
type TesseractWorker = {
  recognize(image: OcrInput): Promise<{ data: { text: string; confidence: number } }>;
  terminate(): Promise<unknown>;
};
export type TesseractModule = {
  createWorker(language: string, oem: number, options: Record<string, unknown>): Promise<TesseractWorker>;
};

export type TesseractAssets = {
  /** Absolute URL of the ESM build of tesseract.js. */
  module: string;
  /** Absolute URL of `worker.min.js`. */
  worker: string;
  /** Absolute URL of the directory that holds the `tesseract-core-*-lstm.wasm.js` files. */
  core: string;
  /** Absolute URL of the directory that holds `spa.traineddata.gz`. */
  lang: string;
};

/** Same-origin location of the engine files, relative to the page so a subpath deployment works. */
export function localAssets(base: string | URL): TesseractAssets {
  const root = new URL(base);
  return {
    module: new URL("tesseract.esm.min.js", root).href,
    worker: new URL("worker.min.js", root).href,
    core: new URL("core/", root).href,
    lang: new URL("lang/", root).href,
  };
}

export type TesseractEngineOptions = {
  /** Loads the module. The default imports `assets.module` from the network. Tests inject a local copy. */
  load?: () => Promise<TesseractModule>;
  /** Passed to `createWorker`. Defaults to the same-origin `assets` paths. */
  workerOptions?: Record<string, unknown>;
  language?: string;
  startTimeoutMs?: number;
};

async function importModule(url: string): Promise<TesseractModule> {
  const loaded = (await import(/* @vite-ignore */ url)) as { default?: TesseractModule } & Partial<TesseractModule>;
  const module = loaded.default ?? loaded;
  if (typeof module.createWorker !== "function") throw new Error("The OCR module has no createWorker.");
  return module as TesseractModule;
}

function race<T>(work: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number, onStop: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = (failure: MediaFailure) => {
      cleanup();
      onStop();
      reject(new OcrError(failure));
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const abort = () => stop("aborted");
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort);
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Creates the engine without starting anything. The worker, core and model load on the first `recognize`.
 * Reading cannot be interrupted inside tesseract.js, so a timeout or cancellation terminates the worker.
 */
export function createTesseractEngine(assets: TesseractAssets | undefined, options: TesseractEngineOptions = {}): OcrEngine {
  let worker: Promise<TesseractWorker> | undefined;

  async function stop() {
    const current = worker;
    worker = undefined;
    if (current) await current.then((instance) => instance.terminate()).catch(() => undefined);
  }

  function start(): Promise<TesseractWorker> {
    worker ??= (async () => {
      const module = options.load ? await options.load() : assets ? await importModule(assets.module) : undefined;
      if (!module) throw new OcrError("engine-unavailable");
      return module.createWorker(options.language ?? "spa", 1, {
        ...(assets ? { workerPath: assets.worker, corePath: assets.core, langPath: assets.lang, workerBlobURL: false } : {}),
        gzip: true,
        ...options.workerOptions,
      });
    })();
    return worker;
  }

  return {
    async recognize(image, { signal, timeoutMs = mediaLimits.recognizeTimeoutMs } = {}) {
      let instance: TesseractWorker;
      try {
        instance = await race(start(), signal, options.startTimeoutMs ?? mediaLimits.engineStartTimeoutMs, () => void stop());
      } catch (error) {
        if (error instanceof OcrError) throw error;
        void stop();
        throw new OcrError(typeof WebAssembly === "object" ? "engine-unavailable" : "engine-unsupported");
      }
      const result = await race(instance.recognize(image), signal, timeoutMs, () => void stop()).catch((error: unknown) => {
        if (error instanceof OcrError) throw error;
        void stop();
        throw new OcrError("unreadable");
      });
      return { text: result.data.text, confidence: Math.max(0, Math.min(1, result.data.confidence / 100)) };
    },
    dispose: stop,
  };
}
