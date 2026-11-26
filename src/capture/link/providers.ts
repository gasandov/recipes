import { formatMeasuredAmount, normalizeLookupText } from "../../domain";
import type { CapturedIngredient, CapturedRecipe } from "../contract";

/**
 * Provider contracts for sources that need more than a plain public web page.
 *
 * Verified 2026-11-22 against Meta's developer documentation:
 * - Instagram and Facebook oEmbed work without a token since 2026-06-15 (1,000 requests per hour per
 *   endpoint), but only return embed HTML for public posts. The terms say its metadata and content may
 *   be used only to display the post. Consuming, extracting or persisting it, such as reading a caption
 *   to build a recipe, is prohibited. https://developers.facebook.com/docs/instagram-platform/oembed
 *   https://developers.facebook.com/blog/post/2026/06/15/tokenless-access-to-meta-oembed-apis/
 * - oEmbed does not expose video or audio files, so OCR and speech have nothing they may process.
 * - Reading someone's captions or media through the Graph API requires that account's own authorization.
 * - Fetching instagram.com or facebook.com pages directly returns login shells, and bypassing that
 *   access control is out of scope.
 * The built-in adapters therefore declare these sources unsupported. A future adapter may implement
 * `readPublicCaption` only when it has explicit authorization to read that content.
 */

export type SocialProvider = "instagram" | "facebook";

export type MediaSource = {
  kind: "image" | "video" | "audio";
  url: string;
  /** Only user-provided files or media a page itself publishes are valid origins. */
  origin: "page-structured-data" | "user-file";
};

export type ProviderResult<T> =
  | { status: "ok"; value: T }
  | { status: "unsupported" | "inaccessible" | "not-configured" | "failed"; reason: string };

export type SocialCaption = { caption: string; media?: MediaSource[] };

export interface SocialLinkAdapter {
  readonly provider: SocialProvider;
  readonly access: {
    captions: "unsupported" | "authorized-only";
    media: "unsupported" | "authorized-only";
    /** es-MX explanation shown to the user. */
    reason: string;
    verifiedOn: string;
    sources: readonly string[];
  };
  matches(url: URL): boolean;
  /** Present only on adapters that are authorized to read the post. The built-in adapters omit it. */
  readPublicCaption?(url: URL, options: { signal?: AbortSignal }): Promise<ProviderResult<SocialCaption>>;
}

const metaSources = [
  "https://developers.facebook.com/docs/instagram-platform/oembed",
  "https://developers.facebook.com/blog/post/2026/06/15/tokenless-access-to-meta-oembed-apis/",
] as const;

const metaReason =
  "Meta solo permite mostrar las publicaciones públicas, no leer su texto ni sus videos para otros fines. " +
  "Pega la descripción tú mismo o escribe la receta manualmente.";

const within = (host: string, domains: string[]) => domains.some((domain) => host === domain || host.endsWith(`.${domain}`));

export const instagramAdapter: SocialLinkAdapter = {
  provider: "instagram",
  access: { captions: "unsupported", media: "unsupported", reason: metaReason, verifiedOn: "2026-11-22", sources: metaSources },
  matches: (url) => within(url.hostname.toLowerCase(), ["instagram.com", "instagr.am"]),
};

export const facebookAdapter: SocialLinkAdapter = {
  provider: "facebook",
  access: { captions: "unsupported", media: "unsupported", reason: metaReason, verifiedOn: "2026-11-22", sources: metaSources },
  matches: (url) => within(url.hostname.toLowerCase(), ["facebook.com", "fb.com", "fb.watch", "fb.me"]),
};

export const socialAdapters: readonly SocialLinkAdapter[] = [instagramAdapter, facebookAdapter];

// --- OCR and speech -------------------------------------------------------------------------------

export type MediaText = {
  text: string;
  language?: string;
  /** 0 to 1 when the engine reports it. */
  confidence?: number;
};

/**
 * Turns media the app may process into text. Implementations must not store the media after returning,
 * must not be given private or access-controlled URLs, and report `unavailable` when no engine is set up.
 */
