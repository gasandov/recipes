// Copies the local OCR engine files into a static folder served by the app (default `public/ocr`).
//
// Usage: node src/capture/media/copy-assets.mjs [--from <node_modules dir>] [--to <dir>]
//
// Needs `tesseract.js`, `tesseract.js-core` and `@tesseract.js-data/spa` installed. Only the LSTM WebAssembly
// variants are copied (the app never uses the legacy engine). Nothing here is part of the service worker
// precache: vite only precaches what the bundle emits, and `appShell` lists public files explicitly.
import { createHash } from "node:crypto";
import console from "node:console";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const modules = resolve(option("--from", "node_modules"));
const target = resolve(option("--to", "public/ocr"));

const files = [
  ["tesseract.js/dist/tesseract.esm.min.js", "tesseract.esm.min.js"],
  ["tesseract.js/dist/worker.min.js", "worker.min.js"],
  ["tesseract.js-core/tesseract-core-lstm.wasm.js", "core/tesseract-core-lstm.wasm.js"],
  ["tesseract.js-core/tesseract-core-simd-lstm.wasm.js", "core/tesseract-core-simd-lstm.wasm.js"],
  ["tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js", "core/tesseract-core-relaxedsimd-lstm.wasm.js"],
  ["@tesseract.js-data/spa/4.0.0_best_int/spa.traineddata.gz", "lang/spa.traineddata.gz"],
  ["tesseract.js/LICENSE.md", "LICENSE-tesseract.js.md"],
  ["tesseract.js-core/LICENSE", "LICENSE-tesseract.js-core.txt"],
];

// npm may nest the core package under tesseract.js when versions differ.
async function locate(from) {
  const direct = join(modules, from);
  if (await stat(direct).then(() => true, () => false)) return direct;
  if (from.startsWith("tesseract.js-core/")) {
    const nested = join(modules, "tesseract.js/node_modules", from);
    if (await stat(nested).then(() => true, () => false)) return nested;
  }
  throw new Error(`Missing ${from}. Run npm ci first (looked in ${modules}).`);
}

const manifest = [];
let total = 0;
for (const [from, to] of files) {
  const source = await locate(from);
  const destination = join(target, to);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const { size } = await stat(destination);
  total += size;
  manifest.push({ file: to, bytes: size, sha256: createHash("sha256").update(await readFile(destination)).digest("hex") });
}
await writeFile(join(target, "manifest.json"), `${JSON.stringify({ files: manifest }, null, 2)}\n`);
console.log(`Copied ${files.length} files (${(total / 1024 / 1024).toFixed(1)} MB on disk) to ${target}`);
