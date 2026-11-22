import { describe, expect, it } from "vitest";
import { RECIPE_PORTIONS } from "../contracts";
import type { Library, Recipe, RecipeDraft, RecipeFilters, RecipeIngredient } from "../contracts";
import {
  convertMeasuredAmount, filterRecipes, formatMeasuredAmount, formatRational, normalizeLookupText,
  normalizeRecipe, normalizeSourceUrl, parseMeasuredAmount, parseRational, scaleIngredientLines,
  suggestTags, usesDensity,
} from "./index";

function line(ingredientId: string): RecipeIngredient {
  return { ingredientId, amount: { kind: "unspecified" } };
}

describe("exact quantities", () => {
  it.each([
    ["42", "42", "1"], ["1,25", "5", "4"], [".75", "3", "4"], ["3/6", "1", "2"],
    ["1 1/2", "3", "2"], ["1½", "3", "2"], ["2 ⅓", "7", "3"], ["2⁄3", "2", "3"],
    ["0.00000000000001", "1", "100000000000000"], ["9007199254740993", "9007199254740993", "1"],
  ])("parses and round-trips %s", (input, numerator, denominator) => {
    const quantity = parseRational(input);
    expect(quantity).toEqual({ numerator, denominator });
    expect(parseRational(formatRational(quantity))).toEqual(quantity);
  });

  it.each(["", "0", "-2", "1/0", "1 0/2", "1 3/2", "1 000", "1.234,56", "1e3", "⅔½"])(
    "rejects %j",
    (input) => expect(() => parseRational(input)).toThrow(RangeError),
  );

  it("parses and round-trips exact range endpoints", () => {
    const range = parseMeasuredAmount("½ – 1 1/3", "cup");
    expect(range.min).toEqual(parseRational("1/2"));
    expect(range.max).toEqual(parseRational("4/3"));
    expect(parseMeasuredAmount(formatMeasuredAmount(range), range.unit)).toEqual(range);
    expect(parseMeasuredAmount("2-2", "piece").max).toEqual(parseRational("2"));
    expect(() => parseMeasuredAmount("2–1", "piece")).toThrow("The range is reversed.");
    expect(() => parseMeasuredAmount("2–3–4", "piece")).toThrow(RangeError);
  });

  it("uses exact Profeco and U.S. customary factors", () => {
    const cup = parseMeasuredAmount("1", "cup");
    expect(convertMeasuredAmount(cup, "milliliter")).toEqual(parseMeasuredAmount("250", "milliliter"));
    expect(convertMeasuredAmount(parseMeasuredAmount("15", "milliliter"), "tablespoon"))
      .toEqual(parseMeasuredAmount("1", "tablespoon"));
    expect(convertMeasuredAmount(parseMeasuredAmount("1", "teaspoon"), "milliliter"))
      .toEqual(parseMeasuredAmount("5", "milliliter"));
    expect(convertMeasuredAmount(parseMeasuredAmount("1", "ounce"), "gram"))
      .toEqual(parseMeasuredAmount("28.349523125", "gram"));
    expect(convertMeasuredAmount(parseMeasuredAmount("1", "fluidOunceUs"), "milliliter"))
      .toEqual(parseMeasuredAmount("29.5735295625", "milliliter"));
  });

  it("converts through a specific density and keeps incompatible units distinct", () => {
    const density = { gramsPerMilliliter: parseRational("0,8"), source: "Test" };
    const volume = parseMeasuredAmount("100–110", "milliliter");
    const mass = parseMeasuredAmount("80–88", "gram");
    expect(usesDensity(volume.unit, mass.unit)).toBe(true);
    expect(convertMeasuredAmount(volume, mass.unit)).toBeUndefined();
    expect(convertMeasuredAmount(volume, mass.unit, density)).toEqual(mass);
    expect(convertMeasuredAmount(mass, volume.unit, density)).toEqual(volume);
    const pinch = parseMeasuredAmount("2", "pinch");
    expect(convertMeasuredAmount(pinch, "pinch")).toEqual(pinch);
    expect(convertMeasuredAmount(pinch, "bunch", density)).toBeUndefined();
  });
});

