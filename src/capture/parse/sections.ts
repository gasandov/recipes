import { opensStep } from "./ingredients";
import { portionNouns, stepVerbs } from "./lexicon";
import { readQuantity } from "./quantity";
import { capitalize, isBreak, keysAt, render } from "./tokens";
import type { Token } from "./tokens";

export type PortionsResult = {
  tokens: Token[];
  portions?: number;
  /** Text of a portion statement that could not be turned into one whole number. */
  ambiguous?: string;
};

const portionLead = new Set(["para", "rinde", "rinden", "sale", "salen", "sirve", "sirven", "alcanza", "alcanzan",
  "da", "dan", "hace", "hacen", "ideal", "es"]);
const portionVerbs = new Set(["rinde", "rinden", "sale", "salen", "sirve", "sirven", "alcanza", "alcanzan", "da", "dan",
  "hace", "hacen"]);

/** Finds the first yield statement such as `para cuatro personas` or `rinde 6 porciones` and removes it. */
export function extractPortions(tokens: readonly Token[]): PortionsResult {
  for (let noun = 1; noun < tokens.length; noun++) {
    if (!portionNouns.has(tokens[noun].key) || tokens[noun + 1]?.key === "de") continue;
    for (let start = Math.max(0, noun - 8); start < noun; start++) {
      const quantity = readQuantity(tokens, start);
      if (!quantity || quantity.next !== noun || quantity.unit !== undefined) continue;

      let from = start;
      let sawVerb = false;
      while (from > 0 && portionLead.has(tokens[from - 1].key)) {
        if (portionVerbs.has(tokens[from - 1].key)) sawVerb = true;
        from--;
      }
      if (sawVerb && tokens[from - 1]?.key === "que") from--;
      // `dos porciones y media` is not a whole number of portions.
      const halfAfter = tokens[noun + 1]?.key === "y" && /^medi[oa]$/u.test(tokens[noun + 2]?.key ?? "");
      const end = halfAfter ? noun + 3 : noun + 1;
      const rest = [...tokens.slice(0, from), ...tokens.slice(end)];
      if (halfAfter) return { tokens: rest, ambiguous: render(tokens.slice(start, end)) };
      const whole = quantity.max === undefined && quantity.min.denominator === "1" ? Number(quantity.min.numerator) : undefined;
      if (whole !== undefined && Number.isSafeInteger(whole) && whole > 0) return { tokens: rest, portions: whole };
      return { tokens: rest, ambiguous: render(tokens.slice(start, noun + 1)) };
    }
  }
  return { tokens: [...tokens] };
}

export type Marker = { type: "ingredients" | "steps"; start: number; end: number };

const ingredientMarkers: string[][] = [
  ["ingredientes"], ["vamos", "a", "necesitar"], ["vas", "a", "necesitar"], ["necesitamos"], ["necesitaremos"],
  ["necesito"], ["necesitas"], ["necesitan"], ["se", "necesita"], ["se", "necesitan"], ["lleva"], ["llevan"],
  ["usamos"], ["utilizamos"], ["usaremos"], ["utilizaremos"],
];
const headingMarkers: string[][] = [
  ["modo", "de", "preparacion"], ["forma", "de", "preparacion"], ["preparacion"], ["procedimiento"], ["instrucciones"],
  ["elaboracion"], ["pasos"], ["manos", "a", "la", "obra"], ["como", "se", "prepara"], ["como", "se", "hace"],
];
const softStepMarkers: string[][] = [
  ["vamos", "a", "empezar"], ["vamos", "a", "comenzar"], ["para", "empezar"], ["para", "comenzar"], ["comenzamos"],
  ["empezamos"], ["primero"],
];
const markerTail: string[][] = [["es", "la", "siguiente"], ["son", "los", "siguientes"], ["son"], ["los", "siguientes"],
  ["siguientes"], ["ingredientes"]];

/** A heading must not sit inside a preparation sentence, such as `mezcla los ingredientes secos`. */
function insideStep(tokens: readonly Token[], index: number): boolean {
  let start = index;
  while (start > 0 && !isBreak(tokens[start - 1])) start--;
  return start < index && opensStep(tokens, start);
}

