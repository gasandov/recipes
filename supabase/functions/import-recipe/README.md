# import-recipe

Reads one public recipe page for a signed-in user and returns only the extracted values
(`PageExtraction` in `protocol.ts`). It never returns the fetched page, so it is not a general proxy.

## Request

`POST` JSON `{ "url": "https://..." }` with `Authorization: Bearer <user access token>`.
Response: `{ ok: true, extraction }` or `{ ok: false, code }` (codes in `protocol.ts`).

## Configuration (server-side secrets and settings)

| Variable | Purpose |
| --- | --- |
| `IMPORT_ALLOWED_ORIGINS` | Comma-separated browser origins (for example `https://gasandov.github.io`). Required. |
| `IMPORT_ALLOWED_HOSTS` | Comma-separated trusted recipe hosts. Required. Prefer exact hosts such as `www.budgetbytes.com`. |
| `IMPORT_ALLOW_MISSING_ORIGIN` | `true` only for local smoke tests without a browser. |
| `IMPORT_SUPABASE_API_KEY` | Only if neither `SUPABASE_ANON_KEY` nor `SUPABASE_PUBLISHABLE_KEYS` (JSON, key `default`) is injected. |

With no trusted hosts configured, every import returns `not_configured`.
Supabase keeps `verify_jwt = true` by default, and that is fine to leave on, but this function does not depend on it:
the gateway check only proves a token was issued for the project (the public anon key passes it), so the function
always verifies the session itself through `/auth/v1/user`. Do not set `verify_jwt = false` to work around a 401.

## Controls

- Auth: the gateway checks the JWT, and the function also asks `/auth/v1/user`, which rejects the public
  anon key, expired sessions and anonymous users. 20 requests per user per minute per instance.
- Destination: HTTPS, port 443, no credentials, public multi-label DNS names only (no IP literals, `localhost`,
  `.local`, `.internal`, trailing dots), checked after WHATWG parsing. Instagram and Facebook hosts are refused.
- DNS: A and AAAA answers must all be public (private, loopback, link-local, CGNAT, mapped and NAT64 ranges are rejected).
- Redirects: followed by hand, at most 3, each hop re-validated and re-resolved.
- Limits: 9 s overall deadline, 2.5 MB body cap (declared and streamed), HTML content types only, 30,000 characters of text.
- Request hygiene: no cookies or credentials, honest `User-Agent`, 401/403/404/429 are reported, never worked around.
- The allowlist limits which DNS operators the application trusts. Each redirect must stay on that list.
  Robots.txt is not consulted.

## Source access spike (2026-11-22, honest user agent, single requests)

| Source | Result |
| --- | --- |
| bbcgoodfood.com, budgetbytes.com, pinchofyum.com, allrecipes.com | Server-rendered `Recipe` JSON-LD. Ingredients, steps, yield and media URLs read live through this function under Deno. Allrecipes and Serious Eats returned 403 to a browser-like user agent but allrecipes answered the honest one. |
| kiwilimon.com | Recipe JSON-LD is injected by JavaScript, so a plain fetch has none. The visible text is only page chrome (about 180 characters, no recipe headings), so the app reports "no readable recipe" and offers pasting text or manual entry. |
| recetasgratis.net, simplyrecipes.com, muydelish.com | 404 or 403 from this network. Reported as inaccessible. |
| instagram.com post and reel | HTTP 200 login shell titled "Instagram", no caption or media. |
| facebook.com watch/reel | Public meta description only for some videos, behind a login wall otherwise. |

Meta oEmbed (tokenless since 2026-06-15, 1,000 requests per hour per endpoint) returns embed HTML, and Meta's terms
restrict its content to displaying the post, explicitly prohibiting extraction. It exposes no video or audio files.
So Instagram and Facebook captions, OCR and speech are not implemented; the app offers pasting the caption or manual entry.

## Tests

`npm test` runs the unit tests here (fake fetch, DNS and auth) and `roundtrip.test.ts`, which connects the app client
to this handler. `deno check index.ts` typechecks the Deno entry point; `tsc -p .` typechecks it for Node.
