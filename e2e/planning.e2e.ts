import { expect, press, test } from "./support/app";
import type { App } from "./support/app";

/** Matches a decimal with either separator and a range with a hyphen or an en dash. */
const decimal = (value: string) => value.replace(".", "[.,]");

async function requirePlanningViews(app: App): Promise<void> {
  await app.goto("#/menu");
  const heading = await app.page.getByRole("heading", { level: 1 }).innerText();
  test.skip(heading === "Página no encontrada", "The Phase 3 #/menu view is not in this build yet.");
}

test.describe("menu and shopping list", () => {
  test.beforeEach(async ({ app }) => {
    await requirePlanningViews(app);
  });

  test("navigation offers Menú and Lista de compras with Spanish empty states", async ({ app, page }) => {
    await app.goto("#/recetas");
    const nav = page.getByRole("navigation", { name: "Principal" });
    await expect(nav.getByRole("link", { name: "Menú", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Lista de compras", exact: true })).toBeVisible();

    await press(nav.getByRole("link", { name: "Menú", exact: true }));
    await expect(page.getByRole("heading", { level: 1, name: "Menú" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tu menú está vacío" })).toBeVisible();
    await press(nav.getByRole("link", { name: "Lista de compras", exact: true }));
    await expect(page.getByRole("heading", { level: 1, name: "Lista de compras" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Aún no hay ingredientes para comprar" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Lista de compras", exact: true })).toHaveAttribute("aria-current", "page");
  });

  test("shopping totals follow the exit criteria and batch portions scale them", async ({ app, page }) => {
    await app.createRecipe({
      name: "Pan casero",
      lines: [
        { ingredient: "Harina de trigo", quantity: "500", unit: "g" },
        { ingredient: "Huevo", quantity: "2", unit: "pieza" },
        { ingredient: "Leche", quantity: "1", unit: "taza" },
        { ingredient: "Pechuga de pollo", quantity: "400", unit: "g" },
      ],
    });
    await app.createRecipe({
      name: "Hot cakes",
      lines: [
        { ingredient: "Harina de trigo", quantity: "1", unit: "kg" },
        { ingredient: "Huevo", quantity: "2", unit: "pieza" },
        { ingredient: "Milanesa de pollo", quantity: "300", unit: "g" },
        { ingredient: "Chile", quantity: "2-3", unit: "pieza" },
      ],
    });
    await app.createRecipe({
      name: "Salsa verde",
      lines: [
        { ingredient: "Chile", quantity: "1", unit: "pieza" },
        { ingredient: "Cebolla" },
        { ingredient: "Ajo", note: "al gusto" },
      ],
    });
    for (const name of ["Pan casero", "Hot cakes", "Salsa verde"]) await app.addToMenu(name);

    await app.open("#/menu");
    for (const name of ["Pan casero", "Hot cakes", "Salsa verde"]) {
      await expect(app.batch(name).getByLabel("Porciones", { exact: true })).toHaveValue("4");
    }

    const list = await app.shoppingList();
    expect(list["Harina de trigo"]).toEqual([expect.stringMatching(new RegExp(`^${decimal("1.5")} kg$`))]);
    expect(list["Huevo"]).toEqual(["4 piezas"]);
    expect(list["Chile"]).toEqual([expect.stringMatching(/^3[–-]4 piezas$/)]);
    expect(list["Pechuga de pollo"]).toEqual(["400 g"]);
    expect(list["Milanesa de pollo"]).toEqual(["300 g"]);
    // A cut and its general ingredient are never merged, and nothing invents the parent.
    expect(Object.keys(list)).not.toContain("Pollo");
    expect(list["Cebolla"]).toEqual(["Sin cantidad"]);
    expect(list["Ajo"]).toEqual(["al gusto"]);
    expect(list["Leche"]).toEqual(["1 taza"]);

    // A cup converts to 250 ml and back without touching the batch.
    const milk = page.locator("li.shopping-ingredient").filter({ has: page.getByRole("heading", { name: "Leche" }) });
    await milk.getByLabel(/^Unidad para Leche/).selectOption("milliliter");
    await expect(milk.locator(".shopping-total strong")).toHaveText("250 ml");
    await milk.getByLabel(/^Unidad para Leche/).selectOption("cup");
    await expect(milk.locator(".shopping-total strong")).toHaveText("1 taza");

    // Doubling one batch doubles its purchases and leaves the recipe untouched.
    await app.setPortions("Pan casero", 8);
    const doubled = await app.shoppingList();
    expect(doubled["Harina de trigo"]).toEqual([expect.stringMatching(/^2 kg$/)]);
    expect(doubled["Huevo"]).toEqual(["6 piezas"]);
    expect(doubled["Pechuga de pollo"]).toEqual(["800 g"]);
    expect(doubled["Milanesa de pollo"]).toEqual(["300 g"]);
    await app.openRecipe("Pan casero");
    expect(await app.detailIngredients()).toEqual(["500 g Harina de trigo", "2 piezas Huevo", "1 taza Leche", "400 g Pechuga de pollo"]);
  });

  test("a repeated recipe is an independent batch, and removing a batch updates the list", async ({ app, page }) => {
    await app.createRecipe({ name: "Arroz rojo", lines: [{ ingredient: "Jitomate", quantity: "3", unit: "pieza" }] });
    await app.addToMenu("Arroz rojo");
    await app.addToMenu("Arroz rojo");
    await app.open("#/menu");
    await expect(page.locator("li.menu-batch")).toHaveCount(2);
    expect((await app.shoppingList())["Jitomate"]).toEqual(["6 piezas"]);

    // Portions are per batch: halving the first batch (3 pieces at 4 portions) gives 1 1/2, so 4 1/2 in total.
    await app.setPortions("Arroz rojo", 2);
    expect((await app.shoppingList())["Jitomate"]).toEqual([expect.stringMatching(/^4 1\/2 piezas$/)]);

    await app.open("#/menu");
    await press(page.getByRole("button", { name: "Quitar lote de «Arroz rojo»" }).first());
    await expect(page.locator("li.menu-batch")).toHaveCount(1);
    expect((await app.shoppingList())["Jitomate"]).toEqual([expect.stringMatching(/^(1 1\/2|3) piezas$/)]);
  });

  test("portion input is validated in Spanish", async ({ app }) => {
    await app.createRecipe({ name: "Sopa de lima", lines: [{ ingredient: "Jitomate", quantity: "1", unit: "pieza" }] });
    await app.addToMenu("Sopa de lima");
    await app.open("#/menu");
    const batch = app.batch("Sopa de lima");
    for (const invalid of ["0", "-2", "1.5", "abc", ""]) {
      await batch.getByLabel("Porciones", { exact: true }).fill(invalid);
      await press(batch.getByRole("button", { name: "Guardar porciones" }));
      await expect(batch.getByText("Escribe un número entero de porciones mayor que cero.")).toBeVisible();
      await expect(batch.getByLabel("Porciones", { exact: true })).toHaveAttribute("aria-invalid", "true");
    }
  });

  test("recipes with no ingredients can be planned and are identified as such", async ({ app, page }) => {
    await app.createRecipe({ name: "Agua de jamaica" });
    await app.addToMenu("Agua de jamaica");
    await app.open("#/menu");
    await expect(app.batch("Agua de jamaica")).toContainText("Este lote no tiene ingredientes para la lista de compras.");
    await app.open("#/compras");
    await expect(page.getByText("Ninguno de los lotes del menú tiene ingredientes.")).toBeVisible();
  });

  test("editing or deleting a recipe leaves existing batch totals intact", async ({ app, page }) => {
    await app.createRecipe({
      name: "Pozole rojo",
      lines: [{ ingredient: "Pechuga de pollo", quantity: "600", unit: "g" }, { ingredient: "Ajo", quantity: "4", unit: "pieza" }],
    });
    await app.addToMenu("Pozole rojo");
    const before = await app.shoppingList();
    expect(before["Pechuga de pollo"]).toEqual(["600 g"]);

    // Edit the recipe: new name and a much larger quantity.
    await app.openRecipe("Pozole rojo");
    await press(page.getByRole("link", { name: "Editar", exact: true }));
    await page.locator("#recipe-name").fill("Pozole rojo mejorado");
    await page.locator("li.line-card").first().getByLabel("Cantidad", { exact: true }).fill("5");
    await press(page.getByRole("button", { name: "Guardar cambios" }));
    await expect(page.getByRole("heading", { level: 1, name: "Pozole rojo mejorado" })).toBeVisible();
    expect(await app.shoppingList()).toEqual(before);
    await app.open("#/menu");
    await expect(app.batch("Pozole rojo")).toBeVisible();

    // Delete it: the batch and its totals remain, with a note that the source is gone.
    await app.openRecipe("Pozole rojo mejorado");
    await press(page.getByRole("button", { name: "Eliminar" }));
    await press(page.getByRole("dialog").getByRole("button", { name: "Eliminar receta" }));
    await expect(page.getByText("Receta eliminada.").first()).toBeVisible();
    expect(await app.shoppingList()).toEqual(before);
    await app.open("#/menu");
    await expect(app.batch("Pozole rojo")).toContainText("La receta original se eliminó. El lote sigue en tu menú.");
  });

  test("clearing the menu asks for confirmation and empties both views", async ({ app, page }) => {
    await app.createRecipe({ name: "Guacamole", lines: [{ ingredient: "Cebolla", quantity: "1", unit: "pieza" }] });
    await app.addToMenu("Guacamole");
    await app.open("#/menu");
    await press(page.getByRole("button", { name: "Vaciar menú" }));
    const dialog = page.getByRole("dialog", { name: "¿Vaciar el menú?" });
    await press(dialog.getByRole("button", { name: "Cancelar" }));
    await expect(app.batch("Guacamole")).toBeVisible();

    await press(page.getByRole("button", { name: "Vaciar menú" }));
    await press(page.getByRole("dialog").getByRole("button", { name: "Sí, vaciar el menú" }));
    await expect(page.getByRole("heading", { name: "Tu menú está vacío" })).toBeVisible();
    await app.open("#/compras");
    await expect(page.getByRole("heading", { name: "Aún no hay ingredientes para comprar" })).toBeVisible();
  });

  test("ingredient equivalences merge mass and volume, and their absence keeps both visible", async ({ app, page }) => {
    await app.createIngredient("Caldo espeso", "0.8");
    await app.createIngredient("Consomé");
    await app.createRecipe({ name: "Sopa A", lines: [{ ingredient: "Caldo espeso", quantity: "100", unit: "ml" }, { ingredient: "Consomé", quantity: "100", unit: "ml" }] });
    await app.createRecipe({ name: "Sopa B", lines: [{ ingredient: "Caldo espeso", quantity: "80", unit: "g" }, { ingredient: "Consomé", quantity: "80", unit: "g" }] });
    await app.addToMenu("Sopa A");
    await app.addToMenu("Sopa B");

    // Without an equivalence, mass and volume stay separate under the same ingredient.
    const list = await app.shoppingList();
    expect([...list["Consomé"]!].sort()).toEqual(["100 ml", "80 g"]);

    // With 0.8 g/ml, 100 ml is 80 g, so the sum is about 160 g when shown by mass.
    const broth = page.locator("li.shopping-ingredient").filter({ has: page.getByRole("heading", { name: "Caldo espeso" }) });
    await expect(broth.locator(".shopping-total")).toHaveCount(1);
    await broth.getByLabel(/^Unidad para Caldo espeso/).selectOption("gram");
    await expect(broth.locator(".shopping-total strong")).toHaveText(/^≈\s*160 g$/);
  });

  test("the plan survives a reload and works offline", async ({ app, page, context }) => {
    await app.createRecipe({ name: "Tacos de canasta", lines: [{ ingredient: "Cebolla", quantity: "2", unit: "pieza" }] });
    await app.addToMenu("Tacos de canasta");
    await app.setPortions("Tacos de canasta", 8);
    await app.waitForServiceWorkerControl();

    await context.setOffline(true);
    await page.reload();
    await app.ready();
    expect((await app.shoppingList())["Cebolla"]).toEqual(["4 piezas"]);
    await app.setPortions("Tacos de canasta", 12);
    expect((await app.shoppingList())["Cebolla"]).toEqual(["6 piezas"]);
    await context.setOffline(false);
  });
});
