import { readFile } from "node:fs/promises";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { App, expect, press, setChecked, test } from "./support/app";
import { gradientPng } from "./support/png";

test("reviews a dictated-text draft and confirms its missing yield before saving", async ({ app, page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "SpeechRecognition", { value: undefined }));
  await app.createIngredient("Sal");
  await app.open("#/recetas/capturar");
  await press(page.locator("summary").filter({ hasText: "Prefiero escribir o pegar el dictado" }));
  await page.getByLabel("Texto de la receta", { exact: true }).fill(
    "Receta: Huevos con sal. Ingredientes: 2 huevos, 1/2 cucharadita de sal. Pasos: Bate los huevos. Agrega la sal.",
  );
  await press(page.getByRole("button", { name: "Crear borrador" }));
  await expect(page.getByRole("heading", { name: "Revisar receta" })).toBeVisible();
  await expect(page.getByLabel("Porciones que rinde")).toHaveValue("4");
  await expect(page.getByRole("combobox", { name: "Ingrediente" }).first()).toHaveValue("Huevo");
  await expect(page.getByLabel("Paso 1", { exact: true })).toHaveValue(/bate los huevos/i);
  await expect(page.getByLabel("Paso 2", { exact: true })).toHaveValue(/agrega la sal/i);
  await press(page.getByRole("button", { name: "Guardar receta" }));
  await expect(page.getByText("Confirma cuántas porciones rinde la receta.").first()).toBeVisible();
  await setChecked(page.getByRole("checkbox", { name: "Confirmo las porciones indicadas" }));
  await press(page.getByRole("button", { name: "Guardar receta" }));
  await expect(page.getByRole("heading", { level: 1, name: "Huevos con sal" })).toBeVisible();
  expect(await app.detailIngredients()).toContain("1/2 cdta Sal");
});

