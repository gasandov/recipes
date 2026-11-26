import { describe, expect, it, vi } from "vitest";
import { createTesseractEngine, OcrError } from "./engine";
import type { OcrEngine, TesseractModule } from "./engine";
import { cleanOcrText, createOcrExtractor, readMediaText } from "./service";
import type { MediaProgress } from "./service";
import { scaledSize } from "./prepare-image";
import { draftFromMediaText } from "./draft";
import { resolveAssetBase } from "./default-engine";

const png = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
const prepare = async (blob: Blob) => ({ ok: true as const, blob, width: 10, height: 10 });
const recipeText = "Ingredientes\n500 g de pechuga de pollo\n2 tazas de arroz\nPreparación\n1. Cuece el pollo.";
const engineReturning = (...texts: Array<string | Error>): OcrEngine => {
  const queue = [...texts];
  return {
    recognize: vi.fn(async () => {
      const next = queue.shift() ?? "";
      if (next instanceof Error) throw next;
      return { text: next, confidence: 0.9 };
    }),
    dispose: vi.fn(async () => undefined),
  };
};

describe("cleanOcrText", () => {
  it("drops noise lines and control characters but keeps wording", () => {
    expect(cleanOcrText("Ingredientes​\n|\n—\n2 tazas   de arroz\n\n\n\nSal ~")).toBe("Ingredientes\n2 tazas de arroz\n\nSal ~");
  });
});

describe("scaledSize", () => {
  it("scales the longest side down and never up", () => {
    expect(scaledSize(4400, 2200, 2200)).toEqual({ width: 2200, height: 1100 });
    expect(scaledSize(800, 600, 2200)).toEqual({ width: 800, height: 600 });
  });
});

describe("readMediaText", () => {
  it("reads a user file locally and reports progress, without any fetch", async () => {
    const engine = engineReturning(recipeText);
    const send = vi.fn();
    const events: MediaProgress[] = [];
    const result = await readMediaText([{ origin: "user-file", file: png() }], {
      engine, prepare, fetch: send as unknown as typeof fetch, onProgress: (event) => events.push(event),
    });
    expect(result).toMatchObject({ status: "ok", read: 1, confidence: 0.9 });
    expect(send).not.toHaveBeenCalled();
    expect(events.map((event) => event.phase)).toEqual(["preparing", "reading"]);
  });

  it("reads at most four images, one at a time", async () => {
    const engine = engineReturning(...Array.from({ length: 6 }, (_, i) => `${recipeText}\nPaso ${i}`));
    const inputs = Array.from({ length: 6 }, () => ({ origin: "user-file" as const, file: png() }));
    const result = await readMediaText(inputs, { engine, prepare });
    expect(engine.recognize).toHaveBeenCalledTimes(4);
    expect(result.status === "ok" && result.read).toBe(4);
  });

  it("keeps the images that worked and reports the ones that did not", async () => {
    const engine = engineReturning(recipeText);
    const send = vi.fn(async () => { throw new TypeError("blocked by CORS"); });
    const result = await readMediaText(
      [{ origin: "page", url: "https://cdn.recetas.example/a.jpg" }, { origin: "user-file", file: png() }],
      { engine, prepare, fetch: send as unknown as typeof fetch },
    );
    expect(result).toMatchObject({ status: "ok", read: 1, skipped: ["cors-or-network"] });
  });

  it("fails with the first real reason when nothing could be read", async () => {
    const send = vi.fn(async () => { throw new TypeError("blocked by CORS"); });
    const result = await readMediaText([{ origin: "page", url: "https://cdn.recetas.example/a.jpg" }], {
      engine: engineReturning(), prepare, fetch: send as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ status: "failed", failure: "cors-or-network" });
    expect(result.status === "failed" && result.message).toContain("No se evita esa protección");
  });

  it("reports an image with no readable text", async () => {
    const result = await readMediaText([{ origin: "user-file", file: png() }], { engine: engineReturning("  ~ \n|"), prepare });
    expect(result).toMatchObject({ status: "failed", failure: "no-text" });
  });

  it("stops everything when the engine cannot start or the user cancels", async () => {
    const engine = engineReturning(new OcrError("engine-unavailable"));
    const inputs = [{ origin: "user-file" as const, file: png() }, { origin: "user-file" as const, file: png() }];
    expect(await readMediaText(inputs, { engine, prepare })).toMatchObject({ status: "failed", failure: "engine-unavailable" });
    expect(engine.recognize).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    controller.abort();
    expect(await readMediaText(inputs, { engine: engineReturning(recipeText), prepare, signal: controller.signal })).toMatchObject({
      status: "failed", failure: "aborted",
    });
  });
});

