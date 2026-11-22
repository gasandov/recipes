import { expect, press, setChecked, sourceOrigin, test } from "./support/app";

test.describe("recipe library", () => {
  test("a name-only recipe is a complete recipe", async ({ app, page }) => {
    await app.goto("#/recetas");
    await expect(page.getByRole("heading", { name: "Aún no tienes recetas" })).toBeVisible();

    await press(page.getByRole("link", { name: "Crear mi primera receta" }));
    await press(page.getByRole("button", { name: "Guardar receta" }));
    // The only required field reports its error in Spanish and in a summary.
    await expect(page.getByRole("heading", { name: "Revisa estos campos antes de guardar" })).toBeVisible();
    await expect(page.locator("#recipe-name")).toHaveAttribute("aria-invalid", "true");

    await page.locator("#recipe-name").fill("Agua de jamaica");
    await press(page.getByRole("button", { name: "Guardar receta" }));
    await expect(page.getByRole("heading", { level: 1, name: "Agua de jamaica" })).toBeVisible();
    await expect(page.getByText("Esta receta aún no tiene ingredientes.")).toBeVisible();
    await expect(page.getByText("Esta receta aún no tiene pasos.")).toBeVisible();

    await app.open("#/recetas");
    await expect(page.getByRole("status").filter({ hasText: "1 receta" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Agua de jamaica/ })).toContainText("Sin ingredientes");
  });

  test("a complete recipe keeps its four-portion quantities, photo, steps, categories, tags and source", async ({ app, page }) => {
    await app.createRecipe({
      name: "Tinga de pollo",
      portions: 2,
      photo: true,
      sourceUrl: `${sourceOrigin}/tinga`,
      categories: ["Platillos fuertes", "Mexicana"],
      tags: ["Contiene carne"],
      steps: ["Picar la cebolla", "Cocinar el pollo", "Servir caliente"],
      lines: [
        { ingredient: "Pechuga de pollo", quantity: "500", unit: "g" },
        { ingredient: "Jitomate", quantity: "2", unit: "pieza" },
        { ingredient: "Chile", note: "al gusto" },
        { ingredient: "Epazote fresco", create: true },
      ],
    });

    // Entered for two portions, saved and shown for four.
    expect(await app.detailIngredients()).toEqual([
      "1 kg Pechuga de pollo",
      "4 piezas Jitomate",
      "al gusto Chile",
      "Epazote fresco",
    ]);
    await expect(page.getByText("Para 4 porciones")).toBeVisible();
    await expect(page.getByRole("list", { name: "Categorías y etiquetas" })).toContainText("Platillos fuertes");
    await expect(page.getByRole("list", { name: "Categorías y etiquetas" })).toContainText("Mexicana");
    await expect(page.getByRole("list", { name: "Categorías y etiquetas" })).toContainText("Contiene carne");
    await expect(page.locator(".steps li")).toHaveText(["Picar la cebolla", "Cocinar el pollo", "Servir caliente"]);

    // The photo is stored as bytes and rebuilt for display.
    const photo = page.getByRole("img", { name: "Foto de Tinga de pollo" });
    await expect(photo).toBeVisible();
    await expect.poll(() => photo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);

    // The external link is validated, never fetched by the app, and opens in a separate context.
    const link = page.getByRole("link", { name: /recetas\.example/ });
    await expect(link).toHaveAttribute("href", `${sourceOrigin}/tinga`);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
  });

  test("steps can be reordered with buttons and edits do not rescale quantities", async ({ app, page }) => {
    await app.createRecipe({
      name: "Sopa de fideo",
      steps: ["Freír los fideos", "Licuar el jitomate", "Hervir"],
      lines: [{ ingredient: "Jitomate", quantity: "3", unit: "pieza" }],
    });

    await press(page.getByRole("link", { name: "Editar", exact: true }));
    await expect(page.getByRole("heading", { level: 1, name: "Editar receta" })).toBeVisible();
    await press(page.getByRole("button", { name: "Subir el paso 2" }));
    await expect(page.getByLabel("Paso 1", { exact: true })).toHaveValue("Licuar el jitomate");
    await expect(page.getByLabel("Paso 2", { exact: true })).toHaveValue("Freír los fideos");
    await press(page.getByRole("button", { name: "Bajar el paso 1" }));
    await press(page.getByRole("button", { name: "Subir el paso 3" }));
    await page.locator("#recipe-name").fill("Sopa de fideo seco");
    await press(page.getByRole("button", { name: "Guardar cambios" }));

    await expect(page.getByRole("heading", { level: 1, name: "Sopa de fideo seco" })).toBeVisible();
    await expect(page.getByText("Cambios guardados.")).toBeVisible();
    await expect(page.locator(".steps li")).toHaveText(["Freír los fideos", "Hervir", "Licuar el jitomate"]);
    expect(await app.detailIngredients()).toEqual(["3 piezas Jitomate"]);
  });

  test("changing the display unit shows converted amounts without changing the recipe", async ({ app, page }) => {
    await app.createRecipe({
      name: "Pan de agua",
      lines: [{ ingredient: "Harina de trigo", quantity: "500", unit: "g" }],
    });
    expect(await app.detailIngredients()).toEqual(["500 g Harina de trigo"]);

    const picker = page.getByLabel("Unidad para Harina de trigo");
    await picker.selectOption("kilogram");
    expect(await app.detailIngredients()).toEqual(["1/2 kg Harina de trigo"]);
    await picker.selectOption("gram");
    expect(await app.detailIngredients()).toEqual(["500 g Harina de trigo"]);

    // A reload shows the stored value again, so the unit choice was only a display choice.
    await page.reload();
    await app.ready();
    expect(await app.detailIngredients()).toEqual(["500 g Harina de trigo"]);
  });

  test("a source link that is not http or https is rejected", async ({ app, page }) => {
    await app.open("#/recetas/nueva");
    await page.locator("#recipe-name").fill("Receta con enlace malo");
    await page.locator("#recipe-source").fill("javascript:alert(1)");
    await press(page.getByRole("button", { name: "Guardar receta" }));
    await expect(page.getByRole("heading", { name: "Revisa estos campos antes de guardar" })).toBeVisible();
    await expect(page.locator("#recipe-source")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("heading", { level: 1, name: "Nueva receta" })).toBeVisible();
  });

  test("recipes can be deleted after confirmation", async ({ app, page }) => {
    await app.createRecipe({ name: "Receta pasajera" });
    await press(page.getByRole("button", { name: "Eliminar" }));
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Esta acción no se puede deshacer.");
    await press(dialog.getByRole("button", { name: "Cancelar" }));
    await expect(page.getByRole("heading", { level: 1, name: "Receta pasajera" })).toBeVisible();

    await press(page.getByRole("button", { name: "Eliminar" }));
    await press(page.getByRole("dialog").getByRole("button", { name: "Eliminar receta" }));
    await expect(page.getByText("Receta eliminada.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Aún no tienes recetas" })).toBeVisible();
  });
});

