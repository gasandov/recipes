import { openDB } from "idb";
import type { DBSchema, IDBPDatabase, IDBPTransaction, StoreNames } from "idb";
import type { Category, Ingredient, MenuEntry, Photo, Recipe } from "../contracts";
import { initialCategories, initialIngredients } from "./seed";

export const databaseName = "recetario-local";
export const databaseVersion = 2;
export const activeMenuKey = "active";

type StoredPhoto = Omit<Photo, "blob"> & { bytes: ArrayBuffer; mimeType: string };

export interface RecipeDatabase extends DBSchema {
  recipes: { key: string; value: Recipe };
  photos: { key: string; value: StoredPhoto | Photo };
  ingredients: { key: string; value: Ingredient };
  categories: { key: string; value: Category };
  menu: { key: typeof activeMenuKey; value: { id: typeof activeMenuKey; entries: MenuEntry[] } };
}

export function recipeDatabaseConnection(name: string): () => Promise<IDBPDatabase<RecipeDatabase>> {
  let connection: Promise<IDBPDatabase<RecipeDatabase>> | undefined;

  return () => {
    connection ??= openDB<RecipeDatabase>(name, databaseVersion, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore("recipes", { keyPath: "id" });
          db.createObjectStore("photos", { keyPath: "id" });
          const ingredients = db.createObjectStore("ingredients", { keyPath: "id" });
          const categories = db.createObjectStore("categories", { keyPath: "id" });
          // Any failed seed request aborts the upgrade. Keep idb's request promises handled.
          for (const ingredient of initialIngredients) void ingredients.add(ingredient).catch(() => {});
          for (const category of initialCategories) void categories.add(category).catch(() => {});
        }
        if (oldVersion < 2) {
          db.createObjectStore("menu", { keyPath: "id" });
        }
      },
      blocking() {
        void connection?.then((db) => db.close());
        connection = undefined;
      },
      terminated() {
        connection = undefined;
      },
    }).catch((error: unknown) => {
      connection = undefined;
      throw error;
    });

    return connection;
  };
}

export async function writeTransaction<Stores extends StoreNames<RecipeDatabase>[], Result>(
  db: IDBPDatabase<RecipeDatabase>,
  stores: Stores,
  write: (transaction: IDBPTransaction<RecipeDatabase, Stores, "readwrite">) => Promise<Result>,
): Promise<Result> {
  const transaction = db.transaction(stores, "readwrite");
  const settled = transaction.done.catch(() => {});

  try {
    const result = await write(transaction);
    await transaction.done;
    return result;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // The transaction may already have aborted after a failed request.
    }
    await settled;
    throw error;
  }
}
