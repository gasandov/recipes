import "fake-indexeddb/auto";
import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import type { RecipeDraft } from "../contracts";
import { sharedIngredientCatalog } from "../data/catalog";
import { recipeDatabaseConnection } from "../data/database";
import { createRecipeRepository } from "../data/repository";
import { aggregateShoppingList, parseMeasuredAmount, parseRational } from "../domain";
import { createShoppingRepository } from "../shopping/repository";
import { saveManualItem } from "../shopping/workflow";
import {
  backupLimits, createBackupRepository, encodeBackup, planMerge, readBackup, suggestRecipeMatches, validateSnapshot,
} from "./index";
import type { PersonalSnapshot } from "./index";

const red = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const green = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC";
const image = (base64 = red) => Uint8Array.from(Buffer.from(base64, "base64")).buffer;

function draft(overrides: Partial<RecipeDraft> = {}): RecipeDraft {
  return {
    name: "Pan", enteredPortions: 4, ingredients: [], steps: [], categoryIds: [], tags: [], ...overrides,
  };
}

function setup(catalog = sharedIngredientCatalog) {
  const name = `backup-${crypto.randomUUID()}`;
  return { name, recipes: createRecipeRepository(name), backups: createBackupRepository(name, catalog) };
}

function personal(overrides: Partial<PersonalSnapshot> = {}): PersonalSnapshot {
  return {
    catalogVersion: 1, sharedIngredients: [], ingredients: [], ingredientOverrides: [], categories: [],
    recipes: [], photos: [], menu: [], ...overrides,
  };
}

function withManifest(snapshot: PersonalSnapshot, mutate: (manifest: Record<string, unknown>) => void) {
  const files = unzipSync(encodeBackup(snapshot));
  const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
  mutate(manifest);
  files["manifest.json"] = strToU8(JSON.stringify(manifest));
  return zipSync(files);
}