describe("createTesseractEngine", () => {
  function fakeModule(behaviour: "ok" | "hang" | "reject-start") {
    const terminate = vi.fn(async () => undefined);
    const createWorker = vi.fn(async () => {
      if (behaviour === "reject-start") throw new Error("404");
      return { terminate, recognize: () => (behaviour === "hang" ? new Promise<never>(() => undefined) : Promise.resolve({ data: { text: "hola", confidence: 91 } })) };
    });
    return { module: { createWorker } as unknown as TesseractModule, createWorker, terminate };
  }
  const assets = { module: "https://app.example/ocr/t.js", worker: "https://app.example/ocr/worker.min.js", core: "https://app.example/ocr/core/", lang: "https://app.example/ocr/lang/" };

  it("starts lazily with only same-origin paths", async () => {
    const { module, createWorker } = fakeModule("ok");
    const engine = createTesseractEngine(assets, { load: async () => module });
    expect(createWorker).not.toHaveBeenCalled();
    expect(await engine.recognize(new Blob(["x"]))).toEqual({ text: "hola", confidence: 0.91 });
    const [language, oem, options] = createWorker.mock.calls[0] as unknown as [string, number, Record<string, unknown>];
    expect([language, oem]).toEqual(["spa", 1]);
    expect(options).toMatchObject({ workerPath: assets.worker, corePath: assets.core, langPath: assets.lang, gzip: true, workerBlobURL: false });
    for (const path of [options.workerPath, options.corePath, options.langPath] as string[]) expect(new URL(path).origin).toBe("https://app.example");
  });

  it("terminates the worker on timeout and starts a fresh one next time", async () => {
    const { module, createWorker, terminate } = fakeModule("hang");
    const engine = createTesseractEngine(assets, { load: async () => module });
    await expect(engine.recognize(new Blob(["x"]), { timeoutMs: 20 })).rejects.toMatchObject({ failure: "timeout" });
    expect(terminate).toHaveBeenCalledTimes(1);
    await expect(engine.recognize(new Blob(["x"]), { timeoutMs: 20 })).rejects.toMatchObject({ failure: "timeout" });
    expect(createWorker).toHaveBeenCalledTimes(2);
  });

  it("terminates the worker when cancelled", async () => {
    const { module, terminate } = fakeModule("hang");
    const engine = createTesseractEngine(assets, { load: async () => module });
    const controller = new AbortController();
    const pending = engine.recognize(new Blob(["x"]), { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ failure: "aborted" });
    expect(terminate).toHaveBeenCalled();
  });

  it("maps a missing asset to engine-unavailable", async () => {
    const { module } = fakeModule("reject-start");
    const engine = createTesseractEngine(assets, { load: async () => module });
    await expect(engine.recognize(new Blob(["x"]))).rejects.toMatchObject({ failure: "engine-unavailable" });
  });
});

describe("createOcrExtractor", () => {
  it("declares video unsupported and never fetches it", async () => {
    const send = vi.fn();
    const extractor = createOcrExtractor(engineReturning(), send as unknown as typeof fetch);
    expect(extractor.availability.status).toBe("available");
    const result = await extractor.extract({ kind: "video", url: "https://cdn.recetas.example/v.mp4", origin: "page-structured-data" }, {});
    expect(result.status).toBe("unsupported");
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a user-file address that is not a local object URL", async () => {
    const extractor = createOcrExtractor(engineReturning());
    expect(await extractor.extract({ kind: "image", url: "https://evil.example/x.png", origin: "user-file" }, {})).toMatchObject({ status: "unsupported" });
  });
});

describe("resolveAssetBase", () => {
  it("defaults next to the page and ignores other origins", () => {
    expect(resolveAssetBase(undefined, "https://app.example/recetario/").href).toBe("https://app.example/recetario/ocr/");
    expect(resolveAssetBase("/modelos", "https://app.example/").href).toBe("https://app.example/modelos/");
    expect(resolveAssetBase("https://cdn.example/ocr/", "https://app.example/").href).toBe("https://app.example/ocr/");
  });
});

describe("draftFromMediaText", () => {
  it("builds a reviewable draft that labels the OCR origin and keeps the link", () => {
    const { draft, usable } = draftFromMediaText(recipeText, "https://www.instagram.com/reel/x/", 0.6);
    expect(usable).toBe(true);
    expect(draft.sourceUrl).toBe("https://www.instagram.com/reel/x/");
    expect(draft.ingredients.map((item) => item.name)).toEqual(["pechuga de pollo", "arroz"]);
    expect(draft.steps).toHaveLength(1);
    expect(draft.notices?.[0]).toContain("reconocimiento automático");
    expect(draft.notices?.join(" ")).toContain("poca seguridad");
  });

  it("is not usable without headings, rather than guessing", () => {
    expect(draftFromMediaText("Pollo deliciosísimo para toda la familia", undefined).usable).toBe(false);
  });
});
