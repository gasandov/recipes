import { connectors, fillers } from "./lexicon";
import { readQuantity } from "./quantity";
import { capitalize, isBreak, render } from "./tokens";
import type { Token } from "./tokens";

const leadingNoise = new Set(["y", "e", "entonces", "pues", "bueno", "luego", "despues", "primero", "segundo", "tercero",
  "finalmente", "enseguida", "posteriormente", "ahora"]);
const ordinals = new Set(["primero", "segundo", "tercero", "cuarto", "quinto", "sexto"]);

function stepNumberAt(tokens: readonly Token[], index: number): number {
  if (tokens[index]?.key !== "paso" && tokens[index]?.key !== "numero") return 0;
  const next = tokens[index + 1];
  if (next === undefined) return 0;
  if (ordinals.has(next.key)) return 2;
  const quantity = readQuantity(tokens, index + 1);
  return quantity ? quantity.next - index : 0;
}

/** Number of tokens in an ordering phrase that opens a new step at `index`, or 0. */
function connectorLength(tokens: readonly Token[], index: number): number {
  const key = tokens[index].key;
  const next = tokens[index + 1]?.key;
  if (connectors.has(key) && key !== "entonces") return next === "de" || next === "que" ? 0 : 1;
  if (key === "por" && next === "ultimo") return 2;
  if (key === "al" && next === "final") return 2;
  if (key === "a" && next === "continuacion") return 2;
  if (key === "mientras" && next === "tanto") return 2;
  return stepNumberAt(tokens, index);
}

function isFiller(token: Token): boolean {
  return token.kind === "word" && fillers.has(token.key);
}

/** Splits dictated preparation text into ordered steps, even when speech recognition added no punctuation. */
export function parseSteps(tokens: readonly Token[]): string[] {
  const chunks: Token[][] = [];
  let current: Token[] = [];
  const flush = () => {
    if (current.length > 0) chunks.push(current);
    current = [];
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (isBreak(token)) {
      flush();
      continue;
    }
    const words = current.filter((part) => part.kind !== "comma").length;
    const length = connectorLength(tokens, i);
    if (length > 0 && words >= 2) {
      // `y luego`: the conjunction belongs to the new step.
      while (current.length > 0 && ["y", "e", "o"].includes(current[current.length - 1].key)) current.pop();
      flush();
    }
    current.push(token);
  }
  flush();

  const steps: string[] = [];
  for (const chunk of chunks) {
    const words = chunk.filter((token) => !isFiller(token));
    let start = 0;
    for (;;) {
      const length = connectorLength(words, start);
      const key = words[start]?.key;
      if (words[start]?.kind === "comma") {
        start++;
      } else if (length > 0 && (key === "paso" || key === "numero" || key === "por" || key === "al" || key === "a" || key === "mientras")) {
        start += length;
      } else if (key !== undefined && leadingNoise.has(key) && !(key !== "y" && key !== "e" && words[start + 1]?.key === "de")) {
        start++;
      } else break;
    }
    let end = words.length;
    while (end > start && (words[end - 1].kind === "comma" || ["y", "e"].includes(words[end - 1].key))) end--;
    const text = render(words.slice(start, end));
    if (/\p{L}|\d/u.test(text)) steps.push(`${capitalize(text)}.`);
  }
  return steps;
}
