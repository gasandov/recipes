import { describe, expect, it, vi } from "vitest";
import { createSupabaseUserVerifier } from "../_shared/auth.ts";
import type { FetchLike } from "./fetcher.ts";
import { createHandler } from "./handler.ts";
import type { HandlerConfig } from "./handler.ts";
import type { ImportResponse } from "./protocol.ts";

const origin = "https://app.example";
const config: HandlerConfig = {
  allowedOrigins: [origin],
  policy: { allowedHosts: ["recetas.example"], allowAnyPublicHost: false },
};
const page = `<script type="application/ld+json">{"@type":"Recipe","name":"Sopa","recipeIngredient":["1 taza de agua"],"recipeInstructions":["Hierve."]}</script>`;

function setup(overrides: Partial<HandlerConfig> = {}) {
  const upstream = vi.fn<FetchLike>(async () => new Response(page, { status: 200, headers: { "content-type": "text/html" } }));
  const verifyUser = vi.fn(async (token: string) => (token === "good-token" ? { id: "user-1" } : undefined));
  const handler = createHandler({ ...config, ...overrides }, { fetch: upstream, verifyUser });
  const call = (body: unknown, headers: Record<string, string> = {}, method = "POST") =>
    handler(new Request("https://function.example/import-recipe", {
      method,
      headers: { origin, authorization: "Bearer good-token", "content-type": "application/json", ...headers },
      body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    }));
  return { call, upstream, verifyUser, handler };
}

const json = async (response: Response) => (await response.json()) as ImportResponse;

describe("import-recipe handler", () => {
  it("returns only extracted values for an authenticated, allowed request", async () => {
    const { call, upstream } = setup();
    const response = await call({ url: "https://recetas.example/sopa" });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await json(response);
    expect(body).toMatchObject({ ok: true, extraction: { origin: "json-ld", title: "Sopa", ingredients: ["1 taza de agua"], steps: ["Hierve."] } });
    expect(JSON.stringify(body)).not.toContain("<script");
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("answers preflight only for configured origins", async () => {
    const { handler } = setup();
    const allowed = await handler(new Request("https://function.example/", { method: "OPTIONS", headers: { origin } }));
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(origin);
    expect(allowed.headers.get("access-control-allow-headers")).toContain("authorization");
    const denied = await handler(new Request("https://function.example/", { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects other origins and missing origins unless explicitly enabled", async () => {
    const { call, upstream } = setup();
    const foreign = await call({ url: "https://recetas.example/sopa" }, { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    const headers = { authorization: "Bearer good-token", "content-type": "application/json" };
    const handler = createHandler(config, { fetch: upstream, verifyUser: async () => ({ id: "u" }) });
    const noOrigin = await handler(new Request("https://function.example/", { method: "POST", headers, body: "{}" }));
    expect(noOrigin.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();

    const lenient = createHandler({ ...config, allowMissingOrigin: true }, { fetch: upstream, verifyUser: async () => ({ id: "u" }) });
    const ok = await lenient(new Request("https://function.example/", { method: "POST", headers, body: JSON.stringify({ url: "https://recetas.example/sopa" }) }));
    expect((await json(ok)).ok).toBe(true);
  });

  it("requires a verified user session before touching the network", async () => {
    const { call, upstream, verifyUser } = setup();
    for (const authorization of [undefined, "Bearer anon-key", "Basic abc", "good-token"]) {
      const headers: Record<string, string> = authorization ? { authorization } : {};
      const response = await call({ url: "https://recetas.example/sopa" }, authorization ? headers : { authorization: "" });
      expect(response.status).toBe(401);
      expect(await json(response)).toEqual({ ok: false, code: "unauthorized" });
    }
    expect(verifyUser).toHaveBeenCalledWith("anon-key");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("fails closed when origins or hosts are not configured", async () => {
    const noOrigins = setup({ allowedOrigins: [] });
    expect((await noOrigins.call({ url: "https://recetas.example/x" })).status).toBe(503);
    const noHosts = setup({ policy: { allowedHosts: [], allowAnyPublicHost: false } });
    expect(await json(await noHosts.call({ url: "https://recetas.example/x" }))).toEqual({ ok: false, code: "not_configured" });
    expect(noHosts.upstream).not.toHaveBeenCalled();
  });

  it("validates the request body", async () => {
    const { call, upstream } = setup();
    expect((await call("not json")).status).toBe(400);
    expect((await call({})).status).toBe(400);
    expect((await call({ url: 5 })).status).toBe(400);
    expect((await call({ url: "x".repeat(10_000) })).status).toBe(400);
    expect((await call({ url: "https://recetas.example/x" }, { "content-type": "text/plain" })).status).toBe(400);
    expect((await call(undefined, {}, "GET")).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses unsafe and non-allowlisted destinations", async () => {
    const { call, upstream } = setup();
    expect(await json(await call({ url: "https://127.0.0.1/" }))).toEqual({ ok: false, code: "unsafe_destination" });
    expect(await json(await call({ url: "http://recetas.example/" }))).toEqual({ ok: false, code: "unsafe_destination" });
    expect(await json(await call({ url: "https://otro.example/" }))).toEqual({ ok: false, code: "not_allowed" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rate limits per user", async () => {
    let clock = 0;
    const upstream = vi.fn<FetchLike>(async () => new Response(page, { status: 200, headers: { "content-type": "text/html" } }));
    const handler = createHandler({ ...config, perUserPerMinute: 2 }, { fetch: upstream, verifyUser: async () => ({ id: "u" }), now: () => clock });
    const send = () => handler(new Request("https://f.example/", {
      method: "POST",
      headers: { origin, authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ url: "https://recetas.example/sopa" }),
    }));
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
    clock += 61_000;
    expect((await send()).status).toBe(200);
  });

  it("reports upstream failures as codes, not bodies", async () => {
    const upstream = vi.fn<FetchLike>(async () => new Response("<html>login wall</html>", { status: 403, headers: { "content-type": "text/html" } }));
    const handler = createHandler(config, { fetch: upstream, verifyUser: async () => ({ id: "u" }) });
    const response = await handler(new Request("https://f.example/", {
      method: "POST",
      headers: { origin, authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ url: "https://recetas.example/sopa" }),
    }));
    expect(await json(response)).toEqual({ ok: false, code: "inaccessible" });
  });
});

describe("createSupabaseUserVerifier", () => {
  const verifier = (respond: () => Response | Promise<Response>) => {
    const fetchImpl = vi.fn<FetchLike>(async () => respond());
    return { fetchImpl, verify: createSupabaseUserVerifier({ supabaseUrl: "https://p.supabase.example/", apiKey: "anon", fetch: fetchImpl }) };
  };

  it("accepts a real user and forwards the token to the Auth server", async () => {
    const { verify, fetchImpl } = verifier(() => Response.json({ id: "abc", is_anonymous: false }));
    expect(await verify("jwt")).toEqual({ id: "abc" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://p.supabase.example/auth/v1/user");
    expect(init.headers).toMatchObject({ apikey: "anon", authorization: "Bearer jwt" });
  });

  it("refuses the anon key, anonymous users, errors and malformed answers", async () => {
    expect(await verifier(() => Response.json({ msg: "missing sub" }, { status: 401 })).verify("anon")).toBeUndefined();
    expect(await verifier(() => Response.json({ id: "x", is_anonymous: true })).verify("t")).toBeUndefined();
    expect(await verifier(() => Response.json({})).verify("t")).toBeUndefined();
    expect(await verifier(() => new Response("nope")).verify("t")).toBeUndefined();
    expect(await verifier(() => { throw new Error("down"); }).verify("t")).toBeUndefined();
  });
});
