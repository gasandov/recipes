import { normalizeSourceUrl } from "../../domain";
import type { CapturedRecipe } from "../contract";
import type { PageExtraction } from "../../../supabase/functions/import-recipe/protocol.ts";
import { parseIngredientLine } from "./ingredient-line";
import { parseRecipeText } from "./text-sections";
import { parseYield } from "./yield";

export type DraftResult = {
  draft: CapturedRecipe;
  /** True when at least one ingredient or step was found. False means the app should offer manual entry. */
  usable: boolean;
};

const originNotice = {
  "json-ld": "Los datos vienen de la receta estructurada (schema.org) que publica la página.",
  microdata: "Los datos vienen del marcado de receta (schema.org) de la página.",
  "page-text": "Los datos vienen del texto visible de la página, no de una receta estructurada.",
} as const;

/** Source link kept exactly as the user gave it, so a redirect or tracking-free copy never replaces it. */
export function safeSourceUrl(value: string | undefined): string | undefined {
  try {
    return value ? normalizeSourceUrl(value) : undefined;
  } catch {
    return undefined;
  }
}

function buildDraft(input: {
  name?: string;
  portions?: number;
  yieldNote?: string;
  ingredientLines: string[];
  steps: string[];
  sourceUrl?: string;
  origin: string;
}): DraftResult {
  const parsed = input.ingredientLines.map(parseIngredientLine);
  const ingredients = parsed.map((line) => line.ingredient);
  const unsupported = parsed.filter((line) => line.flag === "unsupported-unit").length;
  const unquantified = parsed.filter((line) => line.ingredient.amount.kind === "unspecified").length;

  const notices = [input.origin];
  if (input.yieldNote) notices.push(input.yieldNote);
  if (unquantified > 0) {
    notices.push(
      `${unquantified} ${unquantified === 1 ? "ingrediente quedó" : "ingredientes quedaron"} sin cantidad. ` +
        "Se conservó el texto original para que lo completes.",
    );
  }
  if (unsupported > 0) {
    notices.push("Algunas cantidades usan unidades que Recetario no maneja (por ejemplo libras). Revísalas.");
  }
  if (ingredients.length === 0) notices.push("No se encontraron ingredientes.");
  if (input.steps.length === 0) notices.push("No se encontraron pasos.");

  return {
    usable: ingredients.length > 0 || input.steps.length > 0,
    draft: {
      name: input.name,
      portions: input.portions,
      ingredients,
      steps: input.steps,
      sourceUrl: input.sourceUrl,
      notices,
    },
  };
}

/** Maps what the function read from a page to an editable draft. Missing values stay undefined. */
export function draftFromExtraction(extraction: PageExtraction, sourceUrl: string | undefined): DraftResult {
  const url = safeSourceUrl(sourceUrl);
  if (extraction.origin === "json-ld" || extraction.origin === "microdata") {
    const stated = parseYield(extraction.yieldText);
    return buildDraft({
      name: extraction.title,
      portions: stated.portions,
      yieldNote: stated.note,
      ingredientLines: extraction.ingredients,
      steps: extraction.steps,
      sourceUrl: url,
      origin: originNotice[extraction.origin],
    });
  }

  const text = parseRecipeText(extraction.text ?? extraction.description ?? "");
  const result = buildDraft({
    name: extraction.title ?? text.name,
    portions: text.portions,
    yieldNote: text.yieldNote,
    ingredientLines: text.ingredients,
    steps: text.steps,
    sourceUrl: url,
    origin: originNotice["page-text"],
  });
  return result;
}

/** Maps text the user pasted, such as a social caption, to a draft with the original link attached. */
export function draftFromPastedText(text: string, sourceUrl: string | undefined): DraftResult {
  const parsed = parseRecipeText(text);
  return buildDraft({
    name: parsed.name,
    portions: parsed.portions,
    yieldNote: parsed.yieldNote,
    ingredientLines: parsed.ingredients,
    steps: parsed.steps,
    sourceUrl: safeSourceUrl(sourceUrl),
    origin: "Los datos vienen del texto que pegaste.",
  });
}

/** An empty draft that keeps the link and says why nothing was read. It opens the manual editor. */
export function manualDraft(sourceUrl: string | undefined, reason: string): CapturedRecipe {
  return { ingredients: [], steps: [], sourceUrl: safeSourceUrl(sourceUrl), notices: [reason] };
}