export interface MediaTextExtractor {
  readonly capability: "ocr" | "speech";
  readonly availability: { status: "available" } | { status: "unavailable"; reason: string };
  extract(media: MediaSource, options: { signal?: AbortSignal; language?: string }): Promise<ProviderResult<MediaText>>;
}

function unavailable(capability: "ocr" | "speech", reason: string): MediaTextExtractor {
  return {
    capability,
    availability: { status: "unavailable", reason },
    extract: async () => ({ status: "unsupported", reason }),
  };
}

/** No OCR engine ships with the app yet, and no cloud engine is configured. */
export const unavailableOcr = unavailable(
  "ocr",
  "El reconocimiento de texto en imágenes y video todavía no está disponible.",
);

/** No transcription engine ships with the app yet, and no cloud engine is configured. */
export const unavailableSpeech = unavailable(
  "speech",
  "La transcripción de audio de enlaces todavía no está disponible.",
);

// --- Combining sources ----------------------------------------------------------------------------

export type LabeledDraft = { label: string; draft: CapturedRecipe };

function describeAmount(ingredient: CapturedIngredient): string {
  const amount = ingredient.amount;
  if (amount.kind === "measured") return `${formatMeasuredAmount(amount)} ${amount.unit}`;
  if (amount.kind === "qualitative") return amount.text;
  return "sin cantidad";
}

/**
 * Combines drafts from several sources of the same recipe, for example a caption and an audio
 * transcript. The first draft wins. Items that only another source has are appended as pending, and
 * every disagreement becomes a notice so the user decides in the editor. Nothing is resolved silently.
 */
export function mergeCapturedSources(sources: readonly LabeledDraft[]): CapturedRecipe {
  const [primary, ...others] = sources;
  if (!primary) return { ingredients: [], steps: [] };

  const merged: CapturedRecipe = {
    ...primary.draft,
    ingredients: primary.draft.ingredients.map((ingredient) => ({ ...ingredient })),
    steps: [...primary.draft.steps],
    notices: [...(primary.draft.notices ?? [])],
  };
  const notices = merged.notices as string[];

  for (const { label, draft } of others) {
    if (draft.name && merged.name && normalizeLookupText(draft.name) !== normalizeLookupText(merged.name)) {
      notices.push(`El nombre difiere: "${merged.name}" (${primary.label}) y "${draft.name}" (${label}).`);
    }
    merged.name ??= draft.name;

    if (draft.portions !== undefined && merged.portions !== undefined && draft.portions !== merged.portions) {
      notices.push(`Las porciones difieren: ${merged.portions} (${primary.label}) y ${draft.portions} (${label}).`);
    }
    merged.portions ??= draft.portions;

    for (const ingredient of draft.ingredients) {
      const key = normalizeLookupText(ingredient.name);
      const existing = merged.ingredients.find((item) => normalizeLookupText(item.name) === key);
      if (!existing) {
        merged.ingredients.push(ingredient);
        notices.push(`"${ingredient.name}" solo aparece en ${label}. Confirma que va en la receta.`);
        continue;
      }
      const left = describeAmount(existing);
      const right = describeAmount(ingredient);
      if (left !== right && existing.amount.kind !== "unspecified" && ingredient.amount.kind !== "unspecified") {
        notices.push(`La cantidad de "${existing.name}" difiere: ${left} (${primary.label}) y ${right} (${label}).`);
      } else if (existing.amount.kind === "unspecified" && ingredient.amount.kind !== "unspecified") {
        existing.amount = ingredient.amount;
        notices.push(`La cantidad de "${existing.name}" (${right}) viene de ${label}. Confírmala.`);
      }
    }

    if (draft.steps.length > 0 && merged.steps.length === 0) {
      merged.steps = [...draft.steps];
      notices.push(`Los pasos vienen de ${label}.`);
    } else if (draft.steps.length > 0 && draft.steps.length !== merged.steps.length) {
      notices.push(`El número de pasos difiere: ${merged.steps.length} (${primary.label}) y ${draft.steps.length} (${label}).`);
    }
  }
  return merged;
}
