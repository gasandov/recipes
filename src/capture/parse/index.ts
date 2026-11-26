import type { CapturedIngredient, CapturedRecipe } from "../contract";
import { parseIngredients, opensStep } from "./ingredients";
import { startsQuantity } from "./quantity";
import { extractName, extractPortions, findMarkers, hasVerb } from "./sections";
import { parseSteps } from "./steps";
import { capitalize, isBreak, render, tokenize } from "./tokens";
import type { Token } from "./tokens";

type Draft = {
  ingredients: CapturedIngredient[];
  steps: string[];
  ingredientNotices: string[];
  name?: string;
  inferredName: boolean;
  ignored: number;
};

function splitChunks(tokens: readonly Token[]): Token[][] {
  const chunks: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    if (isBreak(token)) {
      if (current.length > 0) chunks.push(current);
      current = [];
    } else current.push(token);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

const maxInferredNameWords = 8;

function addIngredients(draft: Draft, tokens: readonly Token[]): void {
  const scan = parseIngredients(tokens, draft.ingredientNotices);
  draft.ingredients.push(...scan.ingredients);
  if (scan.rest.length > 0) draft.steps.push(...parseSteps(scan.rest));
}

function inferName(draft: Draft, words: readonly Token[]): boolean {
  const trimmed = [...words];
  while (trimmed.length > 0 && ["y", "e", "con", "que"].includes(trimmed[trimmed.length - 1].key)) trimmed.pop();
  while (trimmed.length > 0 && ["el", "la", "los", "las", "un", "una", "unos", "unas", "mi", "mis"].includes(trimmed[0].key)) {
    trimmed.shift();
  }
  if (trimmed.length === 0) return false;
  draft.name = capitalize(render(trimmed));
  draft.inferredName = true;
  return true;
}

/** Text with no heading: decide per clause whether it is a title, an ingredient list, or a step. */
function addUnlabeled(draft: Draft, tokens: readonly Token[]): void {
  for (const chunk of splitChunks(tokens)) {
    const words = chunk.filter((token) => token.kind !== "comma");
    if (words.length === 0) continue;
    if (opensStep(chunk, 0)) {
      draft.steps.push(...parseSteps(chunk));
      continue;
    }

    const first = chunk.findIndex((_, index) => startsQuantity(chunk, index));
    const canName = draft.name === undefined && draft.ingredients.length === 0 && draft.steps.length === 0;
    const prefix = first > 0 ? chunk.slice(0, first) : [];
    const prefixIsTitle = prefix.length > 0 && prefix.length <= maxInferredNameWords && !hasVerb(prefix)
      && !prefix.some((token) => token.key === "y" || token.kind === "comma")
      && !/\bal gusto\s*$/u.test(prefix.map((token) => token.key).join(" "));

    if (first === 0) addIngredients(draft, chunk);
    else if (first > 0 && canName && prefixIsTitle && inferName(draft, prefix)) addIngredients(draft, chunk.slice(first));
    else if (first > 0) addIngredients(draft, chunk);
    else if (canName && words.length <= maxInferredNameWords && !hasVerb(words) && inferName(draft, chunk)) continue;
    else if (words.length <= 5 || /al gusto\s*$/u.test(words.map((token) => token.key).join(" "))) {
      addIngredients(draft, chunk);
    } else if (hasVerb(words)) draft.steps.push(...parseSteps(chunk));
    else draft.ignored++;
  }
}

/**
 * Turns a Mexican Spanish dictation into a draft. Quantities are exact; anything missing or uncertain is left unset
 * and described in `notices` so the user can review it. Nothing is logged or stored.
 */
export function parseRecipeTranscript(text: string): CapturedRecipe {
  const draft: Draft = { ingredients: [], steps: [], ingredientNotices: [], inferredName: false, ignored: 0 };
  const header: string[] = [];

  let tokens = tokenize(text);
  const portions = extractPortions(tokens);
  tokens = portions.tokens;

  const firstMarker = findMarkers(tokens)[0];
  const named = extractName(tokens, firstMarker?.start ?? tokens.length);
  tokens = named.tokens;
  draft.name = named.name;

  const markers = findMarkers(tokens);
  const preambleEnd = markers[0]?.start ?? tokens.length;
  addUnlabeled(draft, tokens.slice(0, preambleEnd));

  markers.forEach((marker, index) => {
    const region = tokens.slice(marker.end, markers[index + 1]?.start ?? tokens.length);
    if (marker.type === "ingredients") addIngredients(draft, region);
    else draft.steps.push(...parseSteps(region));
  });

  if (draft.name === undefined) {
    header.push("No detectamos el nombre de la receta. Escríbelo antes de guardar.");
  } else if (draft.inferredName) {
    header.push(`Tomamos «${draft.name}» como nombre porque fue lo primero que dijiste. Confírmalo.`);
  }
  if (portions.portions === undefined) {
    header.push(portions.ambiguous
      ? `Dijiste «${portions.ambiguous}», que no es una cantidad exacta de porciones. Indica cuántas rinde.`
      : "No mencionaste cuántas porciones rinde la receta. Confírmalo antes de guardar.");
  }

  const notices = [...header, ...draft.ingredientNotices];
  const unspecified = draft.ingredients.filter((item) => item.amount.kind === "unspecified").map((item) => item.name);
  if (unspecified.length > 0) {
    notices.push(`Sin cantidad: ${unspecified.join(", ")}. Agrega una cantidad o déjalos así.`);
  }
  if (draft.ingredients.length === 0) notices.push("No detectamos ingredientes. Agrégalos en el editor.");
  if (draft.steps.length === 0) notices.push("No detectamos pasos de preparación. Agrégalos en el editor.");
  if (draft.ignored > 0) {
    notices.push(draft.ignored === 1
      ? "Omitimos una frase que no parecía un ingrediente ni un paso."
      : `Omitimos ${draft.ignored} frases que no parecían ingredientes ni pasos.`);
  }

  const recipe: CapturedRecipe = { ingredients: draft.ingredients, steps: draft.steps };
  if (draft.name !== undefined) recipe.name = draft.name;
  if (portions.portions !== undefined) recipe.portions = portions.portions;
  if (notices.length > 0) recipe.notices = notices;
  return recipe;
}
