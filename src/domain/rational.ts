import type { Rational } from "../contracts";

const vulgarFractions: Record<string, string> = {
  "¼": "1/4", "½": "1/2", "¾": "3/4",
  "⅐": "1/7", "⅑": "1/9", "⅒": "1/10",
  "⅓": "1/3", "⅔": "2/3",
  "⅕": "1/5", "⅖": "2/5", "⅗": "3/5", "⅘": "4/5",
  "⅙": "1/6", "⅚": "5/6",
  "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8",
};

export function rational(numerator: bigint, denominator: bigint = 1n): Rational {
  if (numerator <= 0n || denominator <= 0n) {
    throw new RangeError("Quantity and denominator must be positive.");
  }

  let a = numerator;
  let b = denominator;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return { numerator: (numerator / a).toString(), denominator: (denominator / a).toString() };
}

function parts(value: Rational): [bigint, bigint] {
  if (typeof value.numerator !== "string" || typeof value.denominator !== "string"
      || !/^\d+$/.test(value.numerator) || !/^\d+$/.test(value.denominator)) {
    throw new RangeError("A rational must contain decimal integer strings.");
  }

  const numerator = BigInt(value.numerator);
  const denominator = BigInt(value.denominator);
  if (numerator <= 0n || denominator <= 0n) {
    throw new RangeError("Quantity and denominator must be positive.");
  }
  return [numerator, denominator];
}

export function normalizeRational(value: Rational): Rational {
  return rational(...parts(value));
}

export function parseRational(text: string): Rational {
  const input = text.trim();
  const vulgar = /^(?:(\d+)\s*)?([¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])$/u.exec(input);
  if (vulgar) {
    const whole = vulgar[1] ? `${vulgar[1]} ` : "";
    return parseRational(whole + vulgarFractions[vulgar[2]]);
  }

  const fraction = /^(?:(\d+)\s+)?(\d+)\s*[/⁄]\s*(\d+)$/u.exec(input);
  if (fraction) {
    const whole = BigInt(fraction[1] ?? "0");
    const remainder = BigInt(fraction[2]);
    const denominator = BigInt(fraction[3]);
    if (fraction[1] !== undefined && (remainder === 0n || remainder >= denominator)) {
      throw new RangeError("A mixed fraction must have a positive proper fractional part.");
    }
    return rational(whole * denominator + remainder, denominator);
  }

  const decimal = /^(?:(\d+)(?:[.,](\d+))?|[.,](\d+))$/.exec(input);
  if (decimal) {
    const fractionalDigits = decimal[2] ?? decimal[3] ?? "";
    return rational(BigInt((decimal[1] ?? "0") + fractionalDigits), 10n ** BigInt(fractionalDigits.length));
  }

  throw new RangeError("Enter an integer, decimal, or fraction.");
}

export function formatRational(value: Rational): string {
  const [numerator, denominator] = parts(normalizeRational(value));
  const whole = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return whole.toString();

  // Preserve familiar cooking fractions and keep long decimals compact.
  if (denominator !== 2n && denominator !== 4n && denominator !== 8n) {
    for (let places = 1, scale = 10n; places <= 6; places++, scale *= 10n) {
      if ((remainder * scale) % denominator === 0n) {
        const digits = ((remainder * scale) / denominator).toString().padStart(places, "0");
        return `${whole}.${digits}`;
      }
    }
  }

  const fraction = `${remainder}/${denominator}`;
  return whole === 0n ? fraction : `${whole} ${fraction}`;
}

export function compareRational(left: Rational, right: Rational): -1 | 0 | 1 {
  const [a, b] = parts(left);
  const [c, d] = parts(right);
  const difference = a * d - c * b;
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}

export function multiplyRational(left: Rational, right: Rational): Rational {
  const [a, b] = parts(left);
  const [c, d] = parts(right);
  return rational(a * c, b * d);
}

export function divideRational(left: Rational, right: Rational): Rational {
  const [a, b] = parts(left);
  const [c, d] = parts(right);
  return rational(a * d, b * c);
}