test.describe("discovery", () => {
  test.beforeEach(async ({ app }) => {
    await app.createRecipe({
      name: "Tinga de pollo",
      categories: ["Mexicana"],
      lines: [{ ingredient: "Pechuga de pollo", quantity: "400", unit: "g" }],
    });
    await app.createRecipe({
      name: "Pollo agridulce",
      categories: ["China"],
      lines: [{ ingredient: "Pollo", quantity: "300", unit: "g" }],
    });
    await app.createRecipe({
      name: "Chilaquiles verdes",
      categories: ["Mexicana", "Desayunos"],
      lines: [{ ingredient: "Chile", quantity: "3", unit: "pieza" }, { ingredient: "Huevo", quantity: "2", unit: "pieza" }],
    });
    await app.createRecipe({ name: "Café de olla" });
    await app.open("#/recetas");
  });

  test("searches ignore case and accents", async ({ page }) => {
    const results = page.locator("ul li.card");
    await expect(results).toHaveCount(4);
    await page.getByLabel("Buscar por nombre").fill("CAFE");
    await expect(results).toHaveCount(1);
    await expect(results.first()).toContainText("Café de olla");
    await expect(page.getByRole("status").filter({ hasText: "1 receta" })).toBeVisible();
    await page.getByLabel("Buscar por nombre").fill("pollo");
    await expect(results).toHaveCount(2);
    await press(page.getByRole("button", { name: "Limpiar búsqueda y filtros" }));
    await expect(results).toHaveCount(4);
  });

  test("combines a cuisine with an ingredient, including cuts of a general ingredient", async ({ page }) => {
    const results = page.locator("ul li.card");
    await press(page.getByRole("button", { name: "Filtros" }));
    await setChecked(page.getByRole("checkbox", { name: "Mexicana", exact: true }));
    await expect(results).toHaveCount(2);

    const ingredient = page.getByLabel("Ingrediente", { exact: true });
    await ingredient.fill("Pollo");
    await press(page.getByRole("option", { name: /^Pollo( · |$)/ }));
    // Mexican AND chicken: the recipe that uses a cut, but neither the Chinese chicken dish nor the Mexican egg dish.
    await expect(results).toHaveCount(1);
    await expect(results.first()).toContainText("Tinga de pollo");
    await expect(page.getByRole("list", { name: "Filtros activos" })).toContainText("Pollo");

    // Within one group any selection matches: add the Chinese cuisine.
    await setChecked(page.getByRole("checkbox", { name: "China", exact: true }));
    await expect(results).toHaveCount(2);

    await press(page.getByRole("button", { name: "Quitar el filtro Pollo" }));
    await expect(results).toHaveCount(3);
    await press(page.getByRole("button", { name: "Limpiar búsqueda y filtros" }));
    await expect(results).toHaveCount(4);
  });
});
