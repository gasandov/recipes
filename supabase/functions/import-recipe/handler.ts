import { bearerToken } from "../_shared/auth.ts";
import type { VerifyUser } from "../_shared/auth.ts";
import { createUserRateLimiter } from "../_shared/rate-limit.ts";
import { readRequestBody } from "../_shared/request-body.ts";
import { extractRecipe } from "./extract.ts";
import { fetchPage } from "./fetcher.ts";
import type { DnsResolver, FetchLike } from "./fetcher.ts";
import { parseImportUrl, policyConfigured } from "./guard.ts";
import type { HostPolicy } from "./guard.ts";
import { importLimits } from "./protocol.ts";
import type { ImportErrorCode, ImportResponse } from "./protocol.ts";

export type HandlerConfig = {
  /** Browser origins that may call the function, such as `https://example.github.io`. */
  allowedOrigins: string[];
  /** Accept requests with no `Origin` header (curl, local smoke tests). Leave false in production. */
  allowMissingOrigin?: boolean;
  policy: HostPolicy;
  /** Requests per user per minute, counted per function instance. */
  perUserPerMinute?: number;
};

export type HandlerDeps = {
  fetch: FetchLike;
  verifyUser: VerifyUser;
  resolveDns?: DnsResolver;
  now?: () => number;
};

const statusByCode: Record<ImportErrorCode, number> = {
  bad_request: 400,
  invalid_url: 400,
  unsafe_destination: 422,
  not_allowed: 422,
  unsupported_source: 422,
  unauthorized: 401,
  forbidden_origin: 403,
  not_configured: 503,
  rate_limited: 429,
  inaccessible: 200,
  busy: 200,
  upstream_error: 200,
  too_many_redirects: 200,
  timeout: 200,
  too_large: 200,
  not_html: 200,
};

/** Builds the request handler. It uses only Web APIs so the same code runs in Deno and in tests. */
export function createHandler(config: HandlerConfig, deps: HandlerDeps): (request: Request) => Promise<Response> {
  const allowRate = createUserRateLimiter(config.perUserPerMinute ?? 20, deps.now);

  function reply(code: ImportErrorCode | undefined, body: ImportResponse, origin: string | null): Response {
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      vary: "Origin",
    });
    if (origin && config.allowedOrigins.includes(origin)) headers.set("access-control-allow-origin", origin);
    return new Response(JSON.stringify(body), { status: code ? statusByCode[code] : 200, headers });
  }

  return async (request) => {
    const origin = request.headers.get("origin");
    const originAllowed = origin ? config.allowedOrigins.includes(origin) : config.allowMissingOrigin === true;

    if (request.method === "OPTIONS") {
      if (!origin || !originAllowed) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
          "access-control-max-age": "600",
          vary: "Origin",
        },
      });
    }

    const fail = (code: ImportErrorCode) => reply(code, { ok: false, code }, origin);

    if (config.allowedOrigins.length === 0 || !policyConfigured(config.policy)) return fail("not_configured");
    if (!originAllowed) return fail("forbidden_origin");
    if (request.method !== "POST") return fail("bad_request");

    const token = bearerToken(request.headers.get("authorization"));
    const user = token ? await deps.verifyUser(token) : undefined;
    if (!user) return fail("unauthorized");
    if (!allowRate(user.id)) return fail("rate_limited");

    if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
      return fail("bad_request");
    }
    let payload: unknown;
    try {
      const body = await readRequestBody(request, importLimits.maxRequestBytes);
      if (!body) return fail("bad_request");
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      return fail("bad_request");
    }

    const target = parseImportUrl((payload as { url?: unknown } | null)?.url);
    if (!target.ok) return fail(target.code);

    const page = await fetchPage(target.url, { fetch: deps.fetch, resolveDns: deps.resolveDns, policy: config.policy });
    if (!page.ok) return fail(page.code);

    // Only extracted values leave the function, never the fetched body.
    return reply(undefined, { ok: true, extraction: extractRecipe(page.html, page.finalUrl) }, origin);
  };
}
