import { describe, expect, it, vi } from "vitest";
import { fetchPublicImage } from "./fetch-image";

function respond(body: BodyInit | null, init: ResponseInit & { url?: string } = {}) {
  const response = new Response(body, { status: 200, headers: { "content-type": "image/png" }, ...init });
  if (init.url) Object.defineProperty(response, "url", { value: init.url });
  return response;
}
const sender = (response: () => Response | Promise<Response>) =>
  vi.fn((...args: Parameters<typeof fetch>) => { void args; return Promise.resolve().then(response); });

describe("fetchPublicImage", () => {
  it("makes an anonymous CORS request and returns the bytes in memory", async () => {
    const send = sender(() => respond(new Uint8Array([1, 2, 3])));
    const result = await fetchPublicImage("https://cdn.recetas.example/a.png", { fetch: send as unknown as typeof fetch });
    expect(result.ok && result.blob.size).toBe(3);
    const [url, init] = send.mock.calls[0];
    expect(url).toBe("https://cdn.recetas.example/a.png");
    expect(init).toMatchObject({ mode: "cors", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
    expect(init?.headers).not.toHaveProperty("authorization");
  });

  it("never sends a request for a Meta or private address", async () => {
    const send = sender(() => respond("x"));
    for (const url of ["https://scontent.cdninstagram.com/x.jpg", "https://www.facebook.com/photo.php", "http://cdn.example/x.png", "https://10.0.0.2/x.png"]) {
      expect(await fetchPublicImage(url, { fetch: send as unknown as typeof fetch })).toEqual({ ok: false, failure: "blocked-source" });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("reports a CORS refusal or network failure without trying another way in", async () => {
    const send = sender(() => { throw new TypeError("Failed to fetch"); });
    expect(await fetchPublicImage("https://cdn.recetas.example/a.png", { fetch: send as unknown as typeof fetch })).toEqual({
      ok: false, failure: "cors-or-network",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect that lands on a Meta host", async () => {
    const send = sender(() => respond("x", { url: "https://scontent.cdninstagram.com/x.png" }));
    expect(await fetchPublicImage("https://short.recetas.example/a", { fetch: send as unknown as typeof fetch })).toEqual({
      ok: false, failure: "blocked-source",
    });
  });

  it("refuses non-images, HTTP errors and oversized bodies", async () => {
    const html = sender(() => respond("<html>", { headers: { "content-type": "text/html" } }));
    expect(await fetchPublicImage("https://cdn.recetas.example/a", { fetch: html as unknown as typeof fetch })).toEqual({ ok: false, failure: "not-image" });
    const svg = sender(() => respond("<svg/>", { headers: { "content-type": "image/svg+xml" } }));
    expect(await fetchPublicImage("https://cdn.recetas.example/a", { fetch: svg as unknown as typeof fetch })).toEqual({ ok: false, failure: "not-image" });
    const missing = sender(() => respond("nope", { status: 404 }));
    expect(await fetchPublicImage("https://cdn.recetas.example/a", { fetch: missing as unknown as typeof fetch })).toEqual({ ok: false, failure: "http-error" });

    const declared = sender(() => respond(new Uint8Array(10), { headers: { "content-type": "image/png", "content-length": "9999999" } }));
    expect(await fetchPublicImage("https://cdn.recetas.example/a", { fetch: declared as unknown as typeof fetch, maxBytes: 1000 })).toEqual({ ok: false, failure: "too-large" });
    // No Content-Length, as with chunked transfer: the cap still applies while streaming.
    const streamed = sender(() => respond(new Uint8Array(5000)));
    expect(await fetchPublicImage("https://cdn.recetas.example/a", { fetch: streamed as unknown as typeof fetch, maxBytes: 1000 })).toEqual({ ok: false, failure: "too-large" });
  });

  it("stops on timeout and on cancellation", async () => {
    const hang = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    expect(await fetchPublicImage("https://cdn.recetas.example/a", { fetch: hang as unknown as typeof fetch, timeoutMs: 20 })).toEqual({
      ok: false, failure: "timeout",
    });
    const controller = new AbortController();
    const pending = fetchPublicImage("https://cdn.recetas.example/a", { fetch: hang as unknown as typeof fetch, signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ ok: false, failure: "aborted" });
  });
});
