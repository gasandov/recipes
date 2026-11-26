import type { Category, Ingredient, MenuEntry, Recipe } from "../contracts";
import type { CatalogReference, IngredientOverride, PersonalSnapshot } from "../backup";
import type { SharedIngredientCatalog } from "../data/catalog";
import type { StoredPhoto } from "../data/database";
import { units } from "../domain/measurements";
import type { ShoppingState } from "../shopping/workflow";
import { collections } from "./types";
import type { Collection, JsonObject, RecordData, RepairNote } from "./types";

/** The personal snapshot as the sync engine reads it. F5 adds the optional shopping state. */
export type SyncSnapshot = PersonalSnapshot & { shopping?: ShoppingState };

export type SyncRecord = { collection: Collection; id: string; data: RecordData; json: string };

export const recordKey = (collection: Collection, id: string): string => JSON.stringify([collection, id]);

export function parseRecordKey(key: string): { collection: Collection; id: string } {
  const [collection, id] = JSON.parse(key) as [Collection, string];
  if (!collections.includes(collection) || typeof id !== "string") throw new TypeError("Invalid record key.");
  return { collection, id };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const record = value as JsonObject;
    return Object.fromEntries(Object.keys(record).sort()
      .filter((key) => record[key] !== undefined).map((key) => [key, sortKeys(record[key])]));
  }
  return value;
}

/** Key order and omitted optional properties never change the comparison. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Copies a value through JSON so undefined properties disappear exactly as they do on the wire. */
export function toRecordData<T extends { id: string }>(value: T): RecordData {
  return JSON.parse(JSON.stringify(value)) as RecordData;
}

export function makeRecord(collection: Collection, data: RecordData): SyncRecord {
  return { collection, id: data.id, data, json: canonicalJson(data) };
}

type PhotoMeta = { id: string; mimeType: string; width: number; height: number };

const balanceId = (groupId: string, unit: keyof typeof units) => JSON.stringify([groupId, units[unit].dimension]);
const checkedId = (groupId: string, note: string | null) => JSON.stringify([groupId, note]);

/** Splits a snapshot into independently synchronized records keyed by stable IDs. Photo bytes stay out. */
export function snapshotRecords(snapshot: SyncSnapshot): Map<string, SyncRecord> {
  const out = new Map<string, SyncRecord>();
  const add = (collection: Collection, value: { id: string }) => {
    out.set(recordKey(collection, value.id), makeRecord(collection, toRecordData(value)));
  };
  for (const row of snapshot.recipes) add("recipes", row);
  for (const row of snapshot.categories) add("categories", row);
  for (const row of snapshot.ingredients) add("ingredients", row);
  for (const row of snapshot.ingredientOverrides) add("ingredient_overrides", row);
  for (const row of snapshot.sharedIngredients) add("shared_ingredients", row);
  for (const row of snapshot.menu) add("menu", row);
  for (const { bytes: _bytes, ...meta } of snapshot.photos) add("photos", meta);
  const shopping = snapshot.shopping;
  for (const item of shopping?.manualItems ?? []) add("shopping_items", item);
  for (const row of shopping?.balances ?? []) add("shopping_balances", { ...row, id: balanceId(row.groupId, row.unit) });
  for (const row of shopping?.checked ?? []) add("shopping_checked", { ...row, id: checkedId(row.groupId, row.note) });
  return out;
}

export type DesiredRecord = { collection: Collection; id: string; data: RecordData };

type Parts = {
  ingredients: Ingredient[];
  ingredientOverrides: IngredientOverride[];
  categories: Category[];
  recipes: Recipe[];
  photos: PhotoMeta[];
  menu: MenuEntry[];
  sharedIngredients: Map<string, string>;
  shopping: { items: JsonObject[]; balances: JsonObject[]; checked: JsonObject[] };
};

function partsFrom(records: Iterable<DesiredRecord>, orderOf: (key: string) => number): Parts {
  const parts: Parts = {
    ingredients: [], ingredientOverrides: [], categories: [], recipes: [], photos: [], menu: [],
    sharedIngredients: new Map(), shopping: { items: [], balances: [], checked: [] },
  };
  const ordered: { collection: Collection; data: RecordData; order: number; index: number }[] = [];
  let index = 0;
  for (const { collection, id, data } of records) ordered.push({ collection, data, order: orderOf(recordKey(collection, id)), index: index++ });
  // Menu batches and manual items keep the order in which the server first saw them.
  ordered.sort((a, b) => a.order - b.order || a.index - b.index);
  for (const { collection, data } of ordered) {
    switch (collection) {
      case "recipes": parts.recipes.push(data as unknown as Recipe); break;
      case "categories": parts.categories.push(data as unknown as Category); break;
      case "ingredients": parts.ingredients.push(data as unknown as Ingredient); break;
      case "ingredient_overrides": parts.ingredientOverrides.push(data as unknown as IngredientOverride); break;
      case "shared_ingredients": parts.sharedIngredients.set(data.id, String(data.name)); break;
      case "menu": parts.menu.push(data as unknown as MenuEntry); break;
      case "photos": parts.photos.push(data as unknown as PhotoMeta); break;
      case "shopping_items": parts.shopping.items.push(data); break;
      case "shopping_balances": parts.shopping.balances.push(data); break;
      case "shopping_checked": parts.shopping.checked.push(data); break;
    }
  }
  return parts;
}

