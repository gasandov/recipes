export type LinkKind = "web" | "instagram" | "facebook";

export type ParsedLink =
  | { ok: true; kind: LinkKind; sourceUrl: string; requestUrl: string }
  | { ok: false };

const instagramHosts = ["instagram.com", "instagr.am"];
const facebookHosts = ["facebook.com", "fb.com", "fb.watch", "fb.me"];

const inDomain = (host: string, domains: string[]) => domains.some((domain) => host === domain || host.endsWith(`.${domain}`));

/**
 * Normalizes what the user pasted or shared. `sourceUrl` is stored with the recipe exactly as given
 * (plus a scheme when it was omitted). `requestUrl` upgrades http to https for the importer.
 */
export function parseLinkInput(input: string): ParsedLink {
  let text = input.trim();
  if (!text || /\s/.test(text)) return { ok: false };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text) && /^[\w-]+(?:\.[\w-]+)+(?:[/?#]|$)/.test(text)) text = `https://${text}`;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false };
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname.includes(".")) {
    return { ok: false };
  }

  // Links shared from the Meta apps are often wrapped, such as l.facebook.com/l.php?u=<target>.
  // When the wrapped target is itself a valid link, classify and import that instead.
  if (/^l\.(?:facebook|instagram)\.com$/i.test(url.hostname)) {
    const target = url.searchParams.get("u");
    const inner = target && target !== input ? parseLinkInput(target) : undefined;
    if (inner?.ok) return inner;
  }

  const host = url.hostname.toLowerCase();
  const kind: LinkKind = inDomain(host, instagramHosts) ? "instagram" : inDomain(host, facebookHosts) ? "facebook" : "web";
  const secure = new URL(url);
  secure.protocol = "https:";
  return { ok: true, kind, sourceUrl: url.href, requestUrl: secure.href };
}
