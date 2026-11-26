import type { Amount } from "../../contracts";
import { formatMeasuredAmount, normalizeMeasuredAmount } from "../../domain/measurements";
import type { CapturedIngredient } from "../contract";
import {
  connectors, firstPersonPlural, leadingQualitative, seasoningWords, stepVerbs, trailingQualitative, unitAt,
} from "./lexicon";
import { readQuantity, startsQuantity, toMeasured } from "./quantity";
import { capitalize, isBreak, keysAt, render } from "./tokens";
import type { Token } from "./tokens";

const leadFillers = new Set(["y", "e", "tambien", "ademas", "mas", "con", "luego"]);
const holdsNameOpen = new Set(["de", "del", "con", "para", "en", "sin", "por", "al", "el", "la", "los", "las", "a"]);
const trailingGlue = new Set(["y", "e", "o", "u", "con", "tambien", "mas", "ademas"]);
const stepOpeners = new Set(["en", "cuando", "mientras"]);
const skippedAtStart = new Set(["y", "e", "ya", "entonces", "pues", "bueno", "ahora", "eh", "este"]);

/** True when the clause beginning at `index` reads as a preparation step rather than an ingredient. */
export function opensStep(tokens: readonly Token[], index: number): boolean {
  let i = index;
  while (skippedAtStart.has(tokens[i]?.key ?? "")) i++;
  const key = tokens[i]?.key;
  if (key === undefined) return false;
  if (key === "una" && tokens[i + 1]?.key === "vez") return true;
  if (key === "paso" && tokens[i + 1] !== undefined && readQuantity(tokens, i + 1)) return true;
  if (connectors.has(key) || stepOpeners.has(key) || stepVerbs.has(key)) return true;
  return key === "se" && stepVerbs.has(tokens[i + 1]?.key ?? "");
}

const partitives = new Set(["jugo", "ralladura", "cascara", "rodajas", "rebanadas", "trozos", "piezas", "pedazos",
  "gajos", "hojas", "dientes", "ramas", "ramitas", "trocitos", "cubos", "tiras", "mitades"]);

/** A quantity inside a run-on phrase begins the next ingredient, except in `jugo de 2 limones`. */
function startsNewItem(tokens: readonly Token[], index: number, nameStart: number): boolean {
  const previous = tokens[index - 1].key;
  if (index <= nameStart || holdsNameOpen.has(previous)) return false;
  if (tokens[index].key === "de") {
    const quantity = readQuantity(tokens, index);
    return quantity?.max !== undefined && !partitives.has(previous);
  }
  return startsQuantity(tokens, index);
}

/** A spoken clause boundary inside an ingredient phrase, where the preparation begins. */
function cutsIngredient(tokens: readonly Token[], index: number): boolean {
  const key = tokens[index].key;
  if (connectors.has(key) && key !== "entonces") return tokens[index + 1]?.key !== "de";
  if (firstPersonPlural.has(key)) return true;
  return key === "se" && stepVerbs.has(tokens[index + 1]?.key ?? "");
}

const participle = /^(?:picad|cortad|rallad|rebanad|pelad|lavad|desvenad|desinfectad|machacad|trocead|licuad|asad|tostad|escurrid|deshebrad|desgranad|molid|cocid|hervid|fritas?|frit)(?:[oa]s?|it[oa]s?)$/u;
const prepMarkers = new Set(["finamente", "bien", "muy", "ya"]);
const shapes = new Set([
  "cubos", "cubitos", "rodajas", "rebanadas", "tiras", "rajas", "trozos", "trocitos", "juliana", "cuadros",
  "cuadritos", "mitades", "gajos", "tiritas", "laminas",
]);
const usageVerbs = new Set([
  "decorar", "servir", "freir", "acompanar", "adornar", "espolvorear", "untar", "engrasar", "barnizar", "empanizar",
]);

