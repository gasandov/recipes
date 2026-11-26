import { fileURLToPath } from "node:url";
import { expect, press, test } from "./support/app";

const fixture = fileURLToPath(new URL("../src/capture/media/fixtures/recipe-es.png", import.meta.url));
const clip = fileURLToPath(new URL("../src/capture/media/fixtures/recipe-es.mp4", import.meta.url));
test.beforeEach(async ({ page }) => {
  // The browser runner has no microphone. Exercise the supported no-recognition path of the voice panel.
  await page.addInitScript(() => Object.defineProperty(window, "SpeechRecognition", { value: undefined }));
});

test("reads a synthetic recipe image on the device and never contacts a third party", async ({ app, page, baseURL }) => {
  test.setTimeout(150_000);
  const origin = new URL(baseURL ?? "http://127.0.0.1:4317").origin;
  const seen: string[] = [];
  const engineRequests: Array<ReturnType<typeof page.waitForRequest> extends Promise<infer R> ? R : never> = [];
  page.on("request", (request) => {
    seen.push(request.url());
    if (request.url().includes("/ocr/")) engineRequests.push(request);
  });

  await app.open("#/recetas/capturar");
  await expect(page.getByRole("heading", { name: "Leer texto de una imagen" })).toBeVisible();
  // Nothing about the engine is requested before the user picks an image.
  expect(seen.filter((url) => url.includes("/ocr/"))).toEqual([]);

  await page.getByLabel("Elegir captura o imagen").setInputFiles(fixture);
  await expect(page.getByRole("heading", { name: "Revisar receta" })).toBeVisible({ timeout: 120_000 });

  await expect(page.getByLabel("Paso 1", { exact: true })).toHaveValue(/cuece el pollo/i);
  await expect(page.getByLabel("Paso 2", { exact: true })).toHaveValue(/dora la cebolla/i);
  await expect(page.getByText(/reconocimiento automático/).first()).toBeVisible();
  expect(await page.getByRole("combobox", { name: "Ingrediente" }).count()).toBe(4);

  // Every request stayed on this origin, so no image, model or text left the device.
  const foreign = seen.filter((url) => !url.startsWith(origin) && !url.startsWith("data:") && !url.startsWith("blob:"));
  expect(foreign).toEqual([]);
  expect(seen.some((url) => url.endsWith("/ocr/lang/spa.traineddata.gz"))).toBe(true);

  let transferred = 0;
  for (const request of engineRequests) {
    const sizes = await request.sizes().catch(() => undefined);
    transferred += sizes?.responseBodySize ?? 0;
  }
  console.log(`OCR engine bytes transferred (${test.info().project.name}): ${(transferred / 1024 / 1024).toFixed(2)} MB over ${engineRequests.length} requests`);
  await press(page.getByRole("button", { name: "Guardar receta" }));
  await expect(page.getByText("Confirma cuántas porciones rinde la receta.").first()).toBeVisible();
});

test("reads text from a short video without sending its audio or duplicating persistent captions", async ({ app, page }) => {
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") sent.push(request.url());
  });
  await app.open("#/recetas/capturar");
  await press(page.locator("summary").filter({ hasText: "Leer una receta de un video corto" }));
  await page.getByLabel("Elegir video de la receta").setInputFiles(clip);
  await press(page.getByRole("button", { name: "Leer texto del video", exact: true }));
  await expect(page.getByText("Ya leímos el texto del video.")).toBeVisible({ timeout: 30_000 });
  await press(page.getByRole("button", { name: "Revisar borrador del video" }));
  await expect(page.getByRole("heading", { name: "Revisar receta" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Ingrediente" })).toHaveCount(4);
  await expect(page.getByLabel("Paso 1", { exact: true })).toHaveValue(/cuece el pollo/i);
  await expect(page.getByLabel("Paso 2", { exact: true })).toHaveValue(/dora la cebolla/i);
  expect(sent).toEqual([]);
});