describe("F1 personal backup", () => {
  it("exports only used shared references, personal records and overrides", async () => {
    const { recipes, backups } = setup();
    expect(await backups.readSnapshot()).toMatchObject({
      sharedIngredients: [], ingredients: [], ingredientOverrides: [],
    });
    const personal = await recipes.saveIngredient({ name: "Harina del molino", parentId: "flour" });
    await recipes.saveIngredient({
      id: "flour", name: "Harina de trigo", classification: "plant",
      density: { source: "Measured", gramsPerMilliliter: parseRational("7/12") },
    });
    await recipes.deleteIngredient("garlic");
    await recipes.saveRecipe(draft({
      ingredients: [{ ingredientId: personal.id, amount: { kind: "qualitative", text: "al gusto" } }],
    }));

    const snapshot = await backups.readSnapshot();
    expect(snapshot.ingredients).toEqual([personal]);
    expect(snapshot.sharedIngredients).toEqual([
      { id: "flour", name: "Harina de trigo" },
      { id: "garlic", name: "Ajo" },
    ]);
    expect(snapshot.ingredientOverrides).toEqual([
      { id: "flour", density: { source: "Measured", gramsPerMilliliter: parseRational("7/12") } },
      { id: "garlic", hidden: true },
    ]);
    const files = unzipSync(encodeBackup(snapshot));
    expect(Object.keys(files)).toEqual(["manifest.json"]);
    expect(new TextDecoder().decode(files["manifest.json"])).not.toContain("Azúcar blanca granulada");
  });

  it("restores another library and preserves portable photos and exact shopping with an outdated catalog", async () => {
    const source = setup();
    const variety = await source.recipes.saveIngredient({
      name: "Harina de maíz azul", parentId: "flour", classification: "plant",
    });
    const category = await source.recipes.saveCategory({ name: "Pan dulce", kind: "dish_type" });
    const recipe = await source.recipes.saveRecipe(draft({
      enteredPortions: 3, categoryIds: [category.id], tags: ["vegan", "vegetarian"],
      ingredients: [
        { ingredientId: "flour", amount: parseMeasuredAmount("1/7–2/7", "cup") },
        { ingredientId: "flour", amount: parseMeasuredAmount("8/13", "gram") },
        { ingredientId: variety.id, amount: { kind: "unspecified" } },
      ],
      steps: ["Mezclar", "Hornear"], sourceUrl: "https://example.test/receta",
    }), { blob: new Blob([image()], { type: "image/png" }), width: 1, height: 1 });
    const [batch] = await source.recipes.addMenuBatch(recipe.id);
    await source.recipes.setMenuBatchPortions(batch.id, 13);
    const retired = await source.recipes.saveIngredient({ name: "Semillas de mi huerto" });
    const oldRecipe = await source.recipes.saveRecipe(draft({
      name: "Semillas", ingredients: [{ ingredientId: retired.id, amount: parseMeasuredAmount("2", "piece") }],
    }));
    await source.recipes.addMenuBatch(oldRecipe.id);
    await source.recipes.deleteRecipe(oldRecipe.id);
    await source.recipes.deleteIngredient(retired.id);
    const original = await source.backups.readSnapshot();

    const target = setup({ version: 1, ingredients: [{ id: "garlic", name: "Ajo del catálogo anterior" }] });
    await target.recipes.saveRecipe(draft({ name: "Previous recipe" }));
    const bytes = encodeBackup(original);
    expect(unzipSync(bytes)["photos/1"]).toEqual(new Uint8Array(image()));
    const staged = await target.backups.prepareRestore();
    const restored = await readBackup(bytes);
    expect(restored).toEqual(original);
    expect(await target.recipes.getLibrary()).toMatchObject({ recipes: [{ name: "Previous recipe" }] });
    await staged.commit(staged.validate(restored));

    const reopened = createRecipeRepository(target.name);
    const library = await reopened.getLibrary();
    expect(library.recipes).toEqual([recipe]);
    expect(library.categories).toContainEqual(category);
    expect(library.ingredients).toContainEqual({ id: "flour", name: "Harina de trigo" });
    expect(library.ingredients).toContainEqual(variety);
    expect(library.ingredients).toContainEqual({ id: "garlic", name: "Ajo del catálogo anterior" });
    expect(await reopened.getActiveMenu()).toEqual(original.menu);
    expect(aggregateShoppingList(await reopened.getActiveMenu())).toEqual(aggregateShoppingList(original.menu));
    expect(await (await reopened.getPhoto(recipe.photoId!))?.blob.arrayBuffer()).toEqual(image());
    expect((await target.backups.readSnapshot()).sharedIngredients).toEqual(original.sharedIngredients);
  });

  it("preserves a restored name and an explicit override through a second export without a catalog", async () => {
    const current = setup({ version: 2, ingredients: [{
      id: "flour", name: "Harina actualizada", classification: "plant",
      density: { source: "New measurement", gramsPerMilliliter: parseRational("4/5") },
    }] });
    const local = personal({
      sharedIngredients: [{ id: "flour", name: "Harina antigua" }],
      ingredientOverrides: [{ id: "flour", density: null }],
      recipes: [{
        id: "recipe", name: "Pan", ingredients: [{ ingredientId: "flour", amount: { kind: "unspecified" } }],
        steps: [], categoryIds: [], tags: [],
      }],
    });
    await current.backups.commitSnapshot(local);
    expect((await current.recipes.getLibrary()).ingredients).toEqual([
      { id: "flour", name: "Harina antigua", classification: "plant" },
    ]);

    const offline = setup({ version: 1, ingredients: [] });
    await offline.backups.commitSnapshot(await readBackup(encodeBackup(await current.backups.readSnapshot())));
    const onward = await offline.backups.readSnapshot();
    expect(onward.ingredientOverrides).toEqual([{ id: "flour", density: null }]);
    expect(onward.sharedIngredients).toEqual(local.sharedIngredients);
  });

  it("reads legacy Blob photos and writes bytes on import", async () => {
    const { name, backups, recipes } = setup();
    const recipe = await recipes.saveRecipe(draft());
    const db = await recipeDatabaseConnection(name)();
    await db.put("recipes", { ...recipe, photoId: "legacy" });
    await db.put("photos", { id: "legacy", blob: new Blob([image()], { type: "image/png" }), width: 1, height: 1 });

    const stage = await backups.prepareRestore();
    await stage.commit(await readBackup(encodeBackup(stage.local)));
    expect(await db.get("photos", "legacy")).toEqual({
      id: "legacy", bytes: image(), mimeType: "image/png", width: 1, height: 1,
    });
    db.close();
  });

  it("rejects invalid manifest references and amounts, incompatible versions, and unsafe ZIP data", async () => {
    const invalid = personal({
      recipes: [{ id: "recipe", name: "Pan", categoryIds: ["missing"], tags: [], ingredients: [], steps: [] }],
    });
    expect(() => validateSnapshot(invalid)).toThrow("missing category");
    await expect(readBackup(withManifest(personal(), (manifest) => { manifest.version = 999; })))
      .rejects.toMatchObject({ code: "version" });

    const missingIngredient = { id: "recipe", name: "Pan", categoryIds: [], tags: [], steps: [],
      ingredients: [{ ingredientId: "absent", amount: { kind: "unspecified" } }] };
    await expect(readBackup(withManifest(personal(), (manifest) => { manifest.recipes = [missingIngredient]; })))
      .rejects.toMatchObject({ code: "invalid" });

    const invalidAmount = {
      kind: "measured", unit: "cup", min: { numerator: "1", denominator: "0" },
    };
    await expect(readBackup(withManifest(personal(), (manifest) => {
      manifest.recipes = [{ ...missingIngredient, ingredients: [{ ingredientId: "flour", amount: invalidAmount }] }];
      manifest.sharedIngredients = [{ id: "flour", name: "Harina" }];
    }))).rejects.toMatchObject({ code: "invalid" });

    await expect(readBackup(zipSync({ "../manifest.json": strToU8("{}") }))).rejects.toMatchObject({ code: "invalid" });
    const stored = zipSync({ "manifest.json": [strToU8("{}"), { level: 0 }] });
    stored[43] ^= 1; // First byte of the stored entry, after its 30-byte header and name.
    await expect(readBackup(stored)).rejects.toMatchObject({ code: "invalid" });

    const zip = encodeBackup(personal());
    const view = new DataView(zip.buffer);
    const central = view.getUint32(zip.length - 6, true);
    view.setUint32(central + 24, backupLimits.manifestBytes + 1, true);
    await expect(readBackup(zip)).rejects.toMatchObject({ code: "limit" });
    // Change both headers to a plausible but incorrect expanded size.
    view.setUint32(central + 24, 4, true);
    view.setUint32(22, 4, true);
    await expect(readBackup(zip)).rejects.toMatchObject({ code: "invalid" });
  });

  it("rejects missing, invalid, orphaned and multiply-owned photos", async () => {
    const recipe = { id: "recipe", name: "Pan", photoId: "photo", ingredients: [], categoryIds: [], tags: [], steps: [] };
    const photo = { id: "photo", bytes: image(), width: 1, height: 1, mimeType: "image/png" };
    const snapshot = personal({ recipes: [recipe], photos: [photo] });
    const files = unzipSync(encodeBackup(snapshot));
    delete files["photos/1"];
    await expect(readBackup(zipSync(files))).rejects.toMatchObject({ code: "invalid" });
    files["photos/1"] = Uint8Array.of(1, 2, 3);
    await expect(readBackup(zipSync(files))).rejects.toMatchObject({ code: "invalid" });
    expect(() => validateSnapshot({ ...snapshot, recipes: [] })).toThrow("has no recipe");
    expect(() => validateSnapshot({ ...snapshot, recipes: [recipe, { ...recipe, id: "second" }] })).toThrow("several recipes");
    expect(() => validateSnapshot({ ...snapshot, photos: [{ ...photo, width: 2 }] })).toThrow("dimensions");
  });

  it("rejects stale restoration and rolls back failed writes across all stores", async () => {
    const { name, recipes, backups } = setup();
    const recipe = await recipes.saveRecipe(draft(), { blob: new Blob([image()], { type: "image/png" }), width: 1, height: 1 });
    await recipes.addMenuBatch(recipe.id);
    const stage = await backups.prepareRestore();
    await createRecipeRepository(name).saveRecipe(draft({ id: recipe.id, name: "Changed on another tab" }));
    await expect(stage.commit(personal())).rejects.toMatchObject({ code: "stale" });

    const current = await backups.prepareRestore();
    const nativeAdd = IDBObjectStore.prototype.add;
    const add = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "menu") throw new DOMException("Injected failure", "QuotaExceededError");
      return nativeAdd.call(this, ...args);
    });
    try {
      await expect(current.commit(personal())).rejects.toMatchObject({ name: "QuotaExceededError" });
    } finally {
      add.mockRestore();
    }
    expect(await backups.readSnapshot()).toEqual(current.local);
  });

  it("detects a shopping edit after preview even when the recipe and menu stores have not changed", async () => {
    const { name, backups } = setup();
    const stage = await backups.prepareRestore();
    const item = { id: "limes", name: "Limones", amount: parseMeasuredAmount("2–3", "piece") };
    await createShoppingRepository(name).update((current) => saveManualItem(current, item));
    await expect(stage.commit(personal())).rejects.toMatchObject({ code: "stale" });
    await expect(backups.readSnapshot()).resolves.toMatchObject({ shopping: { manualItems: [item] } });
  });
});

