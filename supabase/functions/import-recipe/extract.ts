import { importLimits } from "./protocol.ts";
import type { MediaReference, PageExtraction } from "./protocol.ts";

// Extraction works on strings because it must run in Deno and in Node tests without a DOM.

const entities: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", deg: "°", ordm: "º", ordf: "ª",
  frac12: "½", frac14: "¼", frac34: "¾", times: "×", copy: "©", iexcl: "¡", iquest: "¿",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", uuml: "ü", ntilde: "ñ",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Uuml: "Ü", Ntilde: "Ñ",
  agrave: "à", egrave: "è", ccedil: "ç", ocirc: "ô", acirc: "â", ecirc: "ê",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return " ";
      return String.fromCodePoint(code);
    }
    return entities[body] ?? entities[body.toLowerCase()] ?? whole;
  });
}

/** Removes tags and turns block boundaries into line breaks. Entities decode last, so `&lt;` stays text. */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|ul|ol|h[1-6]|tr|section|article|header|footer|table|blockquote)\s*>/gi, "\n")
    .replace(/<(?:li|p|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(withBreaks)
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t\u200b]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function inline(text: string): string {
  return htmlToText(text).replace(/\s*\n\s*/g, " ").trim();
}

function clip(text: string): string {
  return text.length > importLimits.maxItemChars ? `${text.slice(0, importLimits.maxItemChars)}…` : text;
}

function cleanList(items: Iterable<string>): string[] {
  const result: string[] = [];
  for (const raw of items) {
    const text = clip(inline(raw));
    if (text) result.push(text);
    if (result.length >= importLimits.maxListItems) break;
  }
  return result;
}

// --- JSON-LD --------------------------------------------------------------------------------------

function parseJsonLoose(text: string): unknown {
  const cleaned = text.trim().replace(/^<!\[CDATA\[|\]\]>$/g, "").replace(/^<!--|-->$/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    try {
      // Some sites put raw line breaks inside strings, which JSON forbids.
      return JSON.parse(cleaned.replace(/\p{Cc}+/gu, " "));
    } catch {
      return undefined;
    }
  }
}

export function jsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(pattern)) {
    if (!/type\s*=\s*["']?application\/ld\+json/i.test(match[1])) continue;
    const value = parseJsonLoose(match[2]);
    if (value !== undefined) blocks.push(value);
    if (blocks.length >= 20) break;
  }
  return blocks;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function hasType(node: Json, wanted: string): boolean {
  const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
  return types.some((type) => typeof type === "string" && type.split("/").pop()?.toLowerCase() === wanted.toLowerCase());
}

/** Walks `@graph`, arrays and nested objects with a node budget, so hostile JSON cannot stall extraction. */
function findNodes(root: unknown, wanted: string): Json[] {
  const found: Json[] = [];
  const stack: [unknown, number][] = [[root, 0]];
  let budget = 5000;
  while (stack.length > 0 && budget-- > 0) {
    const [value, depth] = stack.pop() as [unknown, number];
    if (depth > 8) continue;
    if (Array.isArray(value)) {
      for (const item of value) stack.push([item, depth + 1]);
    } else if (isObject(value)) {
      if (hasType(value, wanted)) found.push(value);
      for (const child of Object.values(value)) {
        if (typeof child === "object" && child !== null) stack.push([child, depth + 1]);
      }
    }
  }
  return found;
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (isObject(value)) return textValue(value.text) ?? textValue(value.name);
  return undefined;
}

/** Flattens `recipeInstructions` in all of its schema.org shapes. */
function instructionSteps(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === undefined || value === null) return [];
  if (typeof value === "string") {
    const text = value;
    // A single string often holds the whole method, as lines, list items or paragraphs.
    const parts = /<(?:li|p|br)\b/i.test(text)
      ? text.split(/<\/?(?:li|ol|ul|p)\b[^>]*>|<br\s*\/?>/gi)
      : text.split(/\r?\n+/);
    return parts.flatMap((part) => (part.trim() ? [part] : []));
  }
  if (Array.isArray(value)) return value.flatMap((item) => instructionSteps(item, depth + 1));
  if (isObject(value)) {
    if (hasType(value, "HowToSection") || hasType(value, "ItemList") || value.itemListElement !== undefined) {
      const items = instructionSteps(value.itemListElement, depth + 1);
      const heading = textValue(value.name);
      // Keep a section name as its own pending line only when it adds context.
      return hasType(value, "HowToSection") && heading && items.length > 0 ? [heading, ...items] : items;
    }
    const text = textValue(value.text) ?? textValue(value.name) ?? textValue(value.description);
    return text ? instructionSteps(text, depth + 1) : [];
  }
  return [];
}

function listOfText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(listOfText);
  const text = textValue(value);
  return text ? [text] : [];
}

function yieldText(value: unknown): string | undefined {
  const items = listOfText(value).map((item) => inline(item)).filter(Boolean);
  if (items.length === 0) return undefined;
  // Pages often list `["4", "4 porciones"]`. Prefer the item that names a unit.
  return items.find((item) => /\d\s*[^\d\s]/.test(item)) ?? items[0];
}