/** Splits an ingredient name from preparation descriptors such as `picada` or `para decorar`. */
function stripDescriptors(words: Token[]): Token[] {
  const kept = [...words];
  for (let changed = true; changed && kept.length > 1;) {
    changed = false;
    const last = kept[kept.length - 1].key;
    const before = kept[kept.length - 2]?.key;
    if (participle.test(last) && !(before === "de" || before === "del")) {
      kept.pop();
      changed = true;
    } else if (shapes.has(last) && (before === "en" || before === "a")) {
      kept.pop();
      kept.pop();
      changed = true;
    } else if (usageVerbs.has(last) && before === "para") {
      kept.pop();
      kept.pop();
      changed = true;
    } else if (prepMarkers.has(last)) {
      kept.pop();
      changed = true;
    } else if (last === "ambiente" && kept.length > 3 && keysAt(kept, kept.length - 3, ["a", "temperatura"])) {
      kept.length -= 3;
      changed = true;
    }
  }
  return kept;
}

/** Splits `sal y pimienta` into two short names; longer phrases stay whole. */
function splitConjunction(words: Token[]): Token[][] {
  const index = words.findIndex((word) => word.key === "y" || word.key === "e");
  if (index <= 0 || index >= words.length - 1) return [words];
  const left = words.slice(0, index);
  const right = words.slice(index + 1);
  const simple = (side: Token[]) => side.length <= 2 && !side.some((word) => word.key === "de" || word.key === "del");
  return simple(left) && simple(right) ? [left, ...splitConjunction(right)] : [words];
}

export type IngredientScan = {
  ingredients: CapturedIngredient[];
  /** Tokens from the point where preparation starts; empty when the whole region was ingredients. */
  rest: Token[];
};

