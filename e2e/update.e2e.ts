import { App, expect, test } from "./support/app";
import { updatePorts } from "./support/ports";

// Each project talks to its own server port, so switching the served release cannot disturb other specs.
// The server pretends a new version shipped by changing the `sw.js` revision and adding a marker to the shell.
test.describe.configure({ mode: "serial" });

test.describe("a new release of the app", () => {
  test("keeps recipes, photos and the menu, and replaces the old cache", async ({ context, page }, testInfo) => {
    const origin = `http://127.0.0.1:${updatePorts[testInfo.project.name as keyof typeof updatePorts]}`;
    const release = (version: string) =>
      fetch(`${origin}/__e2e/release?version=${version}`, { method: "POST" }).then((response) => expect(response.status).toBe(204));
    await release("a");

    // Version A: populate the app.
    await page.goto(`${origin}/#/recetas`);
    const app = new App(page);
    await app.ready();
    await app.waitForServiceWorkerControl();
    await app.createRecipe({
      name: "Pozole verde",
      photo: true,
      lines: [{ ingredient: "Pechuga de pollo", quantity: "600", unit: "g" }, { ingredient: "Cebolla", note: "al gusto" }],
      steps: ["Hervir el pollo"],
    });
    await app.addToMenu("Pozole verde");
    await app.setPortions("Pozole verde", 8);
    const before = await app.shoppingList();
    expect(before["Pechuga de pollo"]).toEqual([expect.stringMatching(/^1[.,]2 kg$/)]);

    const cachesBefore = await page.evaluate(() => caches.keys());
    expect(cachesBefore).toHaveLength(1);
    await expect(page.locator('meta[name="e2e-release"]')).toHaveCount(0);

    // Version B ships. The open page keeps working on version A, and B waits until the app is closed.
    await release("b");
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
    });
    await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))).toBe(true);
    await expect(page.locator('meta[name="e2e-release"]')).toHaveCount(0);
    expect(await page.evaluate(() => caches.keys())).toHaveLength(2);

    // Closing and reopening the app, as a person would, activates B. Allow a couple of reopen cycles.
    await page.close();
    let reopened = await context.newPage();
    await expect.poll(async () => {
      await reopened.goto(`${origin}/#/recetas`);
      const state = await reopened.evaluate(async () => {
        await navigator.serviceWorker.ready;
        const registration = await navigator.serviceWorker.getRegistration();
        return { waiting: Boolean(registration?.waiting), release: document.querySelector('meta[name="e2e-release"]')?.getAttribute("content") };
      });
      if (state.waiting || state.release !== "b") {
        await reopened.close();
        reopened = await context.newPage();
        return false;
      }
      return true;
    }, { timeout: 30_000, intervals: [250, 500, 1000] }).toBe(true);

    const upgraded = new App(reopened);
    await upgraded.ready();
    await upgraded.waitForServiceWorkerControl();
    const cachesAfter = await reopened.evaluate(() => caches.keys());
    expect(cachesAfter).toHaveLength(1);
    expect(cachesAfter[0]).toMatch(/release-b$/);
    expect(cachesAfter[0]).not.toBe(cachesBefore[0]);

    // Data written by version A is intact under version B.
    await upgraded.openRecipe("Pozole verde");
    expect(await upgraded.detailIngredients()).toEqual(["600 g Pechuga de pollo", "al gusto Cebolla"]);
    const photo = reopened.getByRole("img", { name: "Foto de Pozole verde" });
    await expect.poll(() => photo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await upgraded.open("#/menu");
    await expect(upgraded.batch("Pozole verde").getByLabel("Porciones", { exact: true })).toHaveValue("8");
    expect(await upgraded.shoppingList()).toEqual(before);

    // The upgraded app still works offline from its new cache.
    await context.setOffline(true);
    await reopened.reload();
    await upgraded.ready();
    expect(await upgraded.shoppingList()).toEqual(before);
    await context.setOffline(false);
    await release("a");
  });
});
