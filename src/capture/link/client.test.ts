import { describe, expect, it, vi } from "vitest";
import type { ImportResponse } from "../../../supabase/functions/import-recipe/protocol.ts";
import { importRecipeFromLink } from "./client";
import { failureMessages } from "./messages";

const endpoint = "https://project.supabase.example/functions/v1/import-recipe";
const answer = (body: ImportResponse | string, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const recipe: ImportResponse = {
  ok: true,
  extraction: {
    origin: "json-ld", finalUrl: "https://recetas.example/x", title: "Pollo en salsa verde", yieldText: "6 porciones",
    ingredients: ["500 g de pechuga de pollo", "Sal al gusto"], steps: ["Cuece el pollo.", "Sirve."], media: [],
  },
};
const unreadable: ImportResponse = {
  ok: true,
  extraction: { origin: "none", finalUrl: "https://recetas.example/js", title: "Receta cargada con JavaScript", ingredients: [], steps: [], media: [] },
};

function options(respond: () => Response | Promise<Response>) {
  const send = vi.fn((...args: Parameters<typeof fetch>) => { void args; return Promise.resolve().then(respond); });
  return { send, options: { endpoint, getAccessToken: () => "session-token", fetch: send as unknown as typeof fetch } };
}

describe("importRecipeFromLink", () => {
  it("sends only the link and the user's token, and returns a reviewable draft", async () => {
    const { send, options: o } = options(() => answer(recipe));
    const outcome = await importRecipeFromLink("http://recetas.example/pollo", o);
    expect(outcome.status).toBe("draft");
    if (outcome.status === "draft") {
      expect(outcome.draft.name).toContain("Pollo en salsa verde");
      expect(outcome.draft.sourceUrl).toBe("http://recetas.example/pollo");
    }
    const [target, init] = send.mock.calls[0];
    expect(target).toBe(endpoint);
    expect(init?.headers).toMatchObject({ authorization: "Bearer session-token" });
    expect(JSON.parse(init?.body as string)).toEqual({ url: "https://recetas.example/pollo" });
    expect(init?.credentials).toBe("omit");
  });

  it.each([
    ["https://www.instagram.com/reel/abc/", "unsupported-social"],
    ["https://fb.watch/abc/", "unsupported-social"],
    ["no es un enlace", "invalid-link"],
  ])("handles %s without calling the service", async (input, failure) => {
    const { send, options: o } = options(() => answer(recipe));
    const outcome = await importRecipeFromLink(input, o);
    expect(outcome).toMatchObject({ status: "failed", failure, message: failureMessages[failure as "invalid-link"] });
    expect(send).not.toHaveBeenCalled();
    if (outcome.status === "failed" && failure === "unsupported-social") {
      expect(outcome.canPasteText).toBe(true);
      expect(outcome.fallback).toMatchObject({ sourceUrl: input, ingredients: [], steps: [] });
      expect(outcome.message).toMatch(/Instagram y Facebook/);
    }
  });

  it("falls back to manual entry when the service or session is missing", async () => {
    const { send, options: o } = options(() => answer(recipe));
    expect(await importRecipeFromLink("https://recetas.example/a", { ...o, endpoint: undefined })).toMatchObject({ failure: "not-configured" });
    expect(await importRecipeFromLink("https://recetas.example/a", { ...o, getAccessToken: () => undefined })).toMatchObject({
      failure: "sign-in-required",
      fallback: { sourceUrl: "https://recetas.example/a" },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("maps service error codes to es-MX messages with the link preserved", async () => {
    for (const code of ["inaccessible", "unsafe_destination", "unsupported_source", "timeout", "too_large", "not_html", "rate_limited", "unauthorized"] as const) {
      const { options: o } = options(() => answer({ ok: false, code }, code === "unauthorized" ? 401 : 200));
      const outcome = await importRecipeFromLink("https://recetas.example/a", o);
      expect(outcome).toMatchObject({ status: "failed", failure: code, message: failureMessages[code] });
      if (outcome.status === "failed") expect(outcome.fallback.sourceUrl).toBe("https://recetas.example/a");
    }
  });

  it("reports pages with no readable recipe and still opens the editor with the link", async () => {
    const { options: o } = options(() => answer(unreadable));
    const outcome = await importRecipeFromLink("https://recetas.example/js", o);
    expect(outcome).toMatchObject({ status: "failed", failure: "no-recipe-data", canPasteText: true });
    if (outcome.status === "failed") expect(outcome.fallback.sourceUrl).toBe("https://recetas.example/js");
  });

  it("maps a gateway 401 with a foreign body to the sign-in message", async () => {
    const { options: o } = options(() => answer('{"code":401,"message":"Invalid JWT"}', 401));
    expect(await importRecipeFromLink("https://recetas.example/a", o)).toMatchObject({ failure: "unauthorized" });
  });

  it("handles network failures, bad payloads and aborts", async () => {
    const down = options(() => { throw new TypeError("failed to fetch"); });
    expect(await importRecipeFromLink("https://recetas.example/a", down.options)).toMatchObject({ failure: expect.stringMatching(/offline|network/) });
    expect(await importRecipeFromLink("https://recetas.example/a", options(() => answer("<html>")).options)).toMatchObject({ failure: "bad-response" });
    expect(await importRecipeFromLink("https://recetas.example/a", options(() => answer({ ok: true } as never)).options)).toMatchObject({ failure: "bad-response" });
    expect(await importRecipeFromLink("https://recetas.example/a", options(() => answer({ ok: false, code: "made_up" } as never)).options)).toMatchObject({ failure: "bad-response" });

    const controller = new AbortController();
    const aborted = options(() => { controller.abort(); throw new DOMException("x", "AbortError"); });
    await expect(importRecipeFromLink("https://recetas.example/a", { ...aborted.options, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("discards the result of a cancelled import even when the transport ignores the signal", async () => {
    const controller = new AbortController();
    const slow = options(async () => { controller.abort(); return answer(recipe); });
    await expect(importRecipeFromLink("https://recetas.example/a", { ...slow.options, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
  it("carries the public media a page lists, without downloading it", async () => {
    const media = [{ kind: "image" as const, url: "https://cdn.recetas.example/receta.jpg" }, { kind: "video" as const, url: "https://cdn.recetas.example/receta.mp4" }];
    const withMedia = (extraction: Extract<ImportResponse, { ok: true }>["extraction"]): ImportResponse => ({ ok: true, extraction: { ...extraction, media } });

    const page = options(() => answer(withMedia(recipe.ok ? recipe.extraction : unreadable.ok ? unreadable.extraction : (undefined as never))));
    const draft = await importRecipeFromLink("https://recetas.example/a", page.options);
    expect(draft).toMatchObject({ status: "draft", media });

    const image = options(() => answer(withMedia(unreadable.ok ? unreadable.extraction : (undefined as never))));
    const outcome = await importRecipeFromLink("https://recetas.example/js", image.options);
    expect(outcome).toMatchObject({ status: "failed", failure: "no-recipe-data", media });
    expect(image.send).toHaveBeenCalledTimes(1);

    const social = await importRecipeFromLink("https://www.instagram.com/reel/x/", image.options);
    expect(social).toMatchObject({ status: "failed", failure: "unsupported-social", media: [] });
  });
});
