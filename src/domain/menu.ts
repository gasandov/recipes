import { RECIPE_PORTIONS } from "../contracts";
import type { Ingredient, MenuEntry, Recipe } from "../contracts";
import { normalizeAmount } from "./measurements";
import { nonblank, normalizeDensity, validatePortions } from "./recipes";

export function normalizeMenuEntry(entry: MenuEntry): MenuEntry {
  validatePortions(entry.portions);
  return {
    id: nonblank(entry.id, "Menu entry ID"),
    sourceRecipeId: nonblank(entry.sourceRecipeId, "Source recipe ID"),
    name: nonblank(entry.name, "Menu entry name"),
    portions: entry.portions,
    ingredients: entry.ingredients.map((line) => ({
      ingredientId: nonblank(line.ingredientId, "Ingredient ID"),
      name: nonblank(line.name, "Ingredient name"),
      amount: normalizeAmount(line.amount),
      ...(line.density === undefined ? {} : { density: normalizeDensity(line.density) }),
    })),
  };
}

/** Copies the saved four-portion quantities and current ingredient metadata into a new batch. */
export function createMenuEntry(recipe: Recipe, ingredients: Ingredient[], id: string): MenuEntry {
  const catalog = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));

  return normalizeMenuEntry({
    id,
    sourceRecipeId: recipe.id,
    name: recipe.name,
    portions: RECIPE_PORTIONS,
    ingredients: recipe.ingredients.map((line) => {
      const ingredient = catalog.get(line.ingredientId);
      if (!ingredient) throw new RangeError("A recipe ingredient is missing from the catalog.");
      return { ...line, name: ingredient.name, density: ingredient.density };
    }),
  });
}
