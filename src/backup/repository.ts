import type { IDBPDatabase, IDBPTransaction } from "idb";
import { sharedIngredientCatalog } from "../data/catalog";
import type { SharedIngredientCatalog } from "../data/catalog";
import {
  activeMenuKey, catalogCacheKey, databaseName, recipeDatabaseConnection, writeTransaction,
} from "../data/database";
import type { RecipeDatabase } from "../data/database";
import { requestPersistentStorage } from "../data/persistent-storage";
import { refreshActiveShopping } from "../shopping/repository";
import { materializeIngredients, splitIngredients } from "./catalog";
import { sameValue } from "./equality";
import { decodeBackupPhotos } from "./photo";
import { BackupError } from "./types";
import type { PersonalSnapshot } from "./types";
import { validateSnapshot } from "./validate";

const stores = ["recipes", "categories", "ingredients", "photos", "menu", "shopping"] as const;
type SnapshotStores = [...typeof stores];
type ReadableTransaction = IDBPTransaction<RecipeDatabase, SnapshotStores, "readonly" | "readwrite">;

async function readRecords(tx: ReadableTransaction) {
  const [recipes, categories, ingredients, photos, menu, catalog, shopping] = await Promise.all([
    tx.objectStore("recipes").getAll(),
    tx.objectStore("categories").getAll(),
    tx.objectStore("ingredients").getAll(),
    tx.objectStore("photos").getAll(),
    tx.objectStore("menu").get(activeMenuKey),
    tx.objectStore("menu").get(catalogCacheKey),
    tx.objectStore("shopping").get(activeMenuKey),
  ]);
  return { recipes, categories, ingredients, photos, menu, catalog, shopping };
}

type DatabaseRecords = Awaited<ReturnType<typeof readRecords>>;

async function readDatabase(db: IDBPDatabase<RecipeDatabase>): Promise<DatabaseRecords> {
  const tx = db.transaction([...stores], "readonly");
  const [records] = await Promise.all([readRecords(tx), tx.done]);
  return records;
}

async function toSnapshot(records: DatabaseRecords, catalog: SharedIngredientCatalog): Promise<PersonalSnapshot> {
  const { recipes, categories, ingredients, photos } = records;
  const menu = records.menu?.entries ?? [];
  const cache = records.catalog?.id === catalogCacheKey ? records.catalog : undefined;
  // Photos written by v1 can still contain Blobs. Their bytes are read outside IndexedDB transactions.
  const usedPhotos = new Set(recipes.map(({ photoId }) => photoId));
  const storedPhotos = await Promise.all(photos.filter(({ id }) => usedPhotos.has(id)).map(async (photo) => {
    if (!("blob" in photo)) return photo;
    const { blob, ...metadata } = photo;
    return { ...metadata, bytes: await blob.arrayBuffer(), mimeType: blob.type };
  }));

  return validateSnapshot({
    catalogVersion: catalog.version,
    ...splitIngredients(catalog, cache?.bases ?? [], cache?.overrides ?? [], ingredients, recipes, menu),
    recipes, categories, photos: storedPhotos, menu, shopping: records.shopping,
  });
}

export function createBackupRepository(name = databaseName, catalog: SharedIngredientCatalog = sharedIngredientCatalog) {
  const connection = recipeDatabaseConnection(name);

  async function commitSnapshot(value: PersonalSnapshot, expected?: DatabaseRecords): Promise<void> {
    const snapshot = validateSnapshot(value);
    const { ingredients, bases } = materializeIngredients(snapshot, catalog);
    await decodeBackupPhotos(snapshot.photos);
    await writeTransaction(await connection(), [...stores], async (tx) => {
      if (expected && !sameValue(await readRecords(tx), expected)) {
        throw new BackupError("stale", "The local library changed after the preview.");
      }

      await Promise.all(stores.map(async (store) => tx.objectStore(store).clear()));

      const menu = tx.objectStore("menu");
      const menuRecords: RecipeDatabase["menu"]["value"][] = [
        { id: activeMenuKey, entries: snapshot.menu },
        { id: catalogCacheKey, entries: [], catalogVersion: catalog.version, bases, overrides: snapshot.ingredientOverrides },
      ];
      // Wrap request creation so a synchronous failure still leaves every queued promise handled.
      await Promise.all([
        ...ingredients.map(async (row) => tx.objectStore("ingredients").add(row)),
        ...snapshot.categories.map(async (row) => tx.objectStore("categories").add(row)),
        ...snapshot.photos.map(async (row) => tx.objectStore("photos").add(row)),
        ...snapshot.recipes.map(async (row) => tx.objectStore("recipes").add(row)),
        ...menuRecords.map(async (row) => menu.add(row)),
      ]);
      if (snapshot.shopping) await tx.objectStore("shopping").put(snapshot.shopping, activeMenuKey);
    });
    if (name === databaseName) refreshActiveShopping();
    requestPersistentStorage();
  }

  return {
    /** Reads a consistent personal snapshot from the recipe, ingredient, photo, category and menu stores. */
    async readSnapshot(): Promise<PersonalSnapshot> {
      return toSnapshot(await readDatabase(await connection()), catalog);
    },

    /** Captures a restore baseline. Commit checks the same stores for edits before writing atomically. */
    async prepareRestore() {
      const records = await readDatabase(await connection());
      return {
        local: await toSnapshot(records, catalog),
        validate(snapshot: PersonalSnapshot): PersonalSnapshot {
          const validated = validateSnapshot(snapshot);
          materializeIngredients(validated, catalog);
          return validated;
        },
        commit: (snapshot: PersonalSnapshot) => commitSnapshot(snapshot, records),
      };
    },

    /** Atomically writes a validated destination snapshot. Use prepareRestore for an interactive merge. */
    commitSnapshot: (snapshot: PersonalSnapshot) => commitSnapshot(snapshot),
  };
}

export const backupRepository = createBackupRepository();
