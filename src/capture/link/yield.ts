export type ParsedYield = {
  /** Set only when the page states a single whole number of portions. */
  portions?: number;
  /** An es-MX note for the review screen when the stated yield could not become portions. */
  note?: string;
};

const portionWords = String.raw`porci[oó]n(?:es)?|personas?|raciones?|comensales|servings?|serves?|platos?|people`;
const range = /\d\s*(?:-|–|—|a|to)\s*\d/iu;

/**
 * Reads an explicit yield such as "4 porciones", "Rinde 6" or "Serves 4".
 * It never infers a number. A range or an item count ("24 galletas") stays pending and is described
 * in a note, because the editor asks the user to confirm portions before normalizing amounts.
 */
export function parseYield(text: string | undefined): ParsedYield {
  const value = text?.replace(/\s+/g, " ").trim();
  if (!value) return {};

  if (range.test(value)) return { note: `La fuente indica un rango de porciones ("${value}"). Confirma cuántas rinde.` };

  const bare = /^(\d{1,3})$/.exec(value);
  const withWord = new RegExp(String.raw`(?:^|\b)(\d{1,3})\s*(?:${portionWords})\b`, "iu").exec(value);
  const labelled = new RegExp(String.raw`(?:rinde|rinden|rendimiento|para|serves|servings?|porciones|raciones)\s*:?\s*(\d{1,3})\b(?!\s*(?:[a-záéíóúñ]))`, "iu").exec(value);
  const count = Number((bare ?? withWord ?? labelled)?.[1]);
  if (Number.isSafeInteger(count) && count > 0) return { portions: count };

  return { note: `La fuente indica el rendimiento "${value}". Confirma cuántas porciones son.` };
}
