import { hostAllowed, isPrivateAddress, isUnsupportedSource, parseImportUrl } from "./guard.ts";
import type { HostPolicy } from "./guard.ts";
import { importLimits } from "./protocol.ts";
import type { ImportErrorCode } from "./protocol.ts";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Returns the A and AAAA answers for a name. Throws or returns `[]` when the name does not resolve. */
export type DnsResolver = (hostname: string) => Promise<string[]>;

export type FetchDeps = {
  fetch: FetchLike;
  /** Required in public mode. Optional when an explicit host allowlist is configured. */
  resolveDns?: DnsResolver;
  policy: HostPolicy;
};

export type PageFetch =
  | { ok: true; html: string; finalUrl: string }
  | { ok: false; code: ImportErrorCode };

export const userAgent = "RecetarioImporter/1.0 (user-initiated single page read; no crawling)";

const htmlTypes = /^(?:text\/html|application\/xhtml\+xml)\b/i;

/**
 * Reads one public HTML page for the signed-in user.
 *
 * Every hop, including the first, is validated before any request: HTTPS only, port 443, a public DNS
 * name that the policy allows, and (when a resolver is available) no private DNS answers. Redirects
 * are followed by hand so that each `Location` goes through the same checks. The body is read with a
 * hard byte cap and the whole operation shares one deadline.
 *
 * Known limit: the runtime resolves the name again when it connects, so a hostile DNS server could
 * answer differently between the check and the connection. An explicit allowlist removes that risk
 * for the listed hosts, because the operator chose to trust them.
 */
type FetchLimits = { maxBodyBytes: number; timeoutMs: number; maxRedirects: number };

export async function fetchPage(start: URL, deps: FetchDeps, limits: FetchLimits = importLimits): Promise<PageFetch> {
  const deadline = AbortSignal.timeout(limits.timeoutMs);
  let current = start;

  try {
    for (let hop = 0; hop <= limits.maxRedirects; hop++) {
      const checked = await checkDestination(current, deps);
      if (checked) return { ok: false, code: checked };

      const response = await deps.fetch(current.href, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        signal: deadline,
        headers: {
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "accept-language": "es-MX,es;q=0.9,en;q=0.5",
          "user-agent": userAgent,
        },
      });

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) return { ok: false, code: "upstream_error" };
        if (hop === limits.maxRedirects) return { ok: false, code: "too_many_redirects" };

        const next = parseImportUrl(safeResolve(location, current));
        if (!next.ok) return { ok: false, code: "unsafe_destination" };
        current = next.url;
        continue;
      }

      const failure = statusFailure(response.status);
      if (failure) {
        await response.body?.cancel();
        return { ok: false, code: failure };
      }

      if (!htmlTypes.test(response.headers.get("content-type") ?? "")) {
        await response.body?.cancel();
        return { ok: false, code: "not_html" };
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > limits.maxBodyBytes) {
        await response.body?.cancel();
        return { ok: false, code: "too_large" };
      }

      const bytes = await readCapped(response, limits.maxBodyBytes, deadline);
      if (!bytes) return { ok: false, code: "too_large" };
      return {
        ok: true,
        html: decodeBody(bytes, response.headers.get("content-type") ?? ""),
        finalUrl: current.href,
      };
    }
    return { ok: false, code: "too_many_redirects" };
  } catch (error) {
    if (deadline.aborted || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))) {
      return { ok: false, code: "timeout" };
    }
    return { ok: false, code: "upstream_error" };
  }
}

function safeResolve(location: string, base: URL): string {
  try {
    return new URL(location, base).href;
  } catch {
    return "";
  }
}

function statusFailure(status: number): ImportErrorCode | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 429) return "busy";
  if (status >= 500) return "upstream_error";
  // 401, 403, 404, 410, 451 and the rest: the page is not publicly readable from here. Never retry with
  // other identities or headers to get around an access control.
  return "inaccessible";
}

async function checkDestination(url: URL, deps: FetchDeps): Promise<ImportErrorCode | undefined> {
  // Re-run the syntactic checks on every hop, not only on the first URL.
  const parsed = parseImportUrl(url.href);
  if (!parsed.ok) return parsed.code === "invalid_url" ? "invalid_url" : "unsafe_destination";
  if (isUnsupportedSource(url.hostname)) return "unsupported_source";
  if (!hostAllowed(url.hostname, deps.policy)) return "not_allowed";

  const publicMode = deps.policy.allowedHosts.length === 0;
  if (!deps.resolveDns) return publicMode ? "not_configured" : undefined;

  let addresses: string[];
  try {
    addresses = await deps.resolveDns(url.hostname);
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return name === "PermissionDenied" || name === "NotCapable" || name === "NotSupported" || error instanceof TypeError
      ? "not_configured"
      : "inaccessible";
  }
  if (addresses.length === 0) return "inaccessible";
  if (addresses.some(isPrivateAddress)) return "unsafe_destination";
  return undefined;
}

async function readCapped(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | undefined> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException("Timed out", "TimeoutError");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function charsetOf(contentType: string, head: string): string {
  const header = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  return (header ?? meta ?? "utf-8").toLowerCase();
}

export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const charset = charsetOf(contentType, head);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
