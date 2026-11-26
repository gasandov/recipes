import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PageExtraction } from "../../../supabase/functions/import-recipe/protocol.ts";
import { draftFromExtraction, draftFromPastedText } from "./map";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const page = (extra: Partial<PageExtraction>): PageExtraction => ({
  origin: "json-ld", finalUrl: "https://redirigido.example/final", ingredients: [], steps: [], media: [], ...extra,
});
const link = "https://origen.example/receta?utm=1";

describe("draftFromExtraction", () => {
  it("maps structured data to an editable draft and keeps the user's link", () => {
    const { draft, usable } = draftFromExtraction(page({
      title: "Pollo en salsa verde & arroz", yieldText: "6 porciones",
      ingredients: ["500 g de pechuga de pollo", "1 1/2 tazas de salsa verde", "Sal al gusto", "2 dientes de ajo"],
      steps: ["Pollo", "Cuece el pollo.", "Deshebra el pollo.", "Calienta la salsa.", "Sirve caliente."],
    }), link);
    expect(usable).toBe(true);
    expect(draft.name).toBe("Pollo en salsa verde & arroz");
    expect(draft.portions).toBe(6);
    expect(draft.sourceUrl).toBe(link);
    expect(draft.ingredients.map((line) => line.name)).toEqual(["pechuga de pollo", "salsa verde", "Sal", "dientes de ajo"]);
    expect(draft.ingredients[2].amount).toEqual({ kind: "qualitative", text: "al gusto" });
    expect(draft.ingredients.every((line) => line.originalText)).toBe(true);
    expect(draft.steps).toHaveLength(5);
    expect(draft.notices?.[0]).toContain("receta estructurada");
  });

  it("leaves portions pending when the page does not state them", () => {
    const { draft } = draftFromExtraction(page({ title: "Salsa", yieldText: "1 frasco", ingredients: ["Chile"], steps: ["Muele."] }), link);
    expect(draft.portions).toBeUndefined();
    expect(draft.notices?.join(" ")).toContain("1 frasco");
    expect(draft.notices?.join(" ")).toContain("sin cantidad");
  });

  it("reads the visible text of a page without structured data", () => {
    const { draft, usable } = draftFromExtraction(page({
      origin: "page-text", title: "Guacamole de la abuela", description: "Un guacamole sencillo.",
      text: "Guacamole de la abuela\nRinde: 4 porciones\nIngredientes\n3 aguacates\n1/2 cebolla picada\nSal al gusto\nPreparación\nMachaca los aguacates.\nMezcla con la cebolla y la sal.",
    }), link);
    expect(usable).toBe(true);
    expect(draft.name).toBe("Guacamole de la abuela");
    expect(draft.portions).toBe(4);
    expect(draft.ingredients.map((line) => line.originalText)).toEqual(["3 aguacates", "1/2 cebolla picada", "Sal al gusto"]);
    expect(draft.steps).toEqual(["Machaca los aguacates.", "Mezcla con la cebolla y la sal."]);
    expect(draft.notices?.[0]).toContain("texto visible");
  });

  it("reports pages with nothing readable as unusable but keeps what it knows", () => {
    const result = draftFromExtraction(page({ origin: "none", title: "Receta cargada con JavaScript" }), link);
    expect(result.usable).toBe(false);
    expect(result.draft.ingredients).toEqual([]);
    expect(result.draft.sourceUrl).toBe(link);
  });
});

describe("draftFromPastedText", () => {
  it("reads a social caption with emoji headings, numbering and hashtags", () => {
    const { draft, usable } = draftFromPastedText(fixture("instagram-caption.txt"), "https://www.instagram.com/reel/abc/");
    expect(usable).toBe(true);
    expect(draft.name).toBe("Tacos de papa con chorizo");
    expect(draft.portions).toBe(4);
    expect(draft.sourceUrl).toBe("https://www.instagram.com/reel/abc/");
    expect(draft.ingredients.map((line) => line.originalText)).toEqual([
      "3 papas medianas", "200 g de chorizo", "1/2 taza de queso rallado", "Sal al gusto", "1 lb de tortillas", "- 2 jitomates",
    ].map((text) => text.replace(/^- /, "")));
    expect(draft.ingredients[4].amount).toEqual({ kind: "unspecified" });
    expect(draft.notices?.join(" ")).toContain("libras");
    expect(draft.steps).toEqual([
      "Cuece las papas y pélalas.", "Fríe el chorizo y mezcla con la papa.", "Sirve en tortillas calientes.",
    ]);
  });

  it("does not guess when the text has no recipe headings", () => {
    const { draft, usable } = draftFromPastedText("Qué rico quedó hoy 😍 mañana más", "https://www.instagram.com/p/x/");
    expect(usable).toBe(false);
    expect(draft.ingredients).toEqual([]);
    expect(draft.steps).toEqual([]);
  });

  it("ignores a source that is not a valid link", () => {
    expect(draftFromPastedText("Ingredientes\n2 huevos", "no-url").draft.sourceUrl).toBeUndefined();
  });
});
