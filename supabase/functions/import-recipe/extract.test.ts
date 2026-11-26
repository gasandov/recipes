import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeEntities, extractRecipe, htmlToText } from "./extract.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("extractRecipe", () => {
  it("reads a recipe from a JSON-LD @graph with array types, sections and mixed step shapes", () => {
    const result = extractRecipe(fixture("json-ld-graph.html"), "https://recetas.example/pollo");
    expect(result.origin).toBe("json-ld");
    expect(result.finalUrl).toBe("https://recetas.example/pollo");
    expect(result.title).toBe("Pollo en salsa verde & arroz");
    expect(result.yieldText).toBe("6 porciones");
    expect(result.ingredients).toEqual([
      "500 g de pechuga de pollo", "1 1/2 tazas de salsa verde", "Sal al gusto", "2 dientes de ajo",
    ]);
    expect(result.steps).toEqual([
      "Pollo", "Cuece el pollo con ajo y sal.", "Deshebra el pollo.",
      "Calienta la salsa y agrega el pollo.", "Sirve caliente.",
    ]);
    expect(result.text).toBeUndefined();
  });

  it("keeps only HTTPS media and never downloads it", () => {
    const { media } = extractRecipe(fixture("json-ld-graph.html"), "https://recetas.example/pollo");
    expect(media).toEqual([
      { kind: "image", url: "https://cdn.recetas.example/pollo-1x1.jpg" },
      { kind: "video", url: "https://cdn.recetas.example/pollo.mp4" },
      { kind: "image", url: "https://cdn.recetas.example/pollo.jpg" },
    ]);
  });

  it("splits instructions given as one HTML string and reads a numeric yield", () => {
    const result = extractRecipe(fixture("json-ld-string-steps.html"), "https://recetas.example/pan");
    expect(result.steps).toEqual(["Amasa durante 10 minutos.", "Deja reposar 1 hora."]);
    expect(result.yieldText).toBe("4");
  });

  it("falls back to microdata", () => {
    const result = extractRecipe(fixture("microdata.html"), "https://recetas.example/sopa");
    expect(result.origin).toBe("microdata");
    expect(result.title).toBe("Sopa de tortilla");
    expect(result.yieldText).toBe("4 porciones");
    expect(result.ingredients).toEqual(["6 tortillas", "1 litro de caldo de pollo", "Aguacate al gusto"]);
    expect(result.steps).toEqual(["Fríe las tortillas.", "Agrega el caldo caliente."]);
  });

  it("returns readable text without chrome when there is no structured recipe", () => {
    const result = extractRecipe(fixture("page-text.html"), "https://recetas.example/guacamole");
    expect(result.origin).toBe("page-text");
    expect(result.ingredients).toEqual([]);
    expect(result.text).toContain("Ingredientes\n3 aguacates");
    expect(result.text).not.toContain("Menú principal");
    expect(result.text).not.toContain("Derechos reservados");
  });

  it("does not treat client-injected structured data as a recipe", () => {
    const result = extractRecipe(fixture("client-rendered.html"), "https://recetas.example/js");
    expect(result.origin).not.toBe("json-ld");
    expect(result.ingredients).toEqual([]);
    expect(result.text ?? "").not.toContain("createElement");
  });

  it("survives malformed JSON-LD and hostile nesting", () => {
    const deep = "[".repeat(5000) + "]".repeat(5000);
    const html = `<script type="application/ld+json">{not json</script><script type="application/ld+json">${deep}</script>`;
    expect(extractRecipe(html, "https://a.example/").origin).toBe("none");
  });

  it("strips scripts whose strings mention other tags", () => {
    const html = `<body><script>var a = "<template>"; document.write("<svg>");</script><p>Hola</p><template><p>oculto</p></template></body>`;
    expect(extractRecipe(html, "https://a.example/").text).toBe("Hola");
  });

  it("caps text and list sizes", () => {
    const html = `<body><p>${"palabra ".repeat(10_000)}</p></body>`;
    expect(extractRecipe(html, "https://a.example/").text?.length).toBeLessThanOrEqual(30_000);
  });
});

describe("text helpers", () => {
  it("decodes entities once and never produces tags from escaped text", () => {
    expect(decodeEntities("Ca&ntilde;a &amp;lt;b&amp;gt; &#xBD; &#x1F600; &#0;")).toBe("Caña &lt;b&gt; ½ 😀  ");
    expect(htmlToText("<p>a &lt;script&gt;</p><p>b</p>")).toBe("a <script>\nb");
  });
});
