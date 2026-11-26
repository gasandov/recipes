/**
 * Wire contract between the `import-recipe` function and the app.
 *
 * This file has no imports so that both the Deno function and the browser bundle can use it.
 * The function never returns the fetched page. It returns only the values extracted below.
 */

export const MAX_URL_LENGTH = 2048;

export type ImportErrorCode =
  | "bad_request"
  | "invalid_url"
  | "unsafe_destination"
  | "not_allowed"
  | "unsupported_source"
  | "unauthorized"
  | "forbidden_origin"
  | "not_configured"
  | "rate_limited"
  | "inaccessible"
  | "busy"
  | "upstream_error"
  | "too_many_redirects"
  | "timeout"
  | "too_large"
  | "not_html";

export type ExtractionOrigin = "json-ld" | "microdata" | "page-text" | "none";

export type MediaReference = { kind: "image" | "video"; url: string };

/** Raw strings read from a public page, before the app parses amounts. */
export type PageExtraction = {
  origin: ExtractionOrigin;
  /** The URL that finally answered, after validated redirects. */
  finalUrl: string;
  title?: string;
  /** Text of `recipeYield` exactly as the page states it. */
  yieldText?: string;
  description?: string;
  ingredients: string[];
  steps: string[];
  /** Readable page text, only when the page has no structured recipe. Capped. */
  text?: string;
  /** Public media URLs found in the page. They are never downloaded by the function. */
  media: MediaReference[];
};

export type ImportRequest = { url: string };

export type ImportResponse =
  | { ok: true; extraction: PageExtraction }
  | { ok: false; code: ImportErrorCode };

export const importLimits = {
  /** Largest HTML body read from a page. */
  maxBodyBytes: 2_500_000,
  /** Overall time for DNS, redirects and download. */
  timeoutMs: 9_000,
  maxRedirects: 3,
  maxRequestBytes: 4_096,
  maxTextChars: 30_000,
  maxListItems: 200,
  maxItemChars: 1_500,
  maxMedia: 4,
} as const;