function matchAny(tokens: readonly Token[], index: number, table: string[][]): number {
  for (const keys of table) if (keysAt(tokens, index, keys)) return keys.length;
  return 0;
}

/** Finds headings such as `ingredientes`, `necesitamos`, or `paso uno` and the spoken order of the sections. */
export function findMarkers(tokens: readonly Token[]): Marker[] {
  const markers: Marker[] = [];
  let inSteps = false;
  for (let i = 0; i < tokens.length; i++) {
    let type: Marker["type"] | undefined;
    let length = 0;

    const heading = matchAny(tokens, i, headingMarkers);
    if (heading) {
      type = "steps";
      length = heading;
    } else if (!inSteps) {
      const soft = matchAny(tokens, i, softStepMarkers);
      if (soft) {
        type = "steps";
        length = soft;
      } else if (tokens[i].key === "paso" && tokens[i + 1] && readQuantity(tokens, i + 1)) {
        type = "steps";
        length = 1 + (readQuantity(tokens, i + 1)!.next - (i + 1));
      }
    }
    if (type === undefined) {
      const ingredient = matchAny(tokens, i, ingredientMarkers);
      if (ingredient && (!inSteps || tokens[i].key === "ingredientes") && !insideStep(tokens, i)) {
        type = "ingredients";
        length = ingredient;
      }
    }
    if (type === undefined) continue;

    let end = i + length;
    for (;;) {
      const next = tokens[end];
      if (next && (next.kind === "colon" || next.kind === "comma")) {
        end++;
        continue;
      }
      const tail = matchAny(tokens, end, markerTail);
      if (tail === 0) break;
      end += tail;
    }
    markers.push({ type, start: i, end });
    inSteps = type === "steps";
    i = end - 1;
  }
  return markers;
}

const nameMarkers: string[][] = [
  ["receta", ":"], ["nombre", ":"],
  ["receta", "de"], ["receta", "del"], ["receta", "para"], ["se", "llama"], ["se", "llaman"],
  ["vamos", "a", "preparar"], ["vamos", "a", "hacer"], ["vamos", "a", "cocinar"], ["vamos", "a", "elaborar"],
  ["voy", "a", "preparar"], ["voy", "a", "hacer"], ["voy", "a", "cocinar"], ["hoy", "preparamos"],
  ["hoy", "hacemos"], ["hoy", "cocinamos"], ["preparamos"], ["el", "platillo", "es"], ["el", "nombre", "es"],
  ["el", "plato", "es"],
];
const articles = new Set(["el", "la", "los", "las", "un", "una", "unos", "unas", "unas", "mi", "nuestra", "nuestro"]);
const nameTrailing = new Set(["y", "e", "con", "que", "para", "de"]);

export type NameResult = { tokens: Token[]; name?: string };

/** Reads a spoken title such as `receta de pozole rojo`, only before the first section heading. */
export function extractName(tokens: readonly Token[], preambleEnd: number): NameResult {
  for (let i = 0; i < preambleEnd; i++) {
    const length = matchAny(tokens, i, nameMarkers);
    if (!length) continue;
    let end = i + length;
    const start = end;
    while (end < preambleEnd && end - start < 10) {
      const token = tokens[end];
      if (isBreak(token) || token.kind === "comma" || token.key === "que") break;
      end++;
    }
    let words = tokens.slice(start, end);
    while (words.length && articles.has(words[0].key)) words = words.slice(1);
    while (words.length && nameTrailing.has(words[words.length - 1].key)) words = words.slice(0, -1);
    if (words.length === 0) continue;
    const rest = [...tokens.slice(0, i), ...tokens.slice(end)];
    return { tokens: rest, name: capitalize(render(words)) };
  }
  return { tokens: [...tokens] };
}

export function hasVerb(tokens: readonly Token[]): boolean {
  return tokens.some((token) => stepVerbs.has(token.key));
}
