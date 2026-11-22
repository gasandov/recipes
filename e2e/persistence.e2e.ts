import { App, expect, press, sourceOrigin, test } from "./support/app";

const recipe = {
  name: "Enchiladas verdes",
  portions: 2,
  photo: true,
  sourceUrl: `${sourceOrigin}/enchiladas`,
  categories: ["Platillos fuertes", "Mexicana"],
  tags: ["Contiene carne"],
  steps: ["Hervir los tomates", "Rellenar las tortillas"],
  lines: [
    { ingredient: "Pechuga de pollo", quantity: "500", unit: "g" as const },
    { ingredient: "Chile", quantity: "1 1/2", unit: "pieza" as const },
  ],
};

test.describe("local persistence", () => {
  test("recipes and photos survive a reload and a new page in the same browser", async ({ app, page, context }) => {
    await app.createRecipe(recipe);
    await page.reload();
    await app.ready();
    await expect(page.getByRole("heading", { level: 1, name: recipe.name })).toBeVisible();
    // 1 1/2 chiles entered for two portions are 3 chiles at four portions.
    expect(await app.detailIngredients()).toEqual(["1 kg Pechuga de pollo", "3 piezas Chile"]);

    // A new page (as after closing and reopening the app) reads the same IndexedDB database.
    await page.close();
    const reopened = await context.newPage();
    const second = new App(reopened);
    await second.goto("#/recetas");
    await expect(reopened.getByRole("link", { name: /Enchiladas verdes/ })).toBeVisible();
    await second.openRecipe(recipe.name);
    expect(await second.detailIngredients()).toEqual(["1 kg Pechuga de pollo", "3 piezas Chile"]);
    await expect(reopened.locator(".steps li")).toHaveText(recipe.steps);
    await expect(reopened.getByRole("list", { name: "Categorías y etiquetas" })).toContainText("Contiene carne");
    const photo = reopened.getByRole("img", { name: "Foto de Enchiladas verdes" });
    await expect.poll(() => photo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  });

  test("a failed save keeps the form and reports it, then a retry succeeds", async ({ app, page }) => {
    await app.open("#/recetas/nueva");
    await page.locator("#recipe-name").fill("Receta con falla de guardado");

    // Make the next IndexedDB write fail, as when storage is full or blocked.
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      (window as unknown as { __restorePut: () => void }).__restorePut = () => {
        IDBObjectStore.prototype.put = original;
      };
      IDBObjectStore.prototype.put = function failingPut(): IDBRequest {
        throw new DOMException("Simulated quota failure", "QuotaExceededError");
      };
    });
    await press(page.getByRole("button", { name: "Guardar receta" }));
    await expect(page.getByRole("heading", { name: "No se pudo guardar la receta" })).toBeVisible();
    await expect(page.getByText("Tus cambios siguen en este formulario.")).toBeVisible();
    await expect(page.locator("#recipe-name")).toHaveValue("Receta con falla de guardado");

    await page.evaluate(() => (window as unknown as { __restorePut: () => void }).__restorePut());
    await press(page.getByRole("button", { name: "Guardar receta" }));
    await expect(page.getByRole("heading", { level: 1, name: "Receta con falla de guardado" })).toBeVisible();
  });
});
