import { ingredientClassifications } from "../contracts";
import type {
  Category, Ingredient, MenuEntry, PhotoInput, Recipe, RecipeDraft, RecipeRepository,
} from "../contracts";
import { createMenuEntry, normalizeMenuEntry } from "../domain/menu";
import { nonblank, normalizeDensity, normalizeRecipe, validatePortions } from "../domain/recipes";
import { activeMenuKey, databaseName, recipeDatabaseConnection, writeTransaction } from "./database";
import { requestPersistentStorage } from "./persistent-storage";

function validatePhoto(photo: PhotoInput): void {
  if (!(photo.blob instanceof Blob) || !photo.blob.size || !photo.blob.type.startsWith("image/")) {
    throw new RangeError("The photo must be a nonempty image blob.");
  }
  if (![photo.width, photo.height].every((size) => Number.isSafeInteger(size) && size > 0)) {
    throw new RangeError("Photo dimensions must be positive integers.");
  }
}

export function createRecipeRepository(name = databaseName): RecipeRepository {
  const getDatabase = recipeDatabaseConnection(name);

  async function changeMenu(change: (entries: MenuEntry[]) => MenuEntry[]): Promise<MenuEntry[]> {
    return writeTransaction(await getDatabase(), ["menu"], async (tx) => {
      const menu = tx.objectStore("menu");
      const entries = change((await menu.get(activeMenuKey))?.entries ?? []);
      await menu.put({ id: activeMenuKey, entries });
      return entries;
    });
  }

  return {
    async getLibrary() {
      const db = await getDatabase();
      const transaction = db.transaction(["recipes", "categories", "ingredients"], "readonly");
      const [recipes, categories, ingredients] = await Promise.all([
        transaction.objectStore("recipes").getAll(),
        transaction.objectStore("categories").getAll(),
        transaction.objectStore("ingredients").getAll(),
        transaction.done,
      ]);
      return { recipes, categories, ingredients };
    },

    async getPhoto(id) {
      const stored = await (await getDatabase()).get("photos", id);
      if (!stored || "blob" in stored) return stored;
      const { bytes, mimeType, ...dimensions } = stored;
      return { ...dimensions, blob: new Blob([bytes], { type: mimeType }) };
    },

    async saveRecipe(draft: RecipeDraft, photo?: PhotoInput | null) {
      const id = draft.id ?? crypto.randomUUID();
      const recipe = normalizeRecipe(draft, id);
      if (photo) validatePhoto(photo);
      // WebKit can reject Blob values in IndexedDB. Encode bytes before opening the write transaction.
      const replacement = photo ? {
        id: crypto.randomUUID(),
        bytes: await photo.blob.arrayBuffer(),
        mimeType: photo.blob.type,
        width: photo.width,
        height: photo.height,
      } : undefined;

      const isEdit = draft.id !== undefined;
      const saved = await writeTransaction(await getDatabase(), ["recipes", "photos", "categories", "ingredients"], async (tx) => {
        const recipes = tx.objectStore("recipes");
        const photos = tx.objectStore("photos");
        const categories = tx.objectStore("categories");
        const ingredients = tx.objectStore("ingredients");
        const ingredientIds = [...new Set(recipe.ingredients.map((line) => line.ingredientId))];
        const [existing, categoryKeys, ingredientKeys] = await Promise.all([
          recipes.get(id),
          Promise.all(recipe.categoryIds.map((categoryId) => categories.getKey(categoryId))),
          Promise.all(ingredientIds.map((ingredientId) => ingredients.getKey(ingredientId))),
        ]);

        if (isEdit && !existing) throw new RangeError("The recipe no longer exists.");
        if (categoryKeys.some((key) => key === undefined)) throw new RangeError("A category no longer exists.");
        if (ingredientKeys.some((key) => key === undefined)) throw new RangeError("An ingredient no longer exists.");

        const oldPhotoId = existing?.photoId;
        const photoId = replacement?.id ?? (photo === undefined ? oldPhotoId : undefined);
        const saved: Recipe = photoId ? { ...recipe, photoId } : recipe;

        if (replacement) await photos.add(replacement);
        if (oldPhotoId && oldPhotoId !== photoId) await photos.delete(oldPhotoId);
        await recipes.put(saved);
        return saved;
      });

      requestPersistentStorage();
      return saved;
    },

    async deleteRecipe(id) {
      await writeTransaction(await getDatabase(), ["recipes", "photos"], async (tx) => {
        const recipes = tx.objectStore("recipes");
        const existing = await recipes.get(id);
        if (existing?.photoId) await tx.objectStore("photos").delete(existing.photoId);
        await recipes.delete(id);
      });
    },

    async saveCategory(draft) {
      if (draft.kind !== "dish_type" && draft.kind !== "cuisine") throw new RangeError("The category kind is unknown.");
      const category: Category = {
        id: draft.id ?? crypto.randomUUID(),
        name: nonblank(draft.name, "Category name"),
        kind: draft.kind,
      };
      await (await getDatabase()).put("categories", category);
      return category;
    },

    async deleteCategory(id) {
      await writeTransaction(await getDatabase(), ["categories", "recipes"], async (tx) => {
        const recipes = tx.objectStore("recipes");
        for (const recipe of await recipes.getAll()) {
          if (!recipe.categoryIds.includes(id)) continue;
          await recipes.put({ ...recipe, categoryIds: recipe.categoryIds.filter((categoryId) => categoryId !== id) });
        }
        await tx.objectStore("categories").delete(id);
      });
    },

    async saveIngredient(draft) {
      if (draft.classification !== undefined && !ingredientClassifications.includes(draft.classification)) {
        throw new RangeError("The ingredient classification is unknown.");
      }

      const ingredient: Ingredient = {
        id: draft.id ?? crypto.randomUUID(),
        name: nonblank(draft.name, "Ingredient name"),
        ...(draft.parentId === undefined ? {} : { parentId: nonblank(draft.parentId, "Parent ingredient ID") }),
        ...(draft.classification === undefined ? {} : { classification: draft.classification }),
        ...(draft.density === undefined ? {} : { density: normalizeDensity(draft.density) }),
      };

      return writeTransaction(await getDatabase(), ["ingredients"], async (tx) => {
        const store = tx.objectStore("ingredients");
        const ancestors = new Set([ingredient.id]);
        let id = ingredient.parentId;
        while (id !== undefined) {
          if (ancestors.has(id)) throw new RangeError("Ingredient parents must not form a cycle.");
          const parent = await store.get(id);
          if (!parent) throw new RangeError("The parent ingredient no longer exists.");
          ancestors.add(id);
          id = parent.parentId;
        }
        await store.put(ingredient);
        return ingredient;
      });
    },

    async deleteIngredient(id) {
      await writeTransaction(await getDatabase(), ["ingredients", "recipes"], async (tx) => {
        const recipes = await tx.objectStore("recipes").getAll();
        if (recipes.some((recipe) => recipe.ingredients.some((line) => line.ingredientId === id))) {
          throw new RangeError("The ingredient is used in a saved recipe.");
        }

        const ingredients = tx.objectStore("ingredients");
        for (const ingredient of await ingredients.getAll()) {
          if (ingredient.parentId !== id) continue;
          delete ingredient.parentId;
          await ingredients.put(ingredient);
        }
        await ingredients.delete(id);
      });
    },

    async getActiveMenu() {
      const menu = await (await getDatabase()).get("menu", activeMenuKey);
      return menu?.entries ?? [];
    },

    async saveActiveMenu(entries) {
      const snapshots = entries.map(normalizeMenuEntry);
      if (new Set(snapshots.map((entry) => entry.id)).size !== snapshots.length) {
        throw new RangeError("Menu entry IDs must be unique.");
      }
      await (await getDatabase()).put("menu", { id: activeMenuKey, entries: snapshots });
    },

    async addMenuBatch(recipeId) {
      const id = crypto.randomUUID();
      const entries = await writeTransaction(await getDatabase(), ["menu", "recipes", "ingredients"], async (tx) => {
        const menu = tx.objectStore("menu");
        const [active, recipe] = await Promise.all([
          menu.get(activeMenuKey),
          tx.objectStore("recipes").get(recipeId),
        ]);
        if (!recipe) throw new RangeError("The recipe no longer exists.");

        const ingredients = tx.objectStore("ingredients");
        const ids = [...new Set(recipe.ingredients.map((line) => line.ingredientId))];
        const catalog = await Promise.all(ids.map((ingredientId) => ingredients.get(ingredientId)));
        const batch = createMenuEntry(recipe, catalog.filter((ingredient) => ingredient !== undefined), id);
        const entries = [...(active?.entries ?? []), batch];
        await menu.put({ id: activeMenuKey, entries });
        return entries;
      });
      requestPersistentStorage();
      return entries;
    },

    async setMenuBatchPortions(id, portions) {
      validatePortions(portions);
      return changeMenu((entries) => {
        if (!entries.some((entry) => entry.id === id)) throw new RangeError("The menu batch no longer exists.");
        return entries.map((entry) => entry.id === id ? { ...entry, portions } : entry);
      });
    },

    removeMenuBatch(id) {
      return changeMenu((entries) => entries.filter((entry) => entry.id !== id));
    },

    clearActiveMenu() {
      return changeMenu(() => []);
    },
  };
}

export const repository: RecipeRepository = createRecipeRepository();
