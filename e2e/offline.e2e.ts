import { expect, press, sourceHost, sourceOrigin, sourcePageTitle, test } from "./support/app";

test.describe("offline use after the first load", () => {
  test("the shell reopens offline and recipes can be created, edited and read", async ({ app, page, context }) => {
    await app.goto("#/recetas");
    await app.waitForServiceWorkerControl();
    // One versioned cache holds the shell. Anything else would mean a leaked cache from another version.
    expect(await page.evaluate(async () => (await caches.keys()).length)).toBe(1);

    await context.setOffline(true);
    // Sanity check that the browser really is offline: a URL outside the precache goes to the network and fails.
    expect(await page.evaluate(() => fetch(`./not-cached.txt?${Date.now()}`).then(() => "reachable", () => "offline"))).toBe("offline");
    await page.reload();
    await app.ready();
    await expect(page.getByRole("heading", { level: 1, name: "Recetas" })).toBeVisible();

    // Create a recipe with a photo while offline.
    await app.createRecipe({
      name: "Frijoles de la olla",
      photo: true,
      sourceUrl: `${sourceOrigin}/frijoles`,
      lines: [{ ingredient: "Ajo", quantity: "2", unit: "pieza" }],
      steps: ["Cocer los frijoles"],
    });
    const photo = page.getByRole("img", { name: "Foto de Frijoles de la olla" });
    await expect.poll(() => photo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);

    // Edit it offline, replace the photo and reload still offline.
    await press(page.getByRole("link", { name: "Editar", exact: true }));
    await page.locator("#recipe-name").fill("Frijoles charros");
    await page.locator('input[type="file"]').setInputFiles({
      name: "otra.png",
      mimeType: "image/png",
      buffer: (await import("./support/png")).gradientPng(200, 200, 7),
    });
    await expect(page.getByRole("img", { name: "Vista previa de la foto nueva" })).toBeVisible();
    await press(page.getByRole("button", { name: "Guardar cambios" }));
    await expect(page.getByRole("heading", { level: 1, name: "Frijoles charros" })).toBeVisible();

    await page.reload();
    await app.ready();
    await expect(page.getByRole("heading", { level: 1, name: "Frijoles charros" })).toBeVisible();
    await expect.poll(() => page.getByRole("img", { name: "Foto de Frijoles charros" })
      .evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);

    // Back online, the external source link opens in a new tab. The page is a local fixture, not the network.
    await context.setOffline(false);
    const link = page.getByRole("link", { name: new RegExp(sourceHost.replace(".", "\\.")) });
    const popupPromise = page.waitForEvent("popup");
    await press(link);
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    await expect(popup).toHaveTitle(sourcePageTitle);
    expect(popup.url()).toBe(`${sourceOrigin}/frijoles`);
  });
});