const byId = <T extends { id: string }>(left: T, right: T) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

/**
 * Makes independently merged records consistent again. Concurrent edits to different records can break a
 * reference: a category deleted on one device and used by a recipe on another, a photo that lost its recipe,
 * an ingredient parent cycle. Repairs are deterministic, so every device reaches the same result, and they
 * only remove or detach references. The repaired records differ from the server, so the next push shares them.
 */
function repair(parts: Parts, catalog: SharedIngredientCatalog): RepairNote[] {
  const notes: RepairNote[] = [];
  const known = new Map<string, string>(catalog.ingredients.map((entry) => [entry.id, entry.name]));
  for (const [id, name] of parts.sharedIngredients) known.set(id, name);
  // Repairs edit copies. The inputs are shared with the caller's record maps.
  parts.ingredients = parts.ingredients.map((entry) => ({ ...entry }));
  let personal = new Map(parts.ingredients.map((entry) => [entry.id, entry]));
  for (const id of personal.keys()) known.delete(id);

  let overrides = parts.ingredientOverrides.filter((entry) => known.has(entry.id));
  for (const dropped of parts.ingredientOverrides.filter((entry) => !known.has(entry.id))) {
    notes.push({ code: "overrideDropped", subject: dropped.id });
  }
  const hiddenIds = () => new Set(overrides.flatMap((entry) => entry.hidden ? [entry.id] : []));
  const available = () => {
    const hidden = hiddenIds();
    return new Set([...personal.keys(), ...[...known.keys()].filter((id) => !hidden.has(id))]);
  };

  // A hidden shared ingredient that another record still needs becomes visible again.
  const needed = new Set<string>([
    ...parts.recipes.flatMap((recipe) => recipe.ingredients.map((line) => line.ingredientId)),
    ...parts.ingredients.flatMap((entry) => entry.parentId ? [entry.parentId] : []),
    ...overrides.flatMap((entry) => typeof entry.parentId === "string" ? [entry.parentId] : []),
  ]);
  overrides = overrides.filter((entry) => !(entry.hidden && needed.has(entry.id)));

  const ids = available();
  const fixParent = <T extends { id: string; parentId?: string | null }>(entry: T, subject: string): T | undefined => {
    if (typeof entry.parentId !== "string" || ids.has(entry.parentId)) return entry;
    notes.push({ code: "parentCleared", subject });
    const { parentId: _removed, ...rest } = entry;
    return rest as T;
  };
  parts.ingredients = parts.ingredients.flatMap((entry) => fixParent(entry, entry.name) ?? []);
  personal = new Map(parts.ingredients.map((entry) => [entry.id, entry]));
  overrides = overrides.flatMap((entry) => {
    const fixed = fixParent(entry, known.get(entry.id) ?? entry.id);
    // An override with only an ID has no content left.
    return fixed && Object.keys(fixed).length > 1 ? [fixed] : [];
  });

  // Break parent cycles at the greatest ID so every device chooses the same edge.
  const parentOf = (id: string): string | undefined => {
    const own = personal.get(id)?.parentId;
    if (personal.has(id)) return own;
    const parent = overrides.find((entry) => entry.id === id)?.parentId;
    return typeof parent === "string" ? parent : undefined;
  };
  for (const start of [...ids].sort()) {
    const chain: string[] = [];
    let current: string | undefined = start;
    while (current !== undefined && !chain.includes(current)) {
      chain.push(current);
      current = parentOf(current);
    }
    if (current === undefined) continue;
    const cycle = chain.slice(chain.indexOf(current));
    const edge = cycle.reduce((max, id) => id > max ? id : max);
    notes.push({ code: "parentCleared", subject: personal.get(edge)?.name ?? known.get(edge) ?? edge });
    const entry = personal.get(edge);
    if (entry) {
      delete entry.parentId;
    } else {
      overrides = overrides.map((item) => item.id === edge ? { ...item, parentId: null } : item);
    }
  }
  parts.ingredientOverrides = overrides;

  const categoryIds = new Set(parts.categories.map((entry) => entry.id));
  const photoIds = new Set(parts.photos.map((entry) => entry.id));
  const usedPhotos = new Set<string>();
  const visible = available();
  parts.recipes = [...parts.recipes].sort(byId).map((recipe) => {
    const lines = recipe.ingredients.filter((line) => visible.has(line.ingredientId));
    if (lines.length !== recipe.ingredients.length) notes.push({ code: "ingredientLineRemoved", subject: recipe.name });
    const categories = recipe.categoryIds.filter((id) => categoryIds.has(id));
    if (categories.length !== recipe.categoryIds.length) notes.push({ code: "categoryRemoved", subject: recipe.name });
    let photoId = recipe.photoId;
    if (photoId !== undefined && (!photoIds.has(photoId) || usedPhotos.has(photoId))) {
      notes.push({ code: "photoDetached", subject: recipe.name });
      photoId = undefined;
    }
    if (photoId !== undefined) usedPhotos.add(photoId);
    const { photoId: _old, ...rest } = recipe;
    return { ...rest, ingredients: lines, categoryIds: categories, ...(photoId === undefined ? {} : { photoId }) };
  });
  parts.photos = parts.photos.filter((photo) => usedPhotos.has(photo.id));
  return notes;
}