describe("personal snapshot merge", () => {
  const recipe = { id: "recipe", name: "Pan", photoId: "photo", ingredients: [], categoryIds: [], tags: [], steps: [] };
  const photo = { id: "photo", bytes: image(), width: 1, height: 1, mimeType: "image/png" };
  const batch = { id: "menu-1", sourceRecipeId: recipe.id, name: recipe.name, ingredients: [], portions: 4 };

  it("resolves changed duplicate records individually and keeps distinct same-name recipes", () => {
    const category = { id: "category", name: "Panadería", kind: "dish_type" as const };
    const local = personal({ categories: [category], recipes: [recipe], photos: [photo], menu: [batch] });
    const { photoId: _photoId, ...withoutPhoto } = recipe;
    const incoming = personal({
      categories: [{ ...category, name: "Panes" }],
      recipes: [{ ...recipe, steps: ["New steps"] }, { ...withoutPhoto, id: "distinct" }],
      photos: [{ ...photo, bytes: image(green) }],
      menu: [batch, { ...batch, id: "menu-2", sourceRecipeId: "distinct" }],
    });
    const merge = planMerge(local, incoming);
    expect(merge.conflicts.map(({ collection }) => collection)).toEqual(["categories", "recipes", "photos"]);
    expect(() => merge.resolve(new Map())).toThrow("needs a decision");

    const result = merge.resolve(new Map(merge.conflicts.map(({ key, collection }) => [
      key, collection === "categories" ? "local" : "incoming",
    ])));
    expect(result.recipes).toEqual(incoming.recipes);
    expect(result.categories).toEqual(local.categories);
    expect(result.photos).toEqual(incoming.photos);
    expect(result.menu).toEqual(incoming.menu);
  });

  it("can pair same-name recipes explicitly and keep the winning recipe's photo and menu links", () => {
    const renamed = { ...recipe, id: "other", name: "pán", photoId: "other-photo" };
    const local = personal({ recipes: [recipe], photos: [photo], menu: [batch] });
    const incoming = personal({ recipes: [renamed], photos: [{ ...photo, id: "other-photo" }] });
    expect(suggestRecipeMatches(local, incoming)).toEqual([{ local: recipe, incoming: [renamed] }]);
    const merge = planMerge(local, incoming, [{ localId: recipe.id, incomingId: renamed.id }]);
    const result = merge.resolve(new Map([[merge.conflicts[0].key, "incoming"]]));
    expect(result.recipes).toEqual([renamed]);
    expect(result.photos).toEqual(incoming.photos);
    expect(result.menu).toEqual([{ ...batch, sourceRecipeId: renamed.id }]);
  });

  it("reports a hidden shared ingredient needed by the other device as a conflict", () => {
    const sharedIngredients = [{ id: "flour", name: "Harina" }];
    const local = personal({ sharedIngredients, ingredientOverrides: [{ id: "flour", hidden: true }] });
    const { photoId: _photoId, ...withoutPhoto } = recipe;
    const incoming = personal({ sharedIngredients, recipes: [{
      ...withoutPhoto, ingredients: [{ ingredientId: "flour", amount: { kind: "unspecified" } }],
    }] });
    const merge = planMerge(local, incoming);
    expect(merge.conflicts).toHaveLength(1);
    const [{ key }] = merge.conflicts;
    expect(() => merge.resolve(new Map([[key, "local"]]))).toThrow("missing ingredient");
    expect(merge.resolve(new Map([[key, "incoming"]]))).toMatchObject({
      recipes: incoming.recipes, ingredientOverrides: [],
    });
  });
});
