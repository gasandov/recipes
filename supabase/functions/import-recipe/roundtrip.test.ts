// End to end, in process: the app's import client talks to the real handler, and the handler reads
// fixture pages through a fake upstream. This file is excluded from the function's own tsconfig
// because it imports app code, which uses extensionless paths.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importRecipeFromLink } from "../../../src/capture/link/client";
import { createHandler } from "./handler.ts";

const origin = "https://app.example";
const pages: Record<string, string> = {
  "https://recetas.example/pollo": "json-ld-graph.html",
  "https://recetas.example/sopa": "microdata.html",
  "https://recetas.example/guacamole": "page-text.html",
  "https://recetas.example/js": "client-rendered.html",
};

function endpointFor(allowedHosts = ["recetas.example"]) {
  const handler = createHandler(
    { allowedOrigins: [origin], policy: { allowedHosts, allowAnyPublicHost: false } },
    {
      verifyUser: async (token) => (token === "good" ? { id: "u" } : undefined),
      fetch: async (url) => {
        const file = pages[url];
        if (!file) return new Response("nope", { status: 404, headers: { "content-type": "text/html" } });
        const html = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8");
        return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      },
    },
  );
  const send = (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", origin);
    return handler(new Request(String(input), { ...init, headers }));
  };
  return { endpoint: "https://function.example/import-recipe", fetch: send as typeof fetch };
}

describe("link import round trip", () => {
  it.each([
    ["https://recetas.example/pollo", "Pollo en salsa verde & arroz", 6, 4, 5, "receta estructurada"],
    ["https://recetas.example/sopa", "Sopa de tortilla", 4, 3, 2, "marcado de receta"],
    ["https://recetas.example/guacamole", "Guacamole de la abuela", 4, 3, 2, "texto visible"],
  ])("turns %s into an editable draft", async (link, name, portions, ingredients, steps, notice) => {
    const outcome = await importRecipeFromLink(link, { ...endpointFor(), getAccessToken: () => "good" });
    expect(outcome.status).toBe("draft");
    if (outcome.status !== "draft") return;
    expect(outcome.draft).toMatchObject({ name, portions, sourceUrl: link });
    expect(outcome.draft.ingredients).toHaveLength(ingredients);
    expect(outcome.draft.steps).toHaveLength(steps);
    expect(outcome.draft.notices?.[0]).toContain(notice);
  });

  it("sends a page with client-injected data to manual entry with the link", async () => {
    const outcome = await importRecipeFromLink("https://recetas.example/js", { ...endpointFor(), getAccessToken: () => "good" });
    expect(outcome).toMatchObject({ status: "failed", failure: "no-recipe-data", fallback: { sourceUrl: "https://recetas.example/js" } });
  });

  it("sends inaccessible pages, other hosts and signed-out users to manual entry", async () => {
    const options = { ...endpointFor(), getAccessToken: () => "good" };
    expect(await importRecipeFromLink("https://recetas.example/borrada", options)).toMatchObject({ failure: "inaccessible" });
    expect(await importRecipeFromLink("https://otro.example/x", options)).toMatchObject({ failure: "not_allowed" });
    expect(await importRecipeFromLink("https://recetas.example/pollo", { ...endpointFor(), getAccessToken: () => "anon-key" })).toMatchObject({
      failure: "unauthorized",
      fallback: { sourceUrl: "https://recetas.example/pollo" },
    });
  });
});
