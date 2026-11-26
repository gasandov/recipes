/** Tokenization for dictated Spanish. Words keep their spoken spelling and carry an accent-free key. */
export type Token = {
  raw: string;
  key: string;
  kind: "word" | "num" | "comma" | "stop" | "colon" | "dash";
};

const vulgar: Record<string, string> = {
  "¼": "1/4", "½": "1/2", "¾": "3/4", "⅓": "1/3", "⅔": "2/3", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8",
};

export function plainKey(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const pattern = /(\d+(?:[.,]\d+)?)(?:\s*[/⁄]\s*(\d+))?|\p{L}+|[.!?;…\n\r]+|,|:|[-–—−]/gu;

export function tokenize(text: string): Token[] {
  const input = text
    .normalize("NFC")
    .replace(/[¼½¾⅓⅔⅛⅜⅝⅞]/gu, (fraction) => ` ${vulgar[fraction]} `);
  const tokens: Token[] = [];
  for (const match of input.matchAll(pattern)) {
    const [raw] = match;
    if (match[1] !== undefined) {
      const value = match[2] === undefined ? match[1] : `${match[1]}/${match[2]}`;
      tokens.push({ raw: value, key: value, kind: "num" });
    } else if (raw === ",") tokens.push({ raw, key: ",", kind: "comma" });
    else if (raw === ":") tokens.push({ raw, key: ":", kind: "colon" });
    else if (/^[-–—−]$/u.test(raw)) tokens.push({ raw: "-", key: "-", kind: "dash" });
    else if (/^[.!?;…\n\r]/u.test(raw)) tokens.push({ raw: ".", key: ".", kind: "stop" });
    else tokens.push({ raw, key: plainKey(raw), kind: "word" });
  }
  return tokens;
}

export function isBreak(token: Token | undefined): boolean {
  return token === undefined || token.kind === "stop" || token.kind === "colon";
}

export function keysAt(tokens: readonly Token[], index: number, keys: readonly string[]): boolean {
  return keys.every((key, offset) => tokens[index + offset]?.key === key);
}

/** Rebuilds readable text; commas attach to the previous word. */
export function render(tokens: readonly Token[]): string {
  let text = "";
  for (const token of tokens) {
    if (token.kind === "stop" || token.kind === "colon") continue;
    if (token.kind === "comma") text += ",";
    else text += (text ? " " : "") + token.raw;
  }
  return text.trim();
}

export function capitalize(text: string): string {
  return text ? text[0].toLocaleUpperCase("es-MX") + text.slice(1) : text;
}
