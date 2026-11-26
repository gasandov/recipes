import { describe, expect, it } from "vitest";
import { parseLinkInput } from "./source";

describe("parseLinkInput", () => {
  it("classifies web, Instagram and Facebook links", () => {
    expect(parseLinkInput("https://recetas.example/pollo")).toMatchObject({ ok: true, kind: "web" });
    expect(parseLinkInput("https://www.instagram.com/reel/abc/?igsh=1")).toMatchObject({ ok: true, kind: "instagram" });
    expect(parseLinkInput("https://instagr.am/p/abc")).toMatchObject({ ok: true, kind: "instagram" });
    expect(parseLinkInput("https://m.facebook.com/share/r/abc")).toMatchObject({ ok: true, kind: "facebook" });
    expect(parseLinkInput("https://fb.watch/abc/")).toMatchObject({ ok: true, kind: "facebook" });
    expect(parseLinkInput("https://notinstagram.com/x")).toMatchObject({ ok: true, kind: "web" });
  });

  it("unwraps links redirected through the Meta link shims", () => {
    expect(parseLinkInput("https://l.facebook.com/l.php?u=https%3A%2F%2Frecetas.example%2Fpollo&h=x")).toMatchObject({
      kind: "web", sourceUrl: "https://recetas.example/pollo",
    });
    expect(parseLinkInput("https://l.instagram.com/?u=https%3A%2F%2Fwww.instagram.com%2Fp%2Fabc%2F")).toMatchObject({ kind: "instagram" });
    expect(parseLinkInput("https://l.facebook.com/l.php?u=nada")).toMatchObject({ kind: "facebook" });
  });

  it("keeps the source as given and upgrades only the request to https", () => {
    expect(parseLinkInput("http://recetas.example/a?b=1")).toMatchObject({
      sourceUrl: "http://recetas.example/a?b=1", requestUrl: "https://recetas.example/a?b=1",
    });
    expect(parseLinkInput("recetas.example/pollo")).toMatchObject({ sourceUrl: "https://recetas.example/pollo" });
  });

  it.each(["", "hola mundo", "javascript:alert(1)", "ftp://a.example/x", "https://user:pw@a.example/", "https://localhost/", "mailto:a@b.co", "https://a b.example/"])(
    "rejects %j",
    (input) => {
      expect(parseLinkInput(input)).toEqual({ ok: false });
    },
  );
});
