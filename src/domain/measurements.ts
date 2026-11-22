import { unitIds } from "../contracts";
import type { Amount, Density, MeasuredAmount, Rational, UnitId } from "../contracts";
import {
  compareRational, divideRational, formatRational, multiplyRational, normalizeRational, parseRational,
} from "./rational";

type Unit = { dimension: "mass" | "volume" | "piece" | "pinch" | "bunch"; factor: Rational };

const one = parseRational("1");
const thousand = parseRational("1000");

// Base units are grams and milliliters. Cups and spoons follow Profeco.
// The ounce factors use the international pound and U.S. liquid gallon definitions.
export const units: Readonly<Record<UnitId, Unit>> = {
  gram: { dimension: "mass", factor: one },
  kilogram: { dimension: "mass", factor: thousand },
  milliliter: { dimension: "volume", factor: one },
  liter: { dimension: "volume", factor: thousand },
  cup: { dimension: "volume", factor: parseRational("250") },
  tablespoon: { dimension: "volume", factor: parseRational("15") },
  teaspoon: { dimension: "volume", factor: parseRational("5") },
  ounce: { dimension: "mass", factor: parseRational("28.349523125") },
  fluidOunceUs: { dimension: "volume", factor: parseRational("29.5735295625") },
  piece: { dimension: "piece", factor: one },
  pinch: { dimension: "pinch", factor: one },
  bunch: { dimension: "bunch", factor: one },
};

export function normalizeMeasuredAmount(amount: MeasuredAmount): MeasuredAmount {
  if (!unitIds.includes(amount.unit)) throw new RangeError("The measurement unit is unknown.");
  const min = normalizeRational(amount.min);
  if (amount.max === undefined) return { kind: "measured", unit: amount.unit, min };

  const max = normalizeRational(amount.max);
  if (compareRational(min, max) > 0) throw new RangeError("The range is reversed.");
  return { kind: "measured", unit: amount.unit, min, max };
}

export function parseMeasuredAmount(text: string, unit: UnitId): MeasuredAmount {
  const endpoints = text.trim().split(/\s*[-–—−]\s*/u);
  if (endpoints.length > 2) throw new RangeError("A range must have two endpoints.");

  const [minimum, maximum] = endpoints;
  const amount: MeasuredAmount = { kind: "measured", unit, min: parseRational(minimum) };
  if (maximum !== undefined) amount.max = parseRational(maximum);
  return normalizeMeasuredAmount(amount);
}

export function formatMeasuredAmount(amount: MeasuredAmount, preferDecimal = false): string {
  const min = formatRational(amount.min, preferDecimal);
  return amount.max ? `${min}–${formatRational(amount.max, preferDecimal)}` : min;
}

/** Displays large metric amounts in the larger unit, using the upper endpoint of a range. */
export function defaultMetricUnit(amount: MeasuredAmount): UnitId {
  if (compareRational(amount.max ?? amount.min, thousand) >= 0) {
    if (amount.unit === "gram") return "kilogram";
    if (amount.unit === "milliliter") return "liter";
  }
  return amount.unit;
}

export function scaleMeasuredAmount(amount: MeasuredAmount, factor: Rational): MeasuredAmount {
  const min = multiplyRational(amount.min, factor);
  return amount.max ? { ...amount, min, max: multiplyRational(amount.max, factor) } : { ...amount, min };
}

export function normalizeAmount(amount: Amount): Amount {
  switch (amount.kind) {
    case "measured":
      return normalizeMeasuredAmount(amount);
    case "qualitative":
      if (!amount.text.trim()) throw new RangeError("A qualitative amount needs a note.");
      return { kind: "qualitative", text: amount.text };
    case "unspecified":
      return { kind: "unspecified" };
    default:
      throw new RangeError("The amount kind is unknown.");
  }
}

/** Reports when a compatible display conversion depends on an approximate density. */
export function usesDensity(from: UnitId, to: UnitId): boolean {
  const first = units[from].dimension;
  const second = units[to].dimension;
  return (first === "mass" && second === "volume") || (first === "volume" && second === "mass");
}

export function convertMeasuredAmount(
  amount: MeasuredAmount,
  targetUnit: UnitId,
  density?: Density,
): MeasuredAmount | undefined {
  const from = units[amount.unit];
  const to = units[targetUnit];
  let factor = divideRational(from.factor, to.factor);

  if (from.dimension !== to.dimension) {
    if (!density || !usesDensity(amount.unit, targetUnit)) return undefined;
    factor = from.dimension === "volume"
      ? multiplyRational(factor, density.gramsPerMilliliter)
      : divideRational(factor, density.gramsPerMilliliter);
  }

  return { ...scaleMeasuredAmount(amount, factor), unit: targetUnit };
}