test("creates a draft from the on-device speech recognition result", async ({ app, page }) => {
  await page.addInitScript(() => {
    type ResultEvent = { results: { isFinal: boolean; length: number; 0: { transcript: string } }[] };
    class LocalRecognition {
      static async available(options: { langs: string[]; processLocally: boolean }) {
        return options.processLocally && options.langs[0] === "es-MX" ? "available" : "unavailable";
      }

      lang = "";
      onresult?: (event: ResultEvent) => void;
      onend?: () => void;

      start() {
        if (!("processLocally" in this) || this.processLocally !== true || this.lang !== "es-MX") {
          throw new Error("Expected on-device Mexican Spanish recognition.");
        }
      }

      stop() {
        queueMicrotask(() => {
          const transcript = "Receta de pollo asado para cuatro porciones. Necesitamos de 2 a 3 pechugas de pollo. Asa las pechugas.";
          this.onresult?.({ results: [{ isFinal: true, length: 1, 0: { transcript } }] });
          this.onend?.();
        });
      }
    }
    Object.defineProperty(LocalRecognition.prototype, "processLocally", { value: false, writable: true });
    Object.defineProperty(window, "SpeechRecognition", { value: LocalRecognition, configurable: true });
  });
  await app.goto("#/recetas/capturar");
  await press(page.getByRole("button", { name: "Empezar a dictar" }));
  await expect(page.getByText("Escuchando…", { exact: true })).toBeVisible();
  await press(page.getByRole("button", { name: "Detener y crear borrador" }));
  await expect(page.getByRole("heading", { name: "Revisar receta" })).toBeVisible();
  await expect(page.getByLabel("Porciones que rinde")).toHaveValue("4");
  await expect(page.getByRole("checkbox", { name: "Confirmo las porciones indicadas" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Ingrediente" }).first()).toHaveValue("Pechuga de pollo");
  await expect(page.getByLabel("Cantidad", { exact: true })).toHaveValue(/2.*3/);
  await expect(page.getByLabel("Paso 1", { exact: true })).toHaveValue(/asa las pechugas/i);
});

test("opens a shared social link in import and preserves it for manual entry", async ({ page, app }) => {
  await page.addInitScript(() => Object.defineProperty(window, "SpeechRecognition", { value: undefined }));
  const url = "https://www.instagram.com/reel/ejemplo/";
  await page.goto(`/?recipe-share-url=${encodeURIComponent(url)}`);
  await app.ready();
  await expect(page.getByLabel("Enlace de la receta")).toHaveValue(url);
  expect(new URL(page.url()).search).toBe("");
  await press(page.getByRole("button", { name: "Importar receta" }));
  await press(page.getByRole("button", { name: "Abrir editor con el enlace" }));
  await expect(page.getByRole("heading", { name: "Revisar receta" })).toBeVisible();
  await expect(page.locator("#recipe-source")).toHaveValue(url);
});

test("shows the restored photo when the backup keeps its original ID", async ({ app, page }) => {
  const recipe = "Sopa con foto";
  await app.createRecipe({ name: recipe, photo: true });
  const image = page.getByRole("img", { name: `Foto de ${recipe}` });
  const width = () => image.evaluate((element) => (element as HTMLImageElement).naturalWidth);
  await expect.poll(width).toBe(320);

  await app.open("#/respaldos");
  const downloading = page.waitForEvent("download");
  await press(page.getByRole("button", { name: "Descargar ZIP" }));
  const files = unzipSync(await readFile(await (await downloading).path()));
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));
  // Keep the recipe and photo IDs while changing the stored content.
  Object.assign(manifest.photos[0], { width: 96, height: 64, mimeType: "image/png" });
  files["manifest.json"] = strToU8(JSON.stringify(manifest));
  files["photos/1"] = new Uint8Array(gradientPng(96, 64, 3));

  await page.getByLabel("Archivo de respaldo").setInputFiles({
    name: "foto-restaurada.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zipSync(files)),
  });
  await expect(page.getByRole("heading", { name: "Vista previa" })).toBeVisible();
  await press(page.getByRole("radio", { name: /Reemplazar/i }));
  await press(page.getByRole("button", { name: "Continuar con el reemplazo" }));
  await press(page.getByRole("button", { name: "Reemplazar con el respaldo" }));
  await expect(page.getByText("Se restauró el respaldo.", { exact: true })).toBeVisible();
  await app.openRecipe(recipe);
  await expect.poll(width).toBe(96);
});

test("restores a photo, the active menu and shopping progress to another profile", async ({ app, page, browser, baseURL }) => {
  await app.createRecipe({
    name: "Pollo para la semana", photo: true, lines: [{ ingredient: "Pechuga de pollo", quantity: "500", unit: "g" }],
  });
  await app.addToMenu("Pollo para la semana");
  await app.open("#/compras");
  await press(page.getByRole("button", { name: "Marcar comprado · Pechuga de pollo" }));
  await expect(page.getByText("Compra cubierta", { exact: true })).toBeVisible();
  await app.setPortions("Pollo para la semana", 8);
  await app.open("#/compras");
  await expect(page.getByText("Falta comprar 500 g")).toBeVisible();
  await press(page.getByRole("button", { name: "Agregar artículo manual" }));
  const manual = page.getByRole("dialog", { name: "Agregar artículo manual" });
  await manual.getByLabel("Nombre del artículo").fill("Servilletas");
  await press(manual.getByRole("button", { name: "Guardar artículo" }));
  await expect(page.getByRole("heading", { name: "Servilletas" })).toBeVisible();

  await app.open("#/respaldos");
  const downloading = page.waitForEvent("download");
  await press(page.getByRole("button", { name: "Descargar ZIP" }));
  const downloaded = await downloading;
  const path = await downloaded.path();

  const separateProfile = await browser.newContext({
    baseURL, hasTouch: !!test.info().project.use.hasTouch, acceptDownloads: true,
  });
  try {
    const destination = await separateProfile.newPage();
    const restored = new App(destination);
    await restored.goto("#/respaldos");
    await destination.getByLabel("Archivo de respaldo").setInputFiles(path);
    await expect(destination.getByRole("heading", { name: "Vista previa" })).toBeVisible();
    await press(destination.getByRole("button", { name: "Combinar respaldo" }));
    await expect(destination.getByText("Se restauró el respaldo.", { exact: true })).toBeVisible();
    await restored.open("#/compras");
    await expect(destination.getByText("Falta comprar 500 g")).toBeVisible();
    await expect(destination.getByRole("heading", { name: "Servilletas" })).toBeVisible();
    await restored.openRecipe("Pollo para la semana");
    await expect(destination.getByRole("img", { name: /Pollo para la semana/ })).toBeVisible();

    await restored.open("#/menu");
    await press(destination.getByRole("button", { name: "Vaciar menú", exact: true }));
    await press(destination.getByRole("button", { name: "Sí, vaciar el menú" }));
    await expect(destination.getByRole("heading", { name: "Tu menú está vacío" })).toBeVisible();
    await restored.open("#/compras");
    await expect(destination.getByRole("heading", { name: "Servilletas" })).toBeVisible();
    await expect(destination.getByRole("button", { name: "Restablecer progreso" })).toHaveCount(0);

    await restored.open("#/respaldos");
    await destination.getByLabel("Archivo de respaldo").setInputFiles(path);
    await expect(destination.getByRole("heading", { name: "Vista previa" })).toBeVisible();
    await press(destination.getByRole("radio", { name: /Reemplazar/i }));
    await press(destination.getByRole("button", { name: "Continuar con el reemplazo" }));
    await press(destination.getByRole("button", { name: "Reemplazar con el respaldo" }));
    await expect(destination.getByText("Se restauró el respaldo.", { exact: true })).toBeVisible();
    await restored.open("#/compras");
    await expect(destination.getByText("Falta comprar 500 g")).toBeVisible();
  } finally {
    await separateProfile.close();
  }
});
