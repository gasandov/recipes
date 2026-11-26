import { MAX_URL_LENGTH } from "./protocol.ts";

/** Which hosts the function may contact. Both fields empty means the function is not configured. */
export type HostPolicy = {
  /** Exact hosts (`example.com`) or subdomain wildcards (`*.example.com`). */
  allowedHosts: string[];
  /** Opt in to any public host. It still needs DNS checks and rejects private addresses. */
  allowAnyPublicHost: boolean;
};

export type UrlCheck =
  | { ok: true; url: URL }
  | { ok: false; code: "invalid_url" | "unsafe_destination" };

const blockedSuffixes = [
  "localhost", "local", "internal", "lan", "home", "corp", "intranet", "private", "invalid", "test", "onion",
  "home.arpa", "localdomain",
];

/**
 * Accepts only credential-free HTTPS URLs on port 443 whose host is a public-looking DNS name.
 * The check runs on the WHATWG-parsed URL, which normalizes forms such as `2130706433` and `0x7f.1`.
 */
export function parseImportUrl(input: unknown): UrlCheck {
  if (typeof input !== "string") return { ok: false, code: "invalid_url" };
  const text = input.trim();
  if (!text || text.length > MAX_URL_LENGTH || /[\s\p{Cc}\\]/u.test(text)) {
    return { ok: false, code: "invalid_url" };
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, code: "invalid_url" };
  }

  if (url.protocol !== "https:") return { ok: false, code: url.protocol === "http:" ? "unsafe_destination" : "invalid_url" };
  if (url.username || url.password) return { ok: false, code: "unsafe_destination" };
  if (url.port !== "" && url.port !== "443") return { ok: false, code: "unsafe_destination" };
  if (!isPublicDnsName(url.hostname)) return { ok: false, code: "unsafe_destination" };
  return { ok: true, url };
}

/** True for a multi-label DNS name that is not an address literal or a reserved local suffix. */
export function isPublicDnsName(hostname: string): boolean {
  const host = hostname.toLowerCase();
  // A trailing dot makes a name absolute. Reject it rather than reason about two spellings.
  if (!host || host.endsWith(".") || host.startsWith("[") || host.includes(":")) return false;

  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;

  // An all-digit or hexadecimal last label is an IPv4 spelling, even when WHATWG left it as a name.
  const last = labels[labels.length - 1];
  if (/^\d+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) return false;
  if (labels.every((label) => /^(?:\d+|0x[0-9a-f]+)$/.test(label))) return false;

  return !blockedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Instagram and Facebook are never fetched. Their pages sit behind a login and Meta's terms only allow
 * displaying their posts, not reading them. The app routes these links to manual entry or pasted text.
 */
const unsupportedSources = ["instagram.com", "instagr.am", "facebook.com", "fb.com", "fb.watch", "fb.me", "fbcdn.net", "cdninstagram.com"];

export function isUnsupportedSource(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return unsupportedSources.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function hostAllowed(hostname: string, policy: HostPolicy): boolean {
  const host = hostname.toLowerCase();
  if (policy.allowedHosts.length > 0) {
    return policy.allowedHosts.some((entry) => {
      const pattern = entry.trim().toLowerCase();
      if (!pattern) return false;
      if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
      return host === pattern;
    });
  }
  return policy.allowAnyPublicHost;
}

export function policyConfigured(policy: HostPolicy): boolean {
  return policy.allowedHosts.some((entry) => entry.trim() !== "") || policy.allowAnyPublicHost;
}

/** Parses `a.example, *.b.example` style configuration. */
export function parseHostList(value: string | undefined): string[] {
  return (value ?? "").split(/[\s,]+/).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

// --- Address checks for DNS answers ---------------------------------------------------------------

function ipv4Octets(address: string): number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

export function isPrivateIpv4(address: string): boolean {
  const octets = ipv4Octets(address);
  if (!octets) return true; // Unparseable answers are treated as unsafe.
  const [a, b, c] = octets;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function expandIpv6(address: string): number[] | undefined {
  let text = address.toLowerCase().replace(/%.*$/, "");
  const embedded = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (embedded) {
    const octets = ipv4Octets(embedded[2]);
    if (!octets) return undefined;
    text = `${embedded[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(text) || text.split("::").length > 2) return undefined;

  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (text.includes("::") ? missing < 1 : missing !== 0) return undefined;
  const groups = [...left, ...Array<string>(text.includes("::") ? missing : 0).fill("0"), ...right];
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return groups.map((group) => parseInt(group, 16));
}

export function isPrivateIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

  if (groups.every((group) => group === 0)) return true; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && g7 === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible and NAT64 (64:ff9b::/96) embed an IPv4 address.
  const embeddedV4 = `${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return isPrivateIpv4(embeddedV4);
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateIpv4(embeddedV4);
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x2002) return isPrivateIpv4(`${g1 >> 8}.${g1 & 255}.${g2 >> 8}.${g2 & 255}`); // 6to4
  return false;
}

export function isPrivateAddress(address: string): boolean {
  return address.includes(":") ? isPrivateIpv6(address) : isPrivateIpv4(address);
}