describe("recipe normalization", () => {
  const draft: RecipeDraft = {
    name: " Albóndigas ",
    enteredPortions: 2,
    ingredients: [
      { ingredientId: "meat", amount: parseMeasuredAmount("500", "gram") },
      { ingredientId: "egg", amount: parseMeasuredAmount("2", "piece") },
      { ingredientId: "chile", amount: parseMeasuredAmount("1–1½", "piece") },
      { ingredientId: "salt", amount: { kind: "qualitative", text: "al gusto" } },
      line("onion"),
    ],
    categoryIds: ["main", "mexican", "main"],
    tags: ["meat", "meat"],
    steps: [" Mezcla ", "", "Cocina"],
  };

  it("normalizes from two to four portions and can recompute exact quantities", () => {
    const recipe = normalizeRecipe(draft, "recipe");
    const [mass, eggs, chiles, salt, onion] = recipe.ingredients;
    expect(mass.amount.kind === "measured" && convertMeasuredAmount(mass.amount, "kilogram"))
      .toEqual(parseMeasuredAmount("1", "kilogram"));
    expect(eggs.amount).toEqual(parseMeasuredAmount("4", "piece"));
    expect(chiles.amount).toEqual(parseMeasuredAmount("2–3", "piece"));
    expect([salt, onion]).toEqual(draft.ingredients.slice(3));
    expect(recipe).toMatchObject({
      name: "Albóndigas", categoryIds: ["main", "mexican"], tags: ["meat"], steps: [" Mezcla ", "Cocina"],
    });

    for (const portions of [3, 7, 2, 12, 2]) {
      const scaled = scaleIngredientLines(recipe.ingredients, RECIPE_PORTIONS, portions);
      expect(scaleIngredientLines(scaled, portions, RECIPE_PORTIONS)).toEqual(recipe.ingredients);
      if (portions === 2) expect(scaled).toEqual(draft.ingredients);
    }
    expect(recipe.ingredients[0].amount).toEqual(parseMeasuredAmount("1000", "gram"));
  });

  it.each([0, -2, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid portion count %s",
    (enteredPortions) => expect(() => normalizeRecipe({ ...draft, enteredPortions }, "recipe")).toThrow("Portions"),
  );

  it("validates URL syntax and allows blank input", () => {
    expect(normalizeSourceUrl("  ")).toBeUndefined();
    expect(normalizeSourceUrl(" HTTPS://ejemplo.mx/recetas?x=1 ")).toBe("https://ejemplo.mx/recetas?x=1");
    for (const invalid of [
      "javascript:alert(1)", "ftp://ejemplo.mx", "//ejemplo.mx", "www.ejemplo.mx", "https:///ejemplo.mx",
      "https://", "https://anfitrion@ejemplo.mx", "https://ejemplo.mx/con espacio", "https://ex\nample.com",
    ]) {
      expect(() => normalizeSourceUrl(invalid)).toThrow("Source URL");
    }
  });
});

describe("recipe discovery", () => {
  const ingredients = [
    { id: "chicken", name: "Pollo", classification: "meat" },
    { id: "breast", name: "Pechuga de pollo", parentId: "chicken", classification: "meat" },
    { id: "cutlet", name: "Milanesa de pollo", parentId: "breast", classification: "meat" },
    { id: "chile", name: "Chile ancho", classification: "plant" },
    { id: "egg", name: "Huevo", classification: "egg" },
    { id: "fish", name: "Pescado", classification: "fish" },
    { id: "shrimp", name: "Camarón", classification: "shellfish" },
    { id: "unknown", name: "Mezcla de la casa" },
  ] satisfies Library["ingredients"];

  it("matches name and groups together, accepts alternatives within each group, and includes descendants", () => {
    const target: Recipe = {
      id: "target", name: "Milanesa   de Polló", steps: [],
      categoryIds: ["main", "mexican"], ingredients: [line("cutlet")], tags: ["meat"],
    };
    const library: Library = {
      ingredients,
      categories: [
        { id: "main", name: "Platillos fuertes", kind: "dish_type" },
        { id: "mexican", name: "Mexicana", kind: "cuisine" },
        { id: "chinese", name: "China", kind: "cuisine" },
      ],
      recipes: [
        target,
        { ...target, id: "other-cuisine", categoryIds: ["main", "chinese"] },
        { ...target, id: "unconfirmed", tags: [] },
        { ...target, id: "other-ingredient", ingredients: [line("chile")] },
        { ...target, id: "other-dish-type", categoryIds: ["mexican"] },
      ],
    };
    const filters: RecipeFilters = {
      query: "  MILANESA de POLLO ", dishTypeIds: ["main"], cuisineIds: ["mexican"],
      tagIds: ["vegan", "meat"], ingredientIds: ["chicken", "egg"],
    };
    expect(normalizeLookupText("  Ázucar\u00a0 Blanca ")).toBe("azucar blanca");
    expect(filterRecipes(library, filters)).toEqual([target]);
    expect(filterRecipes(library, { ...filters, ingredientIds: ["cutlet"] })).toEqual([target]);
    expect(filterRecipes(library, { ...filters, cuisineIds: ["deleted"], ingredientIds: ["chicken", "deleted"] }))
      .toEqual(filterRecipes(library, { ...filters, cuisineIds: [], ingredientIds: ["chicken"] }));
  });

  it("requires known classifications for dietary suitability and separates fish from shellfish", () => {
    expect(suggestTags([], ingredients)).toEqual([]);
    expect(suggestTags([line("chile"), line("missing")], ingredients)).toEqual([]);
    expect(suggestTags([line("chile"), line("unknown")], ingredients)).toEqual([]);
    expect(suggestTags([line("chile")], ingredients)).toEqual(["vegan", "vegetarian"]);
    expect(suggestTags([line("chile"), line("egg")], ingredients)).toEqual(["vegetarian"]);
    expect(suggestTags([line("fish"), line("unknown")], ingredients)).toEqual(["fish"]);
    expect(suggestTags([line("cutlet"), line("fish"), line("shrimp")], ingredients)).toEqual([
      "meat", "fish", "shellfish",
    ]);
  });
});
