import type { MeasuredAmount, Rational, UnitId } from "../../contracts";
import { addRational, compareRational, parseRational, rational } from "../../domain/rational";
import { unitAt } from "./lexicon";
import type { Token } from "./tokens";

const small: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18,
  diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21, veintiuna: 21, veintidos: 22, veintitres: 23,
  veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
};
const tens: Record<string, number> = {
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
};
const hundreds: Record<string, number> = {
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300,
  cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600,
  setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
};
const digitWords: Record<string, string> = {
  cero: "0", uno: "1", una: "1", dos: "2", tres: "3", cuatro: "4", cinco: "5", seis: "6", siete: "7", ocho: "8",
  nueve: "9",
};
const denominators: Record<string, number> = {
  medio: 2, media: 2, medios: 2, medias: 2, tercio: 3, tercios: 3, cuarto: 4, cuartos: 4, quinto: 5, quintos: 5,
  sexto: 6, sextos: 6, octavo: 8, octavos: 8, decimo: 10, decimos: 10,
};

type Read<T> = { value: T; next: number } | undefined;

function below1000(tokens: readonly Token[], start: number): Read<number> {
  let n = 0;
  let k = start;
  let seen = false;
  const hundred = hundreds[tokens[k]?.key ?? ""];
  if (hundred !== undefined) {
    n = hundred;
    k++;
    seen = true;
  }
  const ten = tens[tokens[k]?.key ?? ""];
  if (ten !== undefined) {
    n += ten;
    k++;
    seen = true;
    const unit = small[tokens[k + 1]?.key ?? ""];
    if (tokens[k]?.key === "y" && unit !== undefined && unit < 10) {
      n += unit;
      k += 2;
    }
  } else {
    const unit = small[tokens[k]?.key ?? ""];
    if (unit !== undefined) {
      n += unit;
      k++;
      seen = true;
    }
  }
  return seen ? { value: n, next: k } : undefined;
}

function cardinal(tokens: readonly Token[], start: number): Read<number> {
  const head = below1000(tokens, start);
  const after = head?.next ?? start;
  if (tokens[after]?.key === "mil") {
    const tail = below1000(tokens, after + 1);
    return { value: (head?.value ?? 1) * 1000 + (tail?.value ?? 0), next: tail?.next ?? after + 1 };
  }
  return head;
}

function exact(numerator: number, denominator: number): Rational | undefined {
  if (!Number.isSafeInteger(numerator) || numerator <= 0) return undefined;
  return rational(BigInt(numerator), BigInt(denominator));
}

/** `medio`, `un cuarto`, `tres cuartos`, `dos tercios`, or `1/2`. */
function fraction(tokens: readonly Token[], start: number): Read<Rational> {
  const token = tokens[start];
  if (token?.kind === "num") {
    if (/^\d+$/u.test(token.key)) {
      const denominator = denominators[tokens[start + 1]?.key ?? ""];
      const after = start + (tokens[start + 2]?.key === "de" ? 3 : 2);
      const unit = unitAt(tokens.slice(after, after + 4).map(({ key }) => key), 0);
      const value = unit && denominator && denominator !== 2 ? exact(Number(token.key), denominator) : undefined;
      return value ? { value, next: start + 2 } : undefined;
    }
    if (!/^\d+\/\d+$/u.test(token.key)) return undefined;
    try {
      return { value: parseRational(token.key), next: start + 1 };
    } catch {
      return undefined;
    }
  }
  const lead = cardinal(tokens, start);
  if (lead) {
    const key = tokens[lead.next]?.key ?? "";
    const denominator = denominators[key];
    if (denominator !== undefined && denominator !== 2) {
      const value = exact(lead.value, denominator);
      if (value) return { value, next: lead.next + 1 };
    }
    return undefined;
  }
  const key = token?.key ?? "";
  const denominator = denominators[key];
  if (denominator === undefined) return undefined;
  // `cuartos` alone is not a quantity; `medios` is tolerated as speech noise.
  if (key.endsWith("s") && denominator !== 2) return undefined;
  return { value: rational(1n, BigInt(denominator)), next: start + 1 };
}

function decimalDigits(tokens: readonly Token[], start: number): Read<string> {
  let digits = "";
  let k = start;
  while (k < tokens.length) {
    const token = tokens[k];
    const word = digitWords[token.key];
    if (word !== undefined) digits += word;
    else if (token.kind === "num" && /^\d+$/u.test(token.key)) digits += token.key;
    else break;
    k++;
  }
  return digits ? { value: digits, next: k } : undefined;
}

type Reading = { value: Rational; next: number; wordFraction: boolean };

