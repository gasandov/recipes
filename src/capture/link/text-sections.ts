import { parseYield } from "./yield";

export type TextRecipe = {
  name?: string;
  portions?: number;
  yieldNote?: string;
  ingredients: string[];
  steps: string[];
};

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("es-MX");
}

const ingredientHeadings = /^(?:ingredientes?|ingredients?|lo que necesitas|que necesitas|necesitas|lista de ingredientes)$/;
const stepHeadings =
  /^(?:(?:modo de |forma de )?preparacion|procedimiento|instrucciones|elaboracion|pasos|como prepararlo|como preparar|directions|instructions|method|preparation|steps)$/;
const stopHeadings =
  /^(?:notas?|tips?|consejos?|informacion nutricional|valores nutricionales|nutricion|comentarios|recetas relacionadas|te puede interesar|mas recetas|compartir|nutrition|notes)$/;

/** Reduces "🛒 Ingredientes:" to "ingredientes" so headings written with emoji and colons still match. */
function headingKey(line: string): { key: string; rest: string } | undefined {
  const match = /^[^\p{L}\p{N}]*([\p{L}][\p{L}\p{N} ]{1,40}?)\s*:?\s*([^\p{L}\p{N}]*)$/u.exec(line);
  if (match && line.length <= 60) return { key: fold(match[1]).trim(), rest: "" };
  const withRest = /^[^\p{L}\p{N}]*([\p{L}][\p{L} ]{1,30}?)\s*:\s*(.+)$/u.exec(line);
  return withRest ? { key: fold(withRest[1]).trim(), rest: withRest[2].trim() } : undefined;
}

const hashtagOnly = /^(?:[#@][\p{L}\p{N}_.]+\s*)+$/u;
const stepNumber = /^\s*(?:paso\s*)?\d{1,2}\s*[.)\-:–]\s+/iu;
const bullet = /^[\s\-–—•*·▢☐☑✔✓✅▪●○◦\u{1F300}-\u{1FAFF}☀-➿]+/u;
const yieldLine = /^[^\p{L}\p{N}]*(?:rinde|rinden|rendimiento|porciones|raciones|serves|servings?|yield|makes|para \d+)\b.*$/iu;

/**
 * Finds the name, yield, ingredient lines and steps in free text such as a page's visible text or a
 * pasted social caption. It looks for headings like "Ingredientes" and "Preparación". Text without
 * such headings produces an empty result, because guessing which lines are ingredients would invent data.
 */
export function parseRecipeText(text: string): TextRecipe {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !hashtagOnly.test(line));
  const result: TextRecipe = { ingredients: [], steps: [] };

  type Section = "head" | "ingredients" | "steps" | "other";
  let section: Section = "head";
  const head: string[] = [];

  for (const line of lines) {
    const heading = headingKey(line);
    const key = heading?.key ?? "";
    let next: Section | undefined;
    if (ingredientHeadings.test(key)) next = "ingredients";
    else if (stepHeadings.test(key)) next = "steps";
    else if (stopHeadings.test(key)) next = "other";

    if (next) {
      section = next;
      if (heading?.rest && next === "ingredients") result.ingredients.push(heading.rest.replace(bullet, "").trim());
      if (heading?.rest && next === "steps") result.steps.push(heading.rest.replace(stepNumber, "").trim());
      continue;
    }

    if (yieldLine.test(line) && line.length <= 60 && result.portions === undefined && !result.yieldNote) {
      const parsed = parseYield(line.replace(/^[^\p{L}\p{N}]*(?:rinde|rinden|rendimiento|porciones|raciones|serves|servings?|yield|makes)\s*:?\s*/iu, ""));
      if (parsed.portions !== undefined) result.portions = parsed.portions;
      else if (parsed.note) result.yieldNote = parsed.note;
      if (section !== "ingredients" && section !== "steps") continue;
    }

    if (section === "head") head.push(line);
    else if (section === "ingredients") {
      const item = line.replace(bullet, "").trim();
      // "Para la salsa:" introduces a group. It is not an ingredient.
      if (item && !/^[^\d]{1,40}:$/u.test(item)) result.ingredients.push(item);
    } else if (section === "steps") {
      const step = line.replace(stepNumber, "").replace(bullet, "").trim();
      if (step) result.steps.push(step);
    }
  }

  const title = head.find((line) => line.length <= 100 && !/^\d/.test(line));
  const hasContent = result.ingredients.length > 0 || result.steps.length > 0;
  if (title && hasContent) result.name = title.replace(/^[^\p{L}\p{N}¡¿]+|[^\p{L}\p{N}!?.)]+$/gu, "").trim() || undefined;
  return result;
}