/** Reads ingredient phrases until the end of the region or the first preparation step. */
export function parseIngredients(tokens: readonly Token[], notices: string[]): IngredientScan {
  const ingredients: CapturedIngredient[] = [];
  const keys = tokens.map((token) => token.key);
  let i = 0;
  let chunkStart = true;

  while (i < tokens.length) {
    const first = tokens[i];
    if (isBreak(first) || first.kind === "comma") {
      chunkStart = true;
      i++;
      continue;
    }
    if (chunkStart && opensStep(tokens, i)) return { ingredients, rest: tokens.slice(i) };

    const itemStart = i;
    while (leadFillers.has(tokens[i]?.key ?? "") && i < tokens.length - 1) i++;
    const contentStart = i;

    let amount: Amount = { kind: "unspecified" };
    let leadMatched = false;

    const vague = leadingQualitative(keys, i);
    const quantity = vague ? undefined : readQuantity(tokens, i);
    if (vague) {
      leadMatched = true;
      amount = { kind: "qualitative", text: vague.text };
      i += vague.words;
    } else if (quantity) {
      leadMatched = true;
      i = quantity.next;
      if (quantity.reversed) {
        notices.push(`El rango «${render(tokens.slice(contentStart, i))}» estaba invertido; confirma la cantidad.`);
      } else {
        try {
          amount = normalizeMeasuredAmount(toMeasured(quantity));
        } catch {
          amount = { kind: "unspecified" };
        }
        if (quantity.alternative && amount.kind === "measured") {
          notices.push(
            `«${render(tokens.slice(contentStart, i))}» se registró como un rango (${formatMeasuredAmount(amount)}). Revísalo.`,
          );
        }
      }
    } else {
      const bare = unitAt(keys, i);
      if (bare && (bare.unit === "pinch" || bare.unit === "bunch") && keys[i + bare.words] === "de") {
        leadMatched = true;
        amount = { kind: "measured", unit: bare.unit, min: { numerator: "1", denominator: "1" } };
        i += bare.words;
      }
    }
    if (leadMatched && keys[i] === "de") i++;
    else if (leadMatched && keys[i] === "del") i++;

    const nameStart = i;
    let trailing: string | undefined;
    let trailingWords = 0;
    let cut = false;
    while (i < tokens.length) {
      const token = tokens[i];
      if (isBreak(token) || token.kind === "comma") break;
      const vague = trailingQualitative(keys, i);
      if (vague && i > nameStart) {
        trailing = vague.text;
        trailingWords = vague.words;
        i += vague.words;
        break;
      }
      if (i > nameStart) {
        if (cutsIngredient(tokens, i)) {
          cut = true;
          break;
        }
        if (startsNewItem(tokens, i, nameStart)) break;
      }
      i++;
    }

    const nameEnd = i - (trailing === undefined ? 0 : trailingWords);
    const nameTokens = tokens.slice(nameStart, nameEnd);
    while (nameTokens.length && trailingGlue.has(nameTokens[nameTokens.length - 1].key)) nameTokens.pop();

    const contentEnd = trailing === undefined ? nameStart + nameTokens.length : i;
    let originalText = render(tokens.slice(contentStart, contentEnd));
    const seasonings: CapturedIngredient[] = [];
    const afterBreak = isBreak(tokens[i]) || tokens[i]?.kind === "comma";
    chunkStart = afterBreak || trailing !== undefined || cut;

    // `, picada` or `, en cubos` describes the previous ingredient.
    if (!leadMatched && !trailing && ingredients.length > 0 && nameTokens.length > 0
        && (participle.test(nameTokens[0].key) || prepMarkers.has(nameTokens[0].key)
          || (nameTokens[0].key === "en" && shapes.has(nameTokens[1]?.key ?? "")))
        && itemStart > 0 && tokens[itemStart - 1].kind === "comma") {
      const previous = ingredients[ingredients.length - 1];
      previous.originalText = `${previous.originalText ?? previous.name}, ${originalText}`;
      if (cut) return { ingredients, rest: tokens.slice(i) };
      continue;
    }

    const names = nameTokens.length === 0 ? [] : stripDescriptors(nameTokens);
    if (names.length === 0) {
      if (leadMatched && amount.kind === "measured") {
        notices.push(`Una cantidad no tenía ingrediente: «${originalText}». Revísala.`);
      }
      if (cut) return { ingredients, rest: tokens.slice(i) };
      if (i === itemStart) i++;
      continue;
    }

    if (trailing && amount.kind === "measured" && names.length > 1) {
      // `tres dientes de ajo sal y pimienta al gusto`: the seasonings after the measured item share the qualifier.
      let split = names.length;
      while (split > 1 && seasoningWords.has(names[split - 1].key)) split--;
      while (split < names.length && ["y", "e", "de", "en"].includes(names[split].key)) split++;
      if (split < names.length && names[split - 1].key !== "de") {
        for (const part of splitConjunction(names.slice(split))) {
          seasonings.push({
            name: capitalize(render(part)),
            amount: { kind: "qualitative", text: trailing },
            originalText: `${render(part)} ${trailing}`,
          });
        }
        names.length = split;
        while (names.length > 1 && ["y", "e", "de", "en"].includes(names[names.length - 1].key)) names.pop();
        originalText = render(tokens.slice(contentStart, nameStart + names.length));
        trailing = undefined;
      }
    }
    if (trailing && amount.kind === "measured") {
      notices.push(
        `«${capitalize(render(names))}» tiene cantidad y «${trailing}». Conservamos la cantidad; revisa cuál prefieres.`,
      );
    } else if (trailing && amount.kind === "unspecified") {
      amount = { kind: "qualitative", text: trailing };
    }

    const parts = amount.kind === "measured" ? [names] : splitConjunction(names);
    for (const part of parts) {
      const name = capitalize(render(part));
      if (part.some((word) => word.key === "o") && part.length > 2) {
        notices.push(`«${name}» parece ofrecer más de una opción; revisa el ingrediente.`);
      } else if (part.length >= 5) {
        notices.push(`Revisa «${name}»: parece contener más de un ingrediente.`);
      }
      ingredients.push({ name, amount, originalText });
    }

    ingredients.push(...seasonings);
    if (cut) return { ingredients, rest: tokens.slice(i) };
    if (i === itemStart) i++;
  }
  return { ingredients, rest: [] };
}
