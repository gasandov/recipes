import { mediaLimits } from "./limits";
import type { MediaFailure } from "./messages";
import { checkPublicMediaUrl } from "./policy";

export type FetchImageOptions = {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  maxBytes?: number;
  timeoutMs?: number;
};

export type FetchImageResult = { ok: true; blob: Blob } | { ok: false; failure: MediaFailure };

const imageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);

/** Read a body with a hard byte cap, so a lying or missing Content-Length cannot make the app buffer more. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return undefined;
  if (!response.body) return undefined;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Downloads one public image the page itself lists, directly from the browser.
 *
 * It is a plain CORS request with no cookies, no referrer and no cache. When the host does not send CORS
 * headers the browser refuses to expose the bytes and this returns `cors-or-network`; the app does not
 * try to get around that with `no-cors`, a proxy or an embedded frame. Nothing is stored: the caller
 * receives a Blob that lives in memory until it is dropped.
 */
export async function fetchPublicImage(rawUrl: string, options: FetchImageOptions = {}): Promise<FetchImageResult> {
  const checked = checkPublicMediaUrl(rawUrl);
  if (!checked.ok) return { ok: false, failure: "blocked-source" };

  const maxBytes = options.maxBytes ?? mediaLimits.maxImageBytes;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? mediaLimits.fetchTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const send = options.fetch ?? fetch;

  try {
    const response = await send(checked.url.href, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg;q=0.9" },
      signal,
    });
    // A redirect may land somewhere that is not allowed, such as a Meta host.
    if (response.url && !checkPublicMediaUrl(response.url).ok) return { ok: false, failure: "blocked-source" };
    if (!response.ok) return { ok: false, failure: "http-error" };

    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!imageTypes.has(type)) return { ok: false, failure: "not-image" };

    const bytes = await readCapped(response, maxBytes);
    if (!bytes) return { ok: false, failure: "too-large" };
    return { ok: true, blob: new Blob([bytes], { type }) };
  } catch {
    if (options.signal?.aborted) return { ok: false, failure: "aborted" };
    if (timeout.aborted) return { ok: false, failure: "timeout" };
    return { ok: false, failure: "cors-or-network" };
  }
}