function readNumber(tokens: readonly Token[], start: number): Reading | undefined {
  const token = tokens[start];
  if (!token) return undefined;

  const pure = fraction(tokens, start);
  if (pure) return { ...pure, wordFraction: true };

  let base: Rational | undefined;
  let next: number;
  let integer: boolean;
  if (token.kind === "num") {
    try {
      base = parseRational(token.key);
    } catch {
      return undefined;
    }
    integer = /^\d+$/u.test(token.key);
    next = start + 1;
  } else {
    const words = cardinal(tokens, start);
    if (!words) return undefined;
    base = exact(words.value, 1);
    integer = true;
    next = words.next;
    if (base && (tokens[next]?.key === "punto" || tokens[next]?.key === "coma")) {
      const digits = decimalDigits(tokens, next + 1);
      if (digits) {
        base = parseRational(`${words.value}.${digits.value}`);
        integer = false;
        next = digits.next;
      }
    }
  }
  if (!base) return undefined;

  // `1 1/2`, `1 y medio`, `dos y tres cuartos`.
  if (integer) {
    const hasAnd = tokens[next]?.key === "y";
    const tail = fraction(tokens, hasAnd ? next + 1 : next);
    if (tail && (hasAnd || tokens[next]?.kind === "num")) {
      return { value: addRational(base, tail.value), next: tail.next, wordFraction: false };
    }
  }
  return { value: base, next, wordFraction: false };
}

export type Quantity = {
  min: Rational;
  max?: Rational;
  unit?: UnitId;
  next: number;
  /** The range came from an ambiguous `o`, as in `dos o tres`. */
  alternative: boolean;
  /** The endpoints were spoken in descending order and were swapped. */
  reversed: boolean;
};

const rangeWords = new Set(["a", "o", "u", "hasta"]);
const leadWords = new Set(["entre", "de", "unos", "unas", "como", "aproximadamente", "casi"]);

function readUnit(tokens: readonly Token[], index: number, allowDe: boolean): { unit: UnitId; next: number } | undefined {
  const keys = tokens.slice(index, index + 4).map((token) => token.key);
  let match = unitAt(keys, 0);
  let offset = 0;
  if (!match && allowDe && keys[0] === "de") {
    match = unitAt(keys, 1);
    offset = 1;
  }
  return match ? { unit: match.unit, next: index + offset + match.words } : undefined;
}

function addFollowingFraction(tokens: readonly Token[], value: Rational, at: number): { value: Rational; next: number } {
  if (tokens[at]?.key === "y") {
    const extra = fraction(tokens, at + 1);
    if (extra) return { value: addRational(value, extra.value), next: extra.next };
  }
  return { value, next: at };
}

/** Reads a quantity phrase at `start`: numbers, fractions, ranges, and an optional unit. */
export function readQuantity(tokens: readonly Token[], start: number): Quantity | undefined {
  let j = start;
  let entre = false;
  while (leadWords.has(tokens[j]?.key ?? "") && readNumber(tokens, j + 1)) {
    if (tokens[j].key === "entre") entre = true;
    j++;
  }

  let first = readNumber(tokens, j);
  if (!first) {
    // `taza y media`, `kilo y medio`.
    const unit = unitAt(tokens.slice(j, j + 4).map((token) => token.key), 0);
    if (unit && tokens[j + unit.words]?.key === "y" && fraction(tokens, j + unit.words + 1)) {
      first = { value: rational(1n), next: j, wordFraction: false };
    }
  }
  if (!first) return undefined;

  const unitRead = readUnit(tokens, first.next, first.wordFraction);
  let unit = unitRead?.unit;
  let value = first.value;
  j = unitRead?.next ?? first.next;
  if (unit) ({ value, next: j } = addFollowingFraction(tokens, value, j));

  const quantity: Quantity = { min: value, unit, next: j, alternative: false, reversed: false };
  const separator = tokens[j];
  const isRangeWord = separator !== undefined
    && (rangeWords.has(separator.key) || separator.kind === "dash" || (entre && separator.key === "y"));
  const second = isRangeWord ? readNumber(tokens, j + 1) : undefined;
  if (second) {
    let secondValue = second.value;
    let at = second.next;
    const secondUnit = readUnit(tokens, at, second.wordFraction);
    if (secondUnit) {
      at = secondUnit.next;
      ({ value: secondValue, next: at } = addFollowingFraction(tokens, secondValue, at));
    }
    if (!secondUnit || !unit || secondUnit.unit === unit) {
      unit = unit ?? secondUnit?.unit;
      quantity.unit = unit;
      quantity.next = at;
      quantity.alternative = separator.key === "o" || separator.key === "u";
      if (compareRational(value, secondValue) > 0) {
        quantity.reversed = true;
        quantity.min = secondValue;
        quantity.max = value;
      } else {
        quantity.max = secondValue;
      }
    }
  }
  return quantity;
}

export function toMeasured(quantity: Quantity): MeasuredAmount {
  const amount: MeasuredAmount = { kind: "measured", unit: quantity.unit ?? "piece", min: quantity.min };
  if (quantity.max) amount.max = quantity.max;
  return amount;
}

/** True when `start` begins a quantity followed by a unit or a noun, so a new ingredient may start there. */
export function startsQuantity(tokens: readonly Token[], start: number): boolean {
  const quantity = readQuantity(tokens, start);
  if (!quantity) return false;
  const after = tokens[quantity.next];
  return quantity.unit !== undefined || (after?.kind === "word");
}
