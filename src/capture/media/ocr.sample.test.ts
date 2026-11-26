import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createTesseractEngine } from "./engine";
import type { TesseractModule } from "./engine";
import { draftFromMediaText } from "./draft";
import { cleanOcrText } from "./service";

/**
 * Verifies the OCR engine on its own, with a synthetic image whose text is known (fixtures/recipe-es.png), using the
 * real tesseract.js and the same Spanish model package the app copies to `ocr/lang`. Both are devDependencies, so this
 * runs after a plain `npm ci`. `RECETARIO_OCR_MODULES` points to another node_modules folder (default: ./node_modules).
 * It is skipped only when those packages are missing, and the skip says so on the console.
 */
const modules = resolve(process.env.RECETARIO_OCR_MODULES ?? "node_modules");
const entry = join(modules, "tesseract.js", "src", "index.js");
const langDir = join(modules, "@tesseract.js-data", "spa", "4.0.0_best_int");
const ready = existsSync(entry) && existsSync(join(langDir, "spa.traineddata.gz"));

const fixtures = new URL("./fixtures/", import.meta.url);
const expected = JSON.parse(readFileSync(new URL("recipe-es.expected.json", fixtures), "utf8")) as {
  lines: string[];
  ingredients: string[];
  steps: number;
};
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

const engine = createTesseractEngine(undefined, {
  load: async () => ((await import(pathToFileURL(entry).href)) as { default: TesseractModule }).default,
  workerOptions: { langPath: langDir, cacheMethod: "none", gzip: true },
});
afterAll(() => engine.dispose());

describe.skipIf(!ready)("local OCR on a synthetic recipe image", () => {
  it("reads every known line", async () => {
    const image = readFileSync(new URL("recipe-es.png", fixtures));
    const page = await engine.recognize(new Uint8Array(image));
    const text = cleanOcrText(page.text);
    const lines = text.split("\n").map(fold);
    const wanted = expected.lines.filter((line) => line !== "");
    const missing = wanted.filter((line) => !lines.some((found) => found === fold(line)));
    expect(missing, `Read:\n${text}`).toEqual([]);
    expect(page.confidence).toBeGreaterThan(0.8);
  }, 60_000);

  it("turns the reading into a draft with the known ingredients and steps, and keeps amounts pending-safe", async () => {
    const image = readFileSync(new URL("recipe-es.png", fixtures));
    const page = await engine.recognize(new Uint8Array(image));
    const { draft, usable } = draftFromMediaText(cleanOcrText(page.text), "https://ejemplo.mx/receta", page.confidence);
    expect(usable).toBe(true);
    expect(draft.ingredients.map((item) => fold(item.name))).toEqual(expected.ingredients.map(fold));
    expect(draft.steps).toHaveLength(expected.steps);
    expect(draft.ingredients[0]?.amount).toMatchObject({ kind: "measured", unit: "gram" });
    expect(draft.ingredients[3]?.amount.kind).not.toBe("measured");
    expect(draft.sourceUrl).toBe("https://ejemplo.mx/receta");
  }, 60_000);

  it("finds no text in a blank image instead of inventing a recipe", async () => {
    const { deflateSync } = await import("node:zlib");
    const width = 300;
    const height = 120;
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 255)]);
    const raw = Buffer.concat(Array.from({ length: height }, () => row));
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    const crc = (bytes: Buffer) => {
      let c = 0xffffffff;
      for (const byte of bytes) {
        c ^= byte;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, data: Buffer) => {
      const body = Buffer.concat([Buffer.from(type), data]);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      const sum = Buffer.alloc(4);
      sum.writeUInt32BE(crc(body));
      return Buffer.concat([length, body, sum]);
    };
    const blank = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
    ]);
    const page = await engine.recognize(new Uint8Array(blank));
    expect(cleanOcrText(page.text)).toBe("");
  }, 60_000);

  it("stops reading on timeout and recovers with a fresh worker", async () => {
    const image = new Uint8Array(readFileSync(new URL("recipe-es.png", fixtures)));
    await expect(engine.recognize(image, { timeoutMs: 1 })).rejects.toMatchObject({ failure: "timeout" });
    const page = await engine.recognize(image);
    expect(cleanOcrText(page.text)).toContain("Ingredientes");
  }, 90_000);
});

if (!ready) {
  // Vitest reports the suite as skipped; this line says what to run to enable it.
  console.warn(`OCR sample test skipped: need ${entry} and ${langDir}. Run npm ci.`);
}
