import type { CapturedRecipe } from "../contract";
import type { ImportResponse, MediaReference, PageExtraction } from "../../../supabase/functions/import-recipe/protocol.ts";
import { draftFromExtraction, manualDraft } from "./map";
import { failureMessages } from "./messages";
import type { LinkFailure } from "./messages";
import { parseLinkInput } from "./source";

export type LinkImportOptions = {
  /** URL of the `import-recipe` function. Public configuration, never a secret. */
  endpoint?: string;
  /** Returns the signed-in user's access token. The importer rejects requests without one. */
  getAccessToken?: () => Promise<string | undefined> | string | undefined;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type LinkImportOutcome =
  | {
      status: "draft";
      draft: CapturedRecipe;
      origin: PageExtraction["origin"];
      /** Public media the page lists. Nothing was downloaded; the user may ask to read an image with local OCR. */
      media: MediaReference[];
    }
  | {
      status: "failed";
      failure: LinkFailure;
      /** An es-MX explanation ready to show. */
      message: string;
      /** Opens the manual editor with the source link and the reason prefilled. */
      fallback: CapturedRecipe;
      /** Set when pasting the page or caption text could still help. */
      canPasteText: boolean;
      /** Public media the page lists, when it opened but had no readable recipe. Empty for every other failure. */
      media: MediaReference[];
    };

function failed(failure: LinkFailure, sourceUrl: string | undefined, draft?: CapturedRecipe, media: MediaReference[] = []): LinkImportOutcome {
  const message = failureMessages[failure];
  return {
    status: "failed",
    failure,
    message,
    fallback: draft ?? manualDraft(sourceUrl, message),
    canPasteText: failure === "unsupported-social" || failure === "unsupported_source" || failure === "no-recipe-data" || failure === "inaccessible",
    media,
  };
}

/** Media references that are well formed. Older functions or odd pages may omit the list. */
function listedMedia(extraction: PageExtraction): MediaReference[] {
  if (!Array.isArray(extraction.media)) return [];
  return extraction.media.filter(
    (item): item is MediaReference => typeof item === "object" && item !== null && (item.kind === "image" || item.kind === "video") && typeof item.url === "string",
  );
}

function isImportResponse(value: unknown): value is ImportResponse {
  if (typeof value !== "object" || value === null) return false;
  const body = value as { ok?: unknown; code?: unknown; extraction?: unknown };
  if (body.ok === true) {
    const extraction = body.extraction as Partial<PageExtraction> | undefined;
    return typeof extraction === "object" && extraction !== null && Array.isArray(extraction.ingredients) && Array.isArray(extraction.steps);
  }
  return body.ok === false && typeof body.code === "string" && body.code in failureMessages;
}

/**
 * Imports a recipe from a link the user pasted or shared.
 *
 * Web pages go through the authenticated import function. Instagram and Facebook links are never
 * sent to it, because their official embed APIs only allow displaying a post, not reading its text,
 * and their pages require a login. Those links return a failure that offers pasting the caption.
 * Every failure carries a manual-entry draft with the original link.
 */
export async function importRecipeFromLink(input: string, options: LinkImportOptions = {}): Promise<LinkImportOutcome> {
  const link = parseLinkInput(input);
  if (!link.ok) return failed("invalid-link", undefined);
  if (link.kind !== "web") return failed("unsupported-social", link.sourceUrl);
  if (!options.endpoint) return failed("not-configured", link.sourceUrl);

  const token = await options.getAccessToken?.();
  if (!token) return failed("sign-in-required", link.sourceUrl);

  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const send = options.fetch ?? fetch;

  let response: Response;
  try {
    response = await send(options.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: link.requestUrl }),
      credentials: "omit",
      signal,
    });
  } catch {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (timeout.aborted) return failed("timeout", link.sourceUrl);
    return failed(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "network", link.sourceUrl);
  }

  // The platform gateway rejects an expired or invalid session before the function runs, with its own body.
  if (response.status === 401) return failed("unauthorized", link.sourceUrl);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return failed(response.status === 401 ? "unauthorized" : "bad-response", link.sourceUrl);
  }
  // A caller that cancelled must never receive a result, even if the transport ignored the signal.
  if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (!isImportResponse(body)) return failed("bad-response", link.sourceUrl);
  if (!body.ok) return failed(body.code, link.sourceUrl);

  const { draft, usable } = draftFromExtraction(body.extraction, link.sourceUrl);
  if (!usable) {
    const message = failureMessages["no-recipe-data"];
    return failed("no-recipe-data", link.sourceUrl, { ...draft, notices: [message] }, listedMedia(body.extraction));
  }
  return { status: "draft", draft, origin: body.extraction.origin, media: listedMedia(body.extraction) };
}
