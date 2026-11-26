import { describe, expect, it, vi } from "vitest";
import { fetchPage } from "./fetcher.ts";
import type { FetchLike } from "./fetcher.ts";
import type { HostPolicy } from "./guard.ts";
import { importLimits } from "./protocol.ts";

const publicPolicy: HostPolicy = { allowedHosts: [], allowAnyPublicHost: true };
const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });
const publicDns = async () => ["93.184.216.34"];
const start = (href: string) => new URL(href);

function run(fetchImpl: FetchLike, options: { policy?: typeof publicPolicy; resolveDns?: (host: string) => Promise<string[]> } = {}, href = "https://recetas.example/a") {
  return fetchPage(start(href), {
    fetch: fetchImpl,
    policy: options.policy ?? publicPolicy,
    resolveDns: "resolveDns" in options ? options.resolveDns : publicDns,
  });
}

describe("fetchPage", () => {
  it("reads a page, sends no credentials and uses manual redirects", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => html("<p>hola</p>"));
    expect(await run(fetchImpl)).toEqual({ ok: true, html: "<p>hola</p>", finalUrl: "https://recetas.example/a" });
    const init = fetchImpl.mock.calls[0][1];
    expect(init.redirect).toBe("manual");
    expect(init.credentials).toBe("omit");
    expect(JSON.stringify(init.headers)).not.toMatch(/cookie|authorization/i);
  });

  it("follows redirects only to destinations that pass every check", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return calls.length === 1 ? redirect("/b") : html("ok");
    };
    expect(await run(fetchImpl)).toMatchObject({ ok: true, finalUrl: "https://recetas.example/b" });
    expect(calls).toEqual(["https://recetas.example/a", "https://recetas.example/b"]);
  });

  it.each([
    "http://recetas.example/b",
    "https://127.0.0.1/",
    "https://localhost/admin",
    "https://[::1]/",
    "https://169.254.169.254/latest/meta-data/",
    "https://user:pw@recetas.example/",
    "https://recetas.example:8080/",
    "file:///etc/passwd",
  ])("refuses a redirect to %s and never requests it", async (location) => {
    const fetchImpl = vi.fn<FetchLike>(async () => redirect(location));
    expect(await run(fetchImpl)).toEqual({ ok: false, code: "unsafe_destination" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a hostname whose DNS answers are private, before connecting", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => html("secret"));
    const result = await run(fetchImpl, { resolveDns: async () => ["93.184.216.34", "10.0.0.7"] });
    expect(result).toEqual({ ok: false, code: "unsafe_destination" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-resolves DNS on every hop", async () => {
    const answers = new Map([["recetas.example", ["93.184.216.34"]], ["cdn.example", ["192.168.0.2"]]]);
    const fetchImpl = vi.fn<FetchLike>(async () => redirect("https://cdn.example/x"));
    const result = await run(fetchImpl, { resolveDns: async (host) => answers.get(host) ?? [] });
    expect(result).toEqual({ ok: false, code: "unsafe_destination" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats unresolvable names as inaccessible", async () => {
    expect(await run(vi.fn<FetchLike>(), { resolveDns: async () => [] })).toEqual({ ok: false, code: "inaccessible" });
    expect(await run(vi.fn<FetchLike>(), { resolveDns: async () => { throw new Error("x"); } })).toEqual({ ok: false, code: "inaccessible" });
  });

  it("reports a runtime that denies DNS as a configuration problem, not an unreachable page", async () => {
    const denied = Object.assign(new Error("denied"), { name: "PermissionDenied" });
    const fetchImpl = vi.fn<FetchLike>();
    expect(await run(fetchImpl, { resolveDns: async () => { throw denied; } })).toEqual({ ok: false, code: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed in public mode when the runtime cannot resolve DNS", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    expect(await run(fetchImpl, { resolveDns: undefined })).toEqual({ ok: false, code: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allowlist mode works without DNS and checks every hop against the list", async () => {
    const policy = { allowedHosts: ["recetas.example"], allowAnyPublicHost: false };
    const ok = await run(async () => html("ok"), { policy, resolveDns: undefined });
    expect(ok.ok).toBe(true);
    const redirected = await run(async () => redirect("https://otro.example/"), { policy, resolveDns: undefined });
    expect(redirected).toEqual({ ok: false, code: "not_allowed" });
    const direct = await run(vi.fn<FetchLike>(), { policy, resolveDns: undefined }, "https://otro.example/");
    expect(direct).toEqual({ ok: false, code: "not_allowed" });
  });

  it("never fetches Instagram or Facebook, directly or through a redirect", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => redirect("https://www.instagram.com/p/abc/"));
    expect(await run(fetchImpl)).toEqual({ ok: false, code: "unsupported_source" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const direct = vi.fn<FetchLike>();
    expect(await run(direct, {}, "https://www.facebook.com/watch/?v=1")).toEqual({ ok: false, code: "unsupported_source" });
    expect(direct).not.toHaveBeenCalled();
  });

  it("stops redirect loops", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => redirect("/loop"));
    expect(await run(fetchImpl)).toEqual({ ok: false, code: "too_many_redirects" });
    expect(fetchImpl).toHaveBeenCalledTimes(importLimits.maxRedirects + 1);
  });

  it("maps access-controlled and failing responses without retrying", async () => {
    const status = (code: number) => run(async () => new Response("x", { status: code, headers: { "content-type": "text/html" } }));
    expect(await status(403)).toEqual({ ok: false, code: "inaccessible" });
    expect(await status(401)).toEqual({ ok: false, code: "inaccessible" });
    expect(await status(404)).toEqual({ ok: false, code: "inaccessible" });
    expect(await status(429)).toEqual({ ok: false, code: "busy" });
    expect(await status(503)).toEqual({ ok: false, code: "upstream_error" });
  });

  it("rejects non-HTML content types", async () => {
    const fetchImpl = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    expect(await run(fetchImpl)).toEqual({ ok: false, code: "not_html" });
    const noType = async () => new Response("x", { status: 200 });
    expect(await run(noType)).toEqual({ ok: false, code: "not_html" });
  });

  it("caps the body by declared length and by streamed bytes", async () => {
    const declared = async () => html("x", { "content-length": String(importLimits.maxBodyBytes + 1) });
    expect(await run(declared)).toEqual({ ok: false, code: "too_large" });

    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1_000_000));
      },
    });
    const streamed = async () => new Response(endless, { status: 200, headers: { "content-type": "text/html" } });
    expect(await run(streamed)).toEqual({ ok: false, code: "too_large" });
    expect(pulled).toBeLessThan(6);
  });

  it("times out slow servers", async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const result = await fetchPage(start("https://recetas.example/a"), { fetch: hanging, policy: publicPolicy, resolveDns: publicDns }, { ...importLimits, timeoutMs: 40 });
    expect(result).toEqual({ ok: false, code: "timeout" });
  });

  it("times out a body that stalls after the headers", async () => {
    const stalled: FetchLike = async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("<p>"));
          init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    };
    const result = await fetchPage(start("https://recetas.example/a"), { fetch: stalled, policy: publicPolicy, resolveDns: publicDns }, { ...importLimits, timeoutMs: 40 });
    expect(result).toEqual({ ok: false, code: "timeout" });
  });

  it("decodes Latin-1 pages declared in the header or a meta tag", async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode("<p>"), 0xf1, ...new TextEncoder().encode("</p>")]);
    const header = async () => new Response(bytes, { status: 200, headers: { "content-type": "text/html; charset=iso-8859-1" } });
    expect(await run(header)).toMatchObject({ html: "<p>ñ</p>" });
    const meta = new Uint8Array([...new TextEncoder().encode('<meta charset="windows-1252"><p>'), 0xe1, ...new TextEncoder().encode("</p>")]);
    const inMeta = async () => new Response(meta, { status: 200, headers: { "content-type": "text/html" } });
    expect(await run(inMeta)).toMatchObject({ html: '<meta charset="windows-1252"><p>á</p>' });
  });
});
