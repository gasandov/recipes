import { describe, expect, it } from "vitest";
import type { Ingredient, Recipe } from "../contracts";
import { sharedIngredientCatalog } from "../data/catalog";
import { assembleSnapshot, planSnapshot, recordKey, snapshotRecords } from "./records";
import type { DesiredRecord } from "./records";
import type { Collection, RecordData } from "./types";

const recipe = (id: string, overrides: Partial<Recipe> = {}): Recipe => ({
  id, name: id, ingredients: [], steps: [], categoryIds: [], tags: [], ...overrides,
});
const desired = (collection: Collection, value: { id: string }): DesiredRecord => ({ collection, id: value.id, data: value as RecordData });
const build = (records: DesiredRecord[]) => {
  const { parts, notes } = planSnapshot(records, sharedIngredientCatalog, () => Number.MAX_SAFE_INTEGER);
  return { snapshot: assembleSnapshot(parts, sharedIngredientCatalog, 1, new Map([["p1", new ArrayBuffer(1)]])), notes };
};
const line = (ingredientId: string) => ({ ingredientId, amount: { kind: "unspecified" as const } });

describe("record mapping and repairs", () => {
  it("splits a snapshot into stable-ID records and rebuilds the same snapshot", () => {
    const records = [
      desired("categories", { id: "c1", name: "Cenas", kind: "dish_type" } as RecordData),
      desired("recipes", recipe("r1", { categoryIds: ["c1"], ingredients: [line("flour")] })),
    ];
    const { snapshot, notes } = build(records);
    expect(notes).toEqual([]);
    expect(snapshot.sharedIngredients).toEqual([{ id: "flour", name: "Harina de trigo" }]);
    expect([...snapshotRecords(snapshot).keys()].sort()).toEqual([
      recordKey("categories", "c1"), recordKey("recipes", "r1"), recordKey("shared_ingredients", "flour"),
    ].sort());
  });

  it("removes a line whose personal ingredient was deleted elsewhere", () => {
    const { snapshot, notes } = build([desired("recipes", recipe("r1", { ingredients: [line("gone"), line("egg")] }))]);
    expect(snapshot.recipes[0]!.ingredients.map((entry) => entry.ingredientId)).toEqual(["egg"]);
    expect(notes).toEqual([{ code: "ingredientLineRemoved", subject: "r1" }]);
  });

  it("makes a hidden shared ingredient visible again when a recipe still uses it", () => {
    const { snapshot } = build([
      desired("ingredient_overrides", { id: "egg", hidden: true } as RecordData),
      desired("recipes", recipe("r1", { ingredients: [line("egg")] })),
    ]);
    expect(snapshot.ingredientOverrides).toEqual([]);
    expect(snapshot.recipes[0]!.ingredients).toHaveLength(1);
  });

  it("breaks concurrent parent cycles at the same edge on every device", () => {
    const first: Ingredient = { id: "a", name: "A", parentId: "b" };
    const second: Ingredient = { id: "b", name: "B", parentId: "a" };
    for (const order of [[first, second], [second, first]]) {
      const { snapshot, notes } = build(order.map((item) => desired("ingredients", item)));
      expect(snapshot.ingredients.find((item) => item.id === "a")?.parentId).toBe("b");
      expect(snapshot.ingredients.find((item) => item.id === "b")?.parentId).toBeUndefined();
      expect(notes).toEqual([{ code: "parentCleared", subject: "B" }]);
    }
  });

  it("detaches photos that were lost or shared, and drops photos without a recipe", () => {
    const photos = ["p1", "p2", "p3"].map((id) => desired("photos", { id, mimeType: "image/png", width: 1, height: 1 } as RecordData));
    const { snapshot, notes } = build([
      ...photos,
      desired("recipes", recipe("r1", { photoId: "p1" })),
      desired("recipes", recipe("r2", { photoId: "p1" })),
      desired("recipes", recipe("r3", { photoId: "missing" })),
    ]);
    expect(snapshot.recipes.map((entry) => [entry.id, entry.photoId])).toEqual([["r1", "p1"], ["r2", undefined], ["r3", undefined]]);
    expect(snapshot.photos.map((photo) => photo.id)).toEqual(["p1"]);
    expect(notes.filter((note) => note.code === "photoDetached")).toHaveLength(2);
  });
});
