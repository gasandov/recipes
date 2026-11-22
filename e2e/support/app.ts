import { expect, test as base } from "@playwright/test";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { gradientPng } from "./png";

export { expect };

/** Host used for recipe source links. Requests to it are answered by a local fixture, never the network. */
export const sourceHost = "recetas.example";
export const sourceOrigin = `https://${sourceHost}`;
export const sourcePageTitle = "Página de origen (fixture local)";

const unitValues = {
  g: "gram",
  kg: "kilogram",
  ml: "milliliter",
  L: "liter",
  taza: "cup",
  cda: "tablespoon",
  cdta: "teaspoon",
  pieza: "piece",
  pizca: "pinch",
  manojo: "bunch",
} as const;
export type Unit = keyof typeof unitValues;

export type LineSpec =
  | { ingredient: string; create?: boolean; quantity: string; unit: Unit }
  | { ingredient: string; create?: boolean; note: string }
  | { ingredient: string; create?: boolean };

export type RecipeSpec = {
  name: string;
  /** Portions the entered quantities are written for. Defaults to the form's prefilled value. */
  portions?: number;
  sourceUrl?: string;
  photo?: boolean;
  categories?: string[];
  tags?: string[];
  steps?: string[];
  lines?: LineSpec[];
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Activates a control the way a person would on the project's device: a touch tap on touch devices
 * and a click elsewhere. WebKit's iPhone emulation has hit-test problems with synthetic mouse
 * clicks, while taps work.
 */
export async function press(locator: Locator): Promise<void> {
  if (base.info().project.use.hasTouch) await locator.tap();
  else await locator.click();
}

/** Checks or unchecks a checkbox with the platform-appropriate pointer, then confirms the result. */
export async function setChecked(locator: Locator, checked = true): Promise<void> {
  if ((await locator.isChecked()) !== checked) await press(locator);
  await expect(locator).toBeChecked({ checked });
}

/** The rendered text of an element with whitespace collapsed, handy for exact-text assertions. */
export async function textOf(locator: Locator): Promise<string> {
  return ((await locator.innerText()) ?? "").replace(/\s+/g, " ").trim();
}

export class App {
  constructor(readonly page: Page) {}

  /** Opens a hash route and waits until the app has finished loading its data. */
  async open(hash = "#/recetas"): Promise<void> {
    const current = this.page.url();
    if (current.startsWith("http")) {
      await this.page.evaluate((target) => {
        window.location.hash = target;
      }, hash);
    } else {
      await this.page.goto(`/${hash}`);
    }
    await this.ready();
  }

  async goto(hash = "#/recetas"): Promise<void> {
    await this.page.goto(`/${hash}`);
    await this.ready();
  }

  async ready(): Promise<void> {
    await expect(this.page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(this.page.getByText("Abriendo tu recetario…")).toHaveCount(0);
  }

  main(): Locator {
    return this.page.getByRole("main");
  }

  async waitForServiceWorkerControl(): Promise<void> {
    await this.page.waitForFunction(async () => {
      if (!("serviceWorker" in navigator)) return false;
      await navigator.serviceWorker.ready;
      return navigator.serviceWorker.controller !== null;
    }, undefined, { timeout: 30_000 });
  }

  /** Picks an option in an ingredient combobox by typing the name and choosing the matching row. */
  async pickIngredient(combobox: Locator, name: string, create = false): Promise<void> {
    await combobox.fill(name);
    const option = create
      ? this.page.getByRole("option", { name: /^Crear ingrediente nuevo/ })
      : this.page.getByRole("option", { name: new RegExp(`^${escapeRegExp(name)}( · |$)`) });
    await press(option);
    await expect(combobox).toHaveValue(name);
  }

  /** Fills and saves the recipe form. Leaves the browser on the saved recipe's detail page. */
  async createRecipe(spec: RecipeSpec): Promise<void> {
    const { page } = this;
    await this.open("#/recetas/nueva");
    await expect(page.getByRole("heading", { level: 1, name: "Nueva receta" })).toBeVisible();
    await page.locator("#recipe-name").fill(spec.name);
    if (spec.portions !== undefined) await page.locator("#recipe-portions").fill(String(spec.portions));
    if (spec.sourceUrl) await page.locator("#recipe-source").fill(spec.sourceUrl);

    if (spec.photo) {
      await page.locator('input[type="file"]').setInputFiles({
        name: "plato.png",
        mimeType: "image/png",
        buffer: gradientPng(320, 240, spec.name.length),
      });
      await expect(page.getByRole("img", { name: "Vista previa de la foto nueva" })).toBeVisible();
    }

    for (const [index, line] of (spec.lines ?? []).entries()) {
      await press(page.locator("#add-line"));
      const card = page.locator("li.line-card").nth(index);
      await this.pickIngredient(card.locator('input[role="combobox"]'), line.ingredient, line.create);
      if ("quantity" in line) {
        await card.getByLabel("Cantidad", { exact: true }).fill(line.quantity);
        await card.getByLabel("Unidad", { exact: true }).selectOption(unitValues[line.unit]);
      } else if ("note" in line) {
        await card.getByLabel("Tipo de cantidad").selectOption("qualitative");
        await card.getByLabel("Nota", { exact: true }).fill(line.note);
      } else {
        await card.getByLabel("Tipo de cantidad").selectOption("unspecified");
      }
    }

    for (const [index, text] of (spec.steps ?? []).entries()) {
      // A new form starts with one empty step, so only later steps need the add button.
      if (index > 0) await press(page.locator("#add-step"));
      await page.getByLabel(`Paso ${index + 1}`, { exact: true }).fill(text);
    }

    for (const category of spec.categories ?? []) {
      await setChecked(page.getByRole("checkbox", { name: category, exact: true }));
    }
    for (const tag of spec.tags ?? []) {
      await setChecked(page.getByRole("group", { name: "Etiquetas confirmadas" }).getByRole("checkbox", { name: tag, exact: true }));
    }

    await press(page.getByRole("button", { name: "Guardar receta" }));
    await expect(page.getByRole("heading", { level: 1, name: spec.name, exact: true })).toBeVisible();
    await expect(page.getByText("Receta guardada.").first()).toBeVisible();
  }

  /** Opens a saved recipe's detail page from the recipe list. */
  async openRecipe(name: string): Promise<void> {
    await this.open("#/recetas");
    await press(this.page.getByRole("link", { name: new RegExp(`^${escapeRegExp(name)}`) }).first());
    await expect(this.page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
  }

  /** Creates a catalog ingredient in the Ingredientes view, optionally with a g/ml equivalence. */
  async createIngredient(name: string, density?: string): Promise<void> {
    const { page } = this;
    await this.open("#/ingredientes");
    await press(page.getByRole("button", { name: "Nuevo ingrediente" }));
    const dialog = page.getByRole("dialog", { name: "Nuevo ingrediente" });
    await dialog.getByLabel(/^Nombre/).fill(name);
    if (density) await dialog.getByLabel(/^Densidad en g\/ml/).fill(density);
    await press(dialog.getByRole("button", { name: "Guardar" }));
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
  }

  /** Adds a batch from the recipe list using its `Agregar al menú` button. */
  async addToMenu(recipeName: string): Promise<void> {
    await this.open("#/recetas");
    // The accessible name is `Agregar al menú` optionally followed by the recipe name, with any punctuation.
    await press(this.page.getByRole("button", { name: new RegExp(`^Agregar al menú(\\W+${escapeRegExp(recipeName)}\\W*)?$`) }));
    await expect(this.page.getByText(`Se agregó «${recipeName}» al menú.`).first()).toBeVisible();
  }

  /** One batch card of the Menú view. */
  batch(recipeName: string): Locator {
    return this.page.locator("li.menu-batch").filter({ has: this.page.getByRole("heading", { level: 2, name: recipeName, exact: true }) });
  }

  /** Sets a batch's portions in the Menú view and waits for the confirmation. */
  async setPortions(recipeName: string, portions: number): Promise<void> {
    await this.open("#/menu");
    const batch = this.batch(recipeName).first();
    await batch.getByLabel("Porciones", { exact: true }).fill(String(portions));
    await press(batch.getByRole("button", { name: "Guardar porciones" }));
    await expect(this.page.getByText("Porciones actualizadas.").first()).toBeVisible();
    await expect(batch.getByLabel("Porciones", { exact: true })).toHaveValue(String(portions));
  }

  /** Reads the shopping list as `{ ingredient name: [visible amount or note, ...] }`. */
  async shoppingList(): Promise<Record<string, string[]>> {
    await this.open("#/compras");
    await expect(this.page.getByRole("heading", { level: 1, name: "Lista de compras" })).toBeVisible();
    return this.page.locator("li.shopping-ingredient").evaluateAll((items) =>
      Object.fromEntries(
        items.map((item) => {
          const name = item.querySelector("h2")?.textContent?.trim() ?? "";
          const lines = [...item.querySelectorAll("ul.ingredient-list > li")].map((line) => {
            const clone = line.cloneNode(true) as HTMLElement;
            clone.querySelectorAll(".sr-only, .unit-picker").forEach((node) => node.remove());
            return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
          });
          return [name, lines];
        }),
      ),
    );
  }

  /** Reads the ingredient rows of the open recipe detail page as normalized text. */
  async detailIngredients(): Promise<string[]> {
    const rows = this.page.locator(".ingredient-list > li .ingredient-main");
    const texts: string[] = [];
    for (const row of await rows.all()) {
      // Amount and name are separate inline elements, so join them the way they read on screen.
      // Screen-reader-only text and the unit picker are not part of the visible line.
      texts.push(await row.evaluate((element) => {
        const visible = (selector: string) => {
          const node = element.querySelector(selector)?.cloneNode(true) as HTMLElement | undefined;
          node?.querySelectorAll(".sr-only").forEach((child) => child.remove());
          return (node?.textContent ?? "").replace(/\s+/g, " ").trim();
        };
        return [visible(".ingredient-amount"), visible(".ingredient-name")].filter(Boolean).join(" ");
      }));
    }
    return texts;
  }
}

type Fixtures = { app: App; context: BrowserContext };

export const test = base.extend<Fixtures>({
  // Tests never touch the network: external recipe links resolve to a local fixture and everything else is blocked.
  context: async ({ context }, use) => {
    await context.route(
      (url) => !["127.0.0.1", "localhost"].includes(url.hostname),
      async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === sourceHost) {
          await route.fulfill({
            status: 200,
            contentType: "text/html; charset=utf-8",
            body: `<!doctype html><title>${sourcePageTitle}</title><h1>Receta original</h1>`,
          });
        } else {
          await route.abort("blockedbyclient");
        }
      },
    );
    await use(context);
  },
  app: async ({ page }, use) => {
    await use(new App(page));
  },
});