/** Applies reference repairs and reports the photos that the repaired records still use. */
export function planSnapshot(
  records: Iterable<DesiredRecord>,
  catalog: SharedIngredientCatalog,
  orderOf: (key: string) => number,
): { parts: Parts; notes: RepairNote[]; photoIds: string[] } {
  const parts = partsFrom(records, orderOf);
  const notes = repair(parts, catalog);
  return { parts, notes, photoIds: parts.photos.map(({ id }) => id) };
}

export type SnapshotParts = ReturnType<typeof planSnapshot>["parts"];

const stripId = ({ id: _id, ...rest }: JsonObject) => rest;

function shoppingState({ items, balances, checked }: Parts["shopping"]): ShoppingState | undefined {
  // An empty shopping state is omitted from snapshots.
  if (!items.length && !balances.length && !checked.length) return undefined;
  return {
    version: 1,
    manualItems: items as unknown as ShoppingState["manualItems"],
    balances: [...balances].sort((a, b) => byId(a as RecordData, b as RecordData)).map(stripId) as unknown as ShoppingState["balances"],
    checked: [...checked].sort((a, b) => byId(a as RecordData, b as RecordData)).map(stripId) as unknown as ShoppingState["checked"],
  };
}

/** Builds the shopping state of a snapshot from its `shopping_*` records. */
export function buildShopping(records: Iterable<DesiredRecord>, orderOf: (key: string) => number): ShoppingState | undefined {
  return shoppingState(partsFrom(records, orderOf).shopping);
}

/** Builds the final snapshot. The caller supplies the bytes of every photo that remains. */
export function assembleSnapshot(
  parts: SnapshotParts,
  catalog: SharedIngredientCatalog,
  catalogVersion: number,
  photoBytes: ReadonlyMap<string, ArrayBuffer>,
): SyncSnapshot {
  const photos: StoredPhoto[] = parts.photos.map((meta) => {
    const bytes = photoBytes.get(meta.id);
    if (!bytes) throw new RangeError("A photo is missing its bytes.");
    return { ...meta, bytes };
  });
  const personal = new Set(parts.ingredients.map(({ id }) => id));
  const names = new Map<string, string>(catalog.ingredients.map((entry) => [entry.id, entry.name]));
  for (const [id, name] of parts.sharedIngredients) names.set(id, name);
  const referenced = new Set<string>([
    ...parts.recipes.flatMap((recipe) => recipe.ingredients.map((line) => line.ingredientId)),
    ...parts.menu.flatMap((entry) => entry.ingredients.map((line) => line.ingredientId)),
    ...parts.ingredients.flatMap((entry) => entry.parentId ? [entry.parentId] : []),
    ...parts.ingredientOverrides.flatMap((entry) => [entry.id, ...(typeof entry.parentId === "string" ? [entry.parentId] : [])]),
  ]);
  const sharedIngredients: CatalogReference[] = [...referenced]
    .filter((id) => !personal.has(id) && names.has(id)).sort()
    .map((id) => ({ id, name: names.get(id)! }));

  const shopping = shoppingState(parts.shopping);

  return {
    catalogVersion,
    sharedIngredients,
    ingredients: parts.ingredients,
    ingredientOverrides: parts.ingredientOverrides,
    categories: parts.categories,
    recipes: parts.recipes,
    photos,
    menu: parts.menu,
    ...(shopping ? { shopping } : {}),
  };
}

/** A person-readable name for notices. */
export function recordName(data: RecordData | undefined, fallback: string): string {
  return typeof data?.name === "string" && data.name ? data.name : fallback;
}
