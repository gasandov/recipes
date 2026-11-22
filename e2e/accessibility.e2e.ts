import { expect, press, test } from "./support/app";
import type { App } from "./support/app";

const routes = [
  "#/recetas",
  "#/recetas/nueva",
  "#/ingredientes",
  "#/categorias",
  "#/menu",
  "#/compras",
];

async function hasHorizontalOverflow(app: App): Promise<boolean> {
  return app.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}

test.describe("keyboard and focus", () => {
  test("the skip link and route changes move focus to the page heading", async ({ app, page, browserName }) => {
    test.skip(browserName === "webkit", "Safari does not Tab to links by default, so Tab-driven focus is checked on Chromium.");
    await app.goto("#/recetas");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Saltar al contenido" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Recetas" })).toBeFocused();
  });

  test("navigating between views announces the new heading by focusing it", async ({ app, page }) => {
    await app.goto("#/recetas");
    await press(page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Recetas" }));
    await app.open("#/ingredientes");
    await expect(page.getByRole("heading", { level: 1, name: "Ingredientes" })).toBeFocused();
    await expect(page).toHaveTitle(/^Ingredientes · Recetario$/);
  });

  test("a recipe can be written and saved with the keyboard alone", async ({ app, page }) => {
    await app.goto("#/recetas/nueva");
    await page.locator("#recipe-name").focus();
    await page.keyboard.type("Quesadillas de hongos");

    // Add a measured ingredient with the combobox: type, Enter picks the highlighted option.
    await page.locator("#add-line").focus();
    await page.keyboard.press("Enter");
    const combobox = page.locator('li.line-card input[role="combobox"]').first();
    await expect(combobox).toBeFocused();
    await page.keyboard.type("Huevo");
    await expect(page.getByRole("option", { name: /^Huevo/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(combobox).toHaveValue("Huevo");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Cantidad", { exact: true })).toBeFocused();
    await page.keyboard.type("2");

    // Two steps, then move the second up with the keyboard.
    await page.getByLabel("Paso 1", { exact: true }).focus();
    await page.keyboard.type("Calentar el comal");
    await page.locator("#add-step").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Paso 2", { exact: true })).toBeFocused();
    await page.keyboard.type("Rellenar las tortillas");
    await page.getByRole("button", { name: "Subir el paso 2" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Paso 1", { exact: true })).toHaveValue("Rellenar las tortillas");

    // A checkbox toggles with Space, and Enter in a text field submits the form.
    const mexican = page.getByRole("checkbox", { name: "Mexicana", exact: true });
    await mexican.focus();
    await page.keyboard.press("Space");
    await expect(mexican).toBeChecked();
    await page.locator("#recipe-name").focus();
    await page.keyboard.press("Enter");

    await expect(page.getByRole("heading", { level: 1, name: "Quesadillas de hongos" })).toBeFocused();
    expect(await app.detailIngredients()).toEqual(["2 g Huevo"])  // the unit select keeps its default, gramos;
    await expect(page.locator(".steps li")).toHaveText(["Rellenar las tortillas", "Calentar el comal"]);
  });

  test("validation errors are announced and linked to their fields", async ({ app, page }) => {
    await app.goto("#/recetas/nueva");
    await page.locator("#recipe-portions").fill("0");
    await page.locator("#recipe-name").focus();
    await page.keyboard.press("Enter");
    const summary = page.locator("#form-summary");
    await expect(summary).toBeVisible();
    await expect(summary.getByRole("link", { name: /nombre/i })).toBeVisible();
    await summary.getByRole("link", { name: /nombre/i }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#recipe-name")).toBeFocused();
    await expect(page.locator("#recipe-name")).toHaveAttribute("aria-describedby", "recipe-name-error");
    await expect(page.locator("#recipe-name-error")).not.toBeEmpty();
  });

  test("dialogs trap focus, close with Escape and return focus", async ({ app, page, browserName }) => {
    await app.createRecipe({ name: "Receta con diálogo" });
    const remove = page.getByRole("button", { name: "Eliminar" });
    await remove.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest("dialog")))).toBe(true);
    if (browserName !== "webkit") {
      // The dialog has two buttons, so one Tab and one Shift+Tab stay inside it. Safari's Tab order is
      // user-configurable, so the Tab-driven part runs on Chromium only.
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest("dialog")))).toBe(true);
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest("dialog")))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(remove).toBeFocused();
  });
});

test.describe("narrow screens", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test("no view needs horizontal scrolling at 320 px", async ({ app }) => {
    await app.createRecipe({
      name: "Receta con un nombre muy largo para comprobar que el diseño se ajusta bien en pantallas angostas",
      sourceUrl: "https://recetas.example/una/direccion/muy/larga/que/no/debe/romper/el/diseno/de/la/pantalla",
      photo: true,
      steps: ["Un paso con un texto largo para ver cómo se acomoda en una pantalla muy angosta sin desbordarse"],
      lines: [{ ingredient: "Pechuga de pollo", quantity: "1 1/2", unit: "kg" }],
    });
    expect(await hasHorizontalOverflow(app)).toBe(false);
    await app.addToMenu("Receta con un nombre muy largo para comprobar que el diseño se ajusta bien en pantallas angostas");

    for (const route of routes) {
      await app.open(route);
      expect(await hasHorizontalOverflow(app), `horizontal overflow on ${route}`).toBe(false);
    }
    await app.open("#/recetas");
    await press(app.page.getByRole("button", { name: "Filtros" }));
    expect(await hasHorizontalOverflow(app)).toBe(false);
  });

  test("controls are large enough to tap", async ({ app, page }) => {
    await app.createRecipe({ name: "Receta táctil", lines: [{ ingredient: "Huevo", quantity: "2", unit: "pieza" }] });
    await app.addToMenu("Receta táctil");
    for (const route of ["#/recetas", "#/menu"]) {
      await app.open(route);
      const small = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("main a, main button, header a")]
          .filter((element) => element.offsetParent !== null)
          .map((element) => ({ name: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40), box: element.getBoundingClientRect() }))
          // Links inside running text are exempt, as are the skip link and hidden helpers.
          .filter(({ box }) => box.height < 24 || box.width < 24)
          .map(({ name, box }) => `${name} (${Math.round(box.width)}×${Math.round(box.height)})`),
      );
      expect(small, `controls under 24 CSS px (WCAG 2.2 minimum target size) on ${route}`).toEqual([]);
    }
  });
});

test.describe("language", () => {
  test("the document is Mexican Spanish and chrome text has no English leftovers", async ({ app, page }) => {
    await app.goto("#/recetas");
    await expect(page.locator("html")).toHaveAttribute("lang", "es-MX");
    const manifest = await page.evaluate(async () => (await fetch(document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!.href)).json());
    expect(manifest.lang).toBe("es-MX");
    expect(manifest.name).toBe("Recetario");

    const english = /\b(Save|Cancel|Delete|Edit|Search|Filters?|Recipes?|Ingredients?|Shopping|Menu|Add to|Loading|Error|Home|Settings)\b/;
    for (const route of routes) {
      await app.open(route);
      const text = await page.locator("body").innerText();
      expect(text.match(english)?.[0], `English text on ${route}`).toBeUndefined();
    }
  });
});
