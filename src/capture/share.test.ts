import { describe, expect, it } from "vitest";
import { receiveSharedRecipe } from "./share";

describe("incoming recipe share", () => {
  it("opens the capture view, preserving the PWA base path and unrelated query state", () => {
    const location = new URL("https://example.com/recipes/?recipe-share-url=https%3A%2F%2Ffood.example%2Fpie&code=abc");
    expect(receiveSharedRecipe(location)).toEqual({
      location: new URL("https://example.com/recipes/?code=abc#/recetas/capturar"),
      sourceUrl: "https://food.example/pie",
    });
  });

  it("accepts a URL inside shared text and discards invalid URLs", () => {
    const location = new URL("https://example.com/recipes/?recipe-share-url=file%3A%2F%2F&recipe-share-text=Mira%20https%3A%2F%2Ffood.example%2Fpie");
    expect(receiveSharedRecipe(location)?.sourceUrl).toBe("https://food.example/pie");
    expect(receiveSharedRecipe(new URL("https://example.com/recipes/?recipe-share-text=Hello"))?.sourceUrl).toBeUndefined();
    expect(receiveSharedRecipe(new URL("https://example.com/recipes/?code=abc"))).toBeUndefined();
  });
});
