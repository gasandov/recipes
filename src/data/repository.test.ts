import "fake-indexeddb/auto";
import { openDB } from "idb";
import { describe, expect, it, vi } from "vitest";
import type { PhotoInput, Recipe, RecipeDraft } from "../contracts";
import { createMenuEntry, convertMeasuredAmount, parseMeasuredAmount, parseRational } from "../domain";
import { databaseVersion, recipeDatabaseConnection } from "./database";
import { createRecipeRepository } from "./repository";

function setup() {
  const name = `recipes-test-${crypto.randomUUID()}`;
  return { name, repository: createRecipeRepository(name) };
}

function draft(overrides: Partial<RecipeDraft> = {}): RecipeDraft {
  return { name: "Salsa", enteredPortions: 4, ingredients: [], steps: [], categoryIds: [], tags: [], ...overrides };
}

const imageBytes = new Uint8Array(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=",
  "base64",
));
const photo: PhotoInput = { blob: new Blob([imageBytes], { type: "image/png" }), width: 1, height: 1 };

describe("IndexedDB recipe repository", () => {
  it("seeds a new catalog once and persists edits and deletions across connections", async () => {
    const { name, repository } = setup();
    const clean = await repository.getLibrary();
    expect(clean.recipes).toEqual([]);
    expect(clean.categories.map((category) => category.name)).toContain("Mexicana");
    const densityIngredients = clean.ingredients.filter((ingredient) => ingredient.density);
    expect(densityIngredients.map((ingredient) => ingredient.id)).toEqual(["canola-oil", "flour", "sugar"]);
    for (const { density } of densityIngredients) expect(density?.source).toContain("https://");
    expect(await repository.getActiveMenu()).toEqual([]);

    await repository.deleteCategory("dish-breakfast");
    await repository.saveIngredient({ id: "flour", name: "Harina del molino", classification: "plant" });
    const reopened = await createRecipeRepository(name).getLibrary();
    expect(reopened.categories.some((category) => category.id === "dish-breakfast")).toBe(false);
    expect(reopened.ingredients.find((ingredient) => ingredient.id === "flour")?.name).toBe("Harina del molino");
  });

  it("round-trips an exact fraction and a photo across connections and temporary display conversion", async () => {
    const { name, repository } = setup();
    const measured = parseMeasuredAmount("1½", "cup");
    const saved = await repository.saveRecipe(draft({
      ingredients: [{ ingredientId: "flour", amount: measured }],
    }), photo);
    const reopened = createRecipeRepository(name);
    const { recipes } = await reopened.getLibrary();
    expect(recipes).toEqual([saved]);
    const amount = recipes[0].ingredients[0].amount;
    expect(amount).toEqual(measured);
    if (amount.kind !== "measured") throw new Error("Expected a measured quantity.");
    const milliliters = convertMeasuredAmount(amount, "milliliter");
    expect(milliliters).toEqual(parseMeasuredAmount("375", "milliliter"));
    expect(milliliters && convertMeasuredAmount(milliliters, "cup")).toEqual(measured);

    if (!saved.photoId) throw new Error("Expected a saved photo.");
    const storedPhoto = await reopened.getPhoto(saved.photoId);
    expect(storedPhoto?.blob.type).toBe("image/png");
    expect(await storedPhoto?.blob.arrayBuffer()).toEqual(imageBytes.buffer);
    expect(storedPhoto).toMatchObject({ width: 1, height: 1 });
    const db = await recipeDatabaseConnection(name)();
    try {
      expect(await db.get("photos", saved.photoId)).toEqual({
        id: saved.photoId, bytes: imageBytes.buffer, mimeType: "image/png", width: 1, height: 1,
      });
    } finally {
      db.close();
    }
  });

  it("preserves photos on ordinary edits, replaces them, and removes them with an edit or deletion", async () => {
    const { repository } = setup();
    const initial = await repository.saveRecipe(draft(), photo);
    if (!initial.photoId) throw new Error("Expected a saved photo.");
    const edit = draft({ id: initial.id, name: "Salsa verde" });
    expect((await repository.saveRecipe(edit)).photoId).toBe(initial.photoId);
    const replacement = await repository.saveRecipe(edit, photo);
    expect(replacement.photoId).not.toBe(initial.photoId);
    expect(await repository.getPhoto(initial.photoId)).toBeUndefined();
    if (!replacement.photoId) throw new Error("Expected a replacement photo.");

    expect((await repository.saveRecipe(edit, null)).photoId).toBeUndefined();
    expect(await repository.getPhoto(replacement.photoId)).toBeUndefined();
    const restored = await repository.saveRecipe(edit, photo);
    if (!restored.photoId) throw new Error("Expected a restored photo.");
    await repository.deleteRecipe(initial.id);
    expect(await repository.getPhoto(restored.photoId)).toBeUndefined();
    expect((await repository.getLibrary()).recipes).toEqual([]);
  });

  it("rolls back the replacement and old photo deletion if the final recipe write fails", async () => {
    const { name, repository } = setup();
    const initial = await repository.saveRecipe(draft(), photo);
    const nativePut = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "recipes") throw new DOMException("Injected write failure", "QuotaExceededError");
      return nativePut.call(this, ...args);
    });
    try {
      await expect(repository.saveRecipe(draft({ id: initial.id, name: "New name" }), photo))
        .rejects.toMatchObject({ name: "QuotaExceededError" });
    } finally {
      put.mockRestore();
    }

    const db = await recipeDatabaseConnection(name)();
    try {
      expect(await db.getAll("recipes")).toEqual([initial]);
      expect(await db.getAllKeys("photos")).toEqual([initial.photoId]);
    } finally {
      db.close();
    }
  });

  it("serializes concurrent image replacements without leaving unreferenced photos", async () => {
    const { name, repository } = setup();
    const initial = await repository.saveRecipe(draft(), photo);
    const otherConnection = createRecipeRepository(name);
    await Promise.all([
      repository.saveRecipe(draft({ id: initial.id, name: "Salsa verde" }), photo),
      otherConnection.saveRecipe(draft({ id: initial.id, name: "Salsa roja" }), photo),
    ]);

    const db = await recipeDatabaseConnection(name)();
    try {
      const latest = await db.get("recipes", initial.id);
      expect(latest?.photoId).toBeDefined();
      expect(await db.getAllKeys("photos")).toEqual([latest?.photoId]);
    } finally {
      db.close();
    }
  });

  it("keeps recipes valid when deleting categories or ingredients", async () => {
    const { repository } = setup();
    const original = await repository.saveRecipe(draft({
      categoryIds: ["cuisine-mexican", "dish-sauce"],
      ingredients: [{ ingredientId: "chicken-cutlet", amount: parseMeasuredAmount("2", "piece") }],
    }));
    await expect(repository.deleteIngredient("chicken-cutlet")).rejects.toThrow("used in a saved recipe");
    await expect(repository.saveIngredient({ id: "chicken", name: "Pollo", parentId: "chicken-cutlet" }))
      .rejects.toThrow("cycle");
    await repository.deleteIngredient("chicken-breast");
    await repository.deleteCategory("cuisine-mexican");
    const library = await repository.getLibrary();
    expect(library.ingredients.find(({ id }) => id === "chicken-cutlet")?.parentId).toBeUndefined();
    expect(library.recipes).toEqual([{ ...original, categoryIds: ["dish-sauce"] }]);
  });

  it("keeps independently editable menu snapshots after catalog and recipe changes", async () => {
    const { name, repository } = setup();
    const recipe = await repository.saveRecipe(draft({
      enteredPortions: 2,
      ingredients: [{ ingredientId: "flour", amount: parseMeasuredAmount("125", "gram") }],
    }));
    const { ingredients } = await repository.getLibrary();
    const first = createMenuEntry(recipe, ingredients, "first");
    const second = createMenuEntry(recipe, ingredients, "second");
    expect(first.portions).toBe(4);
    expect(first.ingredients[0].amount).toEqual(parseMeasuredAmount("250", "gram"));
    expect(first.ingredients[0].density).toEqual(ingredients.find(({ id }) => id === "flour")?.density);
    await repository.saveActiveMenu([{ ...first, portions: 7 }, second]);

    await repository.saveIngredient({
      id: "flour", name: "Otra harina", density: { source: "Test", gramsPerMilliliter: parseRational("3") },
    });
    await repository.deleteRecipe(recipe.id);
    await repository.deleteIngredient("flour");

    const reopened = createRecipeRepository(name);
    expect(await reopened.getActiveMenu()).toEqual([{ ...first, portions: 7 }, second]);
    await expect(reopened.saveActiveMenu([{ ...first, portions: 0 }])).rejects.toThrow("Portions");
    expect(await reopened.getActiveMenu()).toHaveLength(2);
    await reopened.saveActiveMenu([]);
    expect(await repository.getActiveMenu()).toEqual([]);
  });

  it("upgrades v1 in place, retaining earlier recipes and photos", async () => {
    const { name, repository } = setup();
    const existing: Recipe = {
      id: "custom-recipe", name: "Pan", photoId: "custom-photo", ingredients: [],
      steps: [], tags: [], categoryIds: [],
    };
    const oldDb = await openDB(name, 1, {
      upgrade(db) {
        for (const store of ["recipes", "photos", "ingredients", "categories"]) {
          db.createObjectStore(store, { keyPath: "id" });
        }
      },
    });

    await oldDb.put("recipes", existing);
    await oldDb.put("photos", { ...photo, id: existing.photoId });
    oldDb.close();

    expect((await repository.getLibrary()).recipes).toEqual([existing]);
    expect(await repository.getActiveMenu()).toEqual([]);
    expect((await repository.getPhoto("custom-photo"))?.blob.type).toBe("image/png");
    const db = await recipeDatabaseConnection(name)();
    try {
      expect(db.version).toBe(databaseVersion);
      expect([...db.objectStoreNames]).toEqual(["categories", "ingredients", "menu", "photos", "recipes"]);
    } finally {
      db.close();
    }
  });
});
