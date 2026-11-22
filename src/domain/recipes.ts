import { RECIPE_PORTIONS, tagIds } from "../contracts";
import type { Density, Recipe, RecipeDraft, RecipeIngredient } from "../contracts";
import { normalizeAmount, scaleMeasuredAmount } from "./measurements";
import { normalizeRational, rational } from "./rational";

export function nonblank(text: string, field: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new RangeError(`${field} is required.`);
  return trimmed;
}

export function normalizeSourceUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const invalid = () => new RangeError("Source URL must be an absolute HTTP or HTTPS URL.");
  if (!/^https?:\/\/[^/]/i.test(trimmed) || /[\s\\]/u.test(trimmed)) throw invalid();
  if ([...trimmed].some((character) => character.charCodeAt(0) < 33 || character.charCodeAt(0) === 127)) {
    throw invalid();
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw invalid();
  }
  if (!url.hostname || url.username || url.password) throw invalid();
  return url.href;
}

export function normalizeDensity(density: Density): Density {
  return {
    gramsPerMilliliter: normalizeRational(density.gramsPerMilliliter),
    source: nonblank(density.source, "Density source"),
  };
}

export function validatePortions(portions: number): void {
  if (!Number.isSafeInteger(portions) || portions <= 0) {
    throw new RangeError("Portions must be a positive safe integer.");
  }
}

export function scaleIngredientLines(
  lines: RecipeIngredient[],
  fromPortions: number,
  toPortions: number,
): RecipeIngredient[] {
  validatePortions(fromPortions);
  validatePortions(toPortions);
  const factor = rational(BigInt(toPortions), BigInt(fromPortions));

  return lines.map((line) => {
    const amount = normalizeAmount(line.amount);
    return {
      ingredientId: nonblank(line.ingredientId, "Ingredient ID"),
      amount: amount.kind === "measured" ? scaleMeasuredAmount(amount, factor) : amount,
    };
  });
}

export function normalizeRecipe(draft: RecipeDraft, id: string): Recipe {
  const name = nonblank(draft.name, "Recipe name");
  const sourceUrl = normalizeSourceUrl(draft.sourceUrl ?? "");
  // Keep the chosen units in storage so a display conversion never changes a saved recipe.
  const ingredients = scaleIngredientLines(draft.ingredients, draft.enteredPortions, RECIPE_PORTIONS);
  const categoryIds = [...new Set(draft.categoryIds)];
  const tags = [...new Set(draft.tags)];
  if (!tags.every((tag) => tagIds.includes(tag))) throw new RangeError("The recipe contains an unknown tag.");

  return {
    id,
    name,
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    ingredients,
    steps: draft.steps.filter((step) => step.trim()),
    categoryIds,
    tags,
  };
}