function httpsUrl(value: unknown): string | undefined {
  const text = textValue(isObject(value) ? value.url ?? value.contentUrl ?? value.embedUrl : value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function mediaFrom(recipe: Json, html: string): MediaReference[] {
  const media: MediaReference[] = [];
  const add = (kind: MediaReference["kind"], url: string | undefined) => {
    if (url && media.length < importLimits.maxMedia && !media.some((item) => item.url === url)) media.push({ kind, url });
  };

  for (const image of Array.isArray(recipe.image) ? recipe.image : [recipe.image]) add("image", httpsUrl(image));
  for (const video of Array.isArray(recipe.video) ? recipe.video : [recipe.video]) {
    if (isObject(video)) add("video", httpsUrl(video.contentUrl) ?? httpsUrl(video.embedUrl));
  }
  const meta = metaTags(html);
  add("image", httpsUrl(meta["og:image"]));
  add("video", httpsUrl(meta["og:video:secure_url"] ?? meta["og:video"]));
  return media;
}

function recipeScore(node: Json): number {
  return listOfText(node.recipeIngredient ?? node.ingredients).length * 2 + instructionSteps(node.recipeInstructions).length;
}

function fromJsonLd(html: string): PageExtraction | undefined {
  const recipes = jsonLdBlocks(html).flatMap((block) => findNodes(block, "Recipe"));
  const best = recipes.sort((a, b) => recipeScore(b) - recipeScore(a))[0];
  if (!best || recipeScore(best) === 0) return undefined;

  return {
    origin: "json-ld",
    finalUrl: "",
    title: clip(inline(textValue(best.name) ?? "")) || undefined,
    yieldText: yieldText(best.recipeYield),
    description: clip(inline(textValue(best.description) ?? "")) || undefined,
    ingredients: cleanList(listOfText(best.recipeIngredient ?? best.ingredients)),
    steps: cleanList(instructionSteps(best.recipeInstructions)),
    media: mediaFrom(best, html),
  };
}

// --- Microdata ------------------------------------------------------------------------------------

function propertyHtml(html: string, names: string[]): string[] {
  const results: string[] = [];
  const pattern = /<([a-z][a-z0-9]*)\b([^>]*\bitemprop\s*=\s*["']([^"']+)["'][^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  for (const match of html.matchAll(pattern)) {
    if (!names.some((name) => match[3].split(/\s+/).includes(name))) continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(match[2])?.[1];
    results.push(content ?? match[4]);
    if (results.length >= importLimits.maxListItems) break;
  }
  return results;
}

function fromMicrodata(html: string): PageExtraction | undefined {
  const start = html.search(/itemtype\s*=\s*["']https?:\/\/schema\.org\/Recipe["']/i);
  if (start < 0) return undefined;
  const scope = html.slice(start);

  const ingredients = cleanList(propertyHtml(scope, ["recipeIngredient", "ingredients"]));
  const steps = cleanList(
    propertyHtml(scope, ["recipeInstructions"]).flatMap((part) =>
      /<(?:li|p|br)\b/i.test(part) ? part.split(/<\/?(?:li|ol|ul|p)\b[^>]*>|<br\s*\/?>/gi) : [part],
    ),
  );
  if (ingredients.length === 0 && steps.length === 0) return undefined;

  return {
    origin: "microdata",
    finalUrl: "",
    title: cleanList(propertyHtml(scope, ["name"]).slice(0, 1))[0],
    yieldText: cleanList(propertyHtml(scope, ["recipeYield"]).slice(0, 1))[0],
    ingredients,
    steps,
    media: mediaFrom({}, html),
  };
}

// --- Meta tags and readable text -------------------------------------------------------------------

export function metaTags(html: string): Record<string, string> {
  const tags: Record<string, string> = {};
  const head = html.slice(0, 200_000);
  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(match[0])?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(match[0])?.[1];
    if (key && content !== undefined && !(key in tags)) tags[key] = decodeEntities(content).trim();
  }
  return tags;
}

function pageTitle(html: string, meta: Record<string, string>): string | undefined {
  const title = meta["og:title"] ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return title ? clip(inline(title)) || undefined : undefined;
}

/** Main readable text of a page. It stays small and is only returned when no structured recipe exists. */
export function readableText(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const scoped = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body)?.[2] ?? body;
  const stripped = scoped.replace(/<(nav|header|footer|aside|form|button|select|iframe)\b[\s\S]*?<\/\1>/gi, " ");
  const text = htmlToText(stripped);
  return text.length > importLimits.maxTextChars ? text.slice(0, importLimits.maxTextChars) : text;
}

/** Reads a recipe from page HTML: structured data first, then microdata, then the page text. */
export function extractRecipe(html: string, finalUrl: string): PageExtraction {
  const structured = fromJsonLd(html) ?? fromMicrodata(html);
  const meta = metaTags(html);
  if (structured) {
    return {
      ...structured,
      finalUrl,
      title: structured.title ?? pageTitle(html, meta),
      description: structured.description ?? (meta["og:description"] ? clip(inline(meta["og:description"])) : undefined),
    };
  }

  const text = readableText(html);
  const description = meta["og:description"] ?? meta.description;
  return {
    origin: text || description ? "page-text" : "none",
    finalUrl,
    title: pageTitle(html, meta),
    description: description ? clip(inline(description)) : undefined,
    ingredients: [],
    steps: [],
    text: text || undefined,
    media: mediaFrom({}, html),
  };
}
