import { socialAdapters } from "../link/providers";

/**
 * Which image addresses the app may fetch for OCR. Only media a public page itself lists is ever
 * considered, and never anything served from Meta, which requires a login and whose terms do not
 * allow reading content other than to display it. The check runs again on the final address after
 * redirects. It is a courtesy to the user, not a security boundary: the browser still enforces CORS.
 */

/** CDN hosts that serve Instagram and Facebook media. They are covered by the same restriction as the sites. */
const metaMediaDomains = ["cdninstagram.com", "fbcdn.net", "fbsbx.com"];

const within = (host: string, domains: readonly string[]) => domains.some((domain) => host === domain || host.endsWith(`.${domain}`));

export type MediaUrlCheck = { ok: true; url: URL } | { ok: false; reason: "invalid" | "insecure" | "private-host" | "social" };

export function checkPublicMediaUrl(raw: string): MediaUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "insecure" };
  if (url.username || url.password) return { ok: false, reason: "invalid" };

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const literalAddress = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
  const local = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");
  if (literalAddress || local || !host.includes(".")) return { ok: false, reason: "private-host" };

  if (socialAdapters.some((adapter) => adapter.matches(url)) || within(host, metaMediaDomains)) {
    return { ok: false, reason: "social" };
  }
  return { ok: true, url };
}
