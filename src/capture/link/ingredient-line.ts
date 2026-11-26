import type { Amount, UnitId } from "../../contracts";
import { parseMeasuredAmount } from "../../domain";
import type { CapturedIngredient } from "../contract";

/** Why a line could not be turned into a measured amount. The text is always kept. */
export type LineFlag = "unsupported-unit" | "unparsed";

export type ParsedIngredientLine = { ingredient: CapturedIngredient; flag?: LineFlag };

const vulgar = "¼½¾⅓⅔⅛⅜⅝⅞";
const number = String.raw`(?:\d+\s+\d+\s*[/⁄]\s*\d+|\d+\s*[/⁄]\s*\d+|\d*\s*[${vulgar}]|\d+(?:[.,]\d+)?)`;
const quantity = new RegExp(String.raw`^(${number})(?:\s*(?:-|–|—)\s*(${number})|\s+(?:a|to)\s+(${number})(?=\s|$))?`, "iu");

const unitTokens: [UnitId, string][] = [
  ["fluidOunceUs", String.raw`fl\.?\s*oz|onzas?\s+fluidas?|fluid\s+ounces?`],
  ["teaspoon", String.raw`cucharaditas?|cdtas?|cdita|tsp|teaspoons?`],
  ["tablespoon", String.raw`cucharadas?|cdas?|tbsp|tablespoons?`],
  ["cup", String.raw`tazas?|tz|cups?`],
  ["kilogram", String.raw`kilogramos?|kilos?|kgs?`],
  ["gram", String.raw`gramos?|grs?|g|grams?`],
  ["milliliter", String.raw`mililitros?|mls?`],
  ["liter", String.raw`litros?|lts?|l`],
  ["ounce", String.raw`onzas?|oz|ounces?`],
  ["piece", String.raw`piezas?|pzas?|pz|pcs?|pieces?`],
  ["pinch", String.raw`pizcas?|pinch(?:es)?`],
  ["bunch", String.raw`manojos?|ramos?|bunch(?:es)?`],
];
const unitPatterns = unitTokens.map(([unit, tokens]) => [unit, new RegExp(String.raw`^(?:${tokens})\.?(?=\s|$|\()`, "iu")] as const);

// Measures the app has no unit for. Guessing a conversion would invent data, so these stay pending.
const unsupportedUnit = /^(?:libras?|lbs?|pounds?|galón|galon|galones|gallons?|pintas?|pints?|quarts?|cuartos?|litros? americanos?)\b\.?(?=\s|$)/iu;

const wordNumbers: Record<string, string> = {
  un: "1", uno: "1", una: "1", dos: "2", tres: "3", cuatro: "4", cinco: "5", seis: "6", siete: "7", ocho: "8",
  nueve: "9", diez: "10", media: "1/2", medio: "1/2",
};
const wordQuantity = new RegExp(String.raw`^(${Object.keys(wordNumbers).join("|")})(?=\s)`, "iu");

const tasteWords = /\b(?:al gusto|a gusto|to taste|c\.?\s?s\.?|cantidad suficiente)\b\.?/iu;
const leadingNoise = /^[\s\-–—•*·▢☐☑✔✓✅▪●○◦>+\u{1F300}-\u{1FAFF}☀-➿]+/u;

function cleanName(text: string): string {
  return text
    .trim()
    .replace(/^(?:de|of)\s+/iu, "")
    .replace(/^[\s,;:.\-–]+|[\s,;:.]+$/gu, "")
    .replace(/\s{2,}/g, " ");
}

function measured(min: string, max: string | undefined, unit: UnitId): Amount | undefined {
  try {
    return parseMeasuredAmount(max ? `${min}-${max}` : min, unit);
  } catch {
    return undefined;
  }
}

/**
 * Reads one ingredient line in Spanish or English.
 * Recognized amounts become exact measured values. Anything else keeps its text and a pending amount,
 * so the editor can ask for the missing information instead of guessing.
 */
export function parseIngredientLine(line: string): ParsedIngredientLine {
  const original = line.trim();
  const text = original.replace(leadingNoise, "").replace(/\s+/g, " ").trim();
  const ingredient = (name: string, amount: Amount): CapturedIngredient => ({ name, amount, originalText: original });
  const pending = (flag: LineFlag): ParsedIngredientLine => ({ ingredient: ingredient(text, { kind: "unspecified" }), flag });

  if (!text) return pending("unparsed");

  let min: string | undefined;
  let max: string | undefined;
  let rest = text;

  const numeric = quantity.exec(text);
  if (numeric) {
    min = numeric[1].replace(",", ".");
    max = (numeric[2] ?? numeric[3])?.replace(",", ".");
    rest = text.slice(numeric[0].length).trimStart();
  } else {
    const word = wordQuantity.exec(text);
    if (word) {
      min = wordNumbers[word[1].toLowerCase()];
      rest = text.slice(word[0].length).trimStart();
    }
  }

  if (min === undefined) {
    // "Una pizca de sal" has no number, and "sal al gusto" has no amount at all.
    const bare = unitPatterns.find(([, pattern]) => pattern.test(text));
    if (bare?.[0] === "pinch") {
      const match = bare[1].exec(text);
      const amount = measured("1", undefined, "pinch");
      const name = cleanName(text.slice(match?.[0].length ?? 0));
      if (amount && name) return { ingredient: ingredient(name, amount) };
    }
    if (tasteWords.test(text)) {
      const name = cleanName(text.replace(tasteWords, ""));
      return { ingredient: ingredient(name || text, { kind: "qualitative", text: "al gusto" }) };
    }
    return pending("unparsed");
  }

  if (unsupportedUnit.test(rest)) return pending("unsupported-unit");

  const unitMatch = unitPatterns.map(([unit, pattern]) => [unit, pattern.exec(rest)] as const).find(([, match]) => match);
  const unit: UnitId = unitMatch?.[0] ?? "piece";
  const name = cleanName(unitMatch?.[1] ? rest.slice(unitMatch[1][0].length) : rest);
  const amount = measured(min, max, unit);
  if (!amount || !name) return pending("unparsed");
  return { ingredient: ingredient(name, amount) };
}
