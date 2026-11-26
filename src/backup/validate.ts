import { ingredientClassifications, tagIds, unitIds } from "../contracts";
import type { Amount, Density, Ingredient, Rational } from "../contracts";
import { normalizeAmount } from "../domain/measurements";
import { compareRational, normalizeRational } from "../domain/rational";
import { normalizeSourceUrl } from "../domain/recipes";
import { decodeShoppingState } from "../shopping/repository";
import { validatePhotoData } from "./photo";
import { BackupError, backupLimits } from "./types";
import type { IngredientOverride, PersonalSnapshot } from "./types";

export function requireBackup(condition: unknown, message: string): asserts condition {
  if (!condition) throw new BackupError("invalid", message);
}

export function object(value: unknown): Record<string, unknown> {
  requireBackup(value && typeof value === "object" && !Array.isArray(value), "Expected a record.");
  return value as Record<string, unknown>;
}

export function list(value: unknown, limit: number = backupLimits.records): unknown[] {
  requireBackup(Array.isArray(value), "Expected a list.");
  if (value.length > limit) throw new BackupError("limit", "A backup list has too many items.");
  return value;
}

export function text(value: unknown): string {
  requireBackup(typeof value === "string" && value.trim(), "Expected nonblank text.");
  return value as string;
}

function id(value: unknown): string {
  const result = text(value);
  requireBackup(result === result.trim() && result.length <= 512
    && [...result].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
    "Invalid record ID.");
  return result;
}

export function positiveInteger(value: unknown): number {
  requireBackup(typeof value === "number" && Number.isSafeInteger(value) && value > 0, "Expected a positive integer.");
  return value;
}

function member<T extends string>(value: unknown, allowed: readonly T[]): T {
  requireBackup(typeof value === "string" && allowed.includes(value as T), "Unexpected value.");
  return value as T;
}

function optional<T>(value: unknown, parse: (input: unknown) => T): T | undefined {
  return value === undefined ? undefined : parse(value);
}

function nullable<T>(value: unknown, parse: (input: unknown) => T): T | null | undefined {
  return value === null ? null : optional(value, parse);
}

function rational(value: unknown): Rational {
  const record = object(value);
  const numerator = text(record.numerator);
  const denominator = text(record.denominator);
  if (Math.max(numerator.length, denominator.length) > backupLimits.rationalDigits) {
    throw new BackupError("limit", "A quantity has too many digits.");
  }
  return normalizeRational({ numerator, denominator });
}

function density(value: unknown): Density {
  const record = object(value);
  return { gramsPerMilliliter: rational(record.gramsPerMilliliter), source: text(record.source) };
}

function classification(value: unknown) {
  return member(value, ingredientClassifications);
}

function amount(value: unknown): Amount {
  const record = object(value);
  const kind = member(record.kind, ["unspecified", "qualitative", "measured"]);
  if (kind === "unspecified") return { kind };
  if (kind === "qualitative") return { kind, text: text(record.text) };
  const min = rational(record.min);
  const max = optional(record.max, rational);
  requireBackup(!max || compareRational(min, max) <= 0, "The quantity range is reversed.");
  return normalizeAmount({ kind, unit: member(record.unit, unitIds), min, max });
}

function ingredient(value: unknown): Ingredient {
  const record = object(value);
  const parentId = optional(record.parentId, id);
  const group = optional(record.classification, classification);
  const equivalence = optional(record.density, density);
  return {
    id: id(record.id), name: text(record.name),
    ...(parentId === undefined ? {} : { parentId }),
    ...(group === undefined ? {} : { classification: group }),
    ...(equivalence === undefined ? {} : { density: equivalence }),
  };
}

function override(value: unknown): IngredientOverride {
  const record = object(value);
  requireBackup(record.hidden === undefined || record.hidden === true, "Invalid catalog visibility.");
  const name = optional(record.name, text);
  const parentId = nullable(record.parentId, id);
  const group = nullable(record.classification, classification);
  const equivalence = nullable(record.density, density);
  const result = {
    id: id(record.id),
    ...(record.hidden ? { hidden: true as const } : {}),
    ...(name === undefined ? {} : { name }),
    ...(parentId === undefined ? {} : { parentId }),
    ...(group === undefined ? {} : { classification: group }),
    ...(equivalence === undefined ? {} : { density: equivalence }),
  };
  requireBackup(record.hidden ? Object.keys(result).length === 2 : Object.keys(result).length > 1,
    "Invalid ingredient override.");
  return result;
}

function line(value: unknown) {
  const record = object(value);
  return { ingredientId: id(record.ingredientId), amount: amount(record.amount) };
}

function unique<T>(values: T[]): T[] {
  requireBackup(new Set(values).size === values.length, "Duplicate values are not allowed.");
  return values;
}

function rowMap<T extends { id: string }>(rows: T[]): Map<string, T> {
  unique(rows.map((row) => row.id));
  return new Map(rows.map((row) => [row.id, row]));
}

export function validateIngredientParents(ingredients: Ingredient[]): void {
  const byId = rowMap(ingredients);
  const checked = new Set<string>();
  for (const { id } of ingredients) {
    const chain = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined && !checked.has(current)) {
      const entry = byId.get(current);
      requireBackup(entry && !chain.has(current), "An ingredient parent is missing or forms a cycle.");
      chain.add(current);
      current = entry.parentId;
    }
    for (const key of chain) checked.add(key);
  }
}

function parseSnapshot(value: unknown): PersonalSnapshot {
  const snapshot = object(value);
  const ingredients = list(snapshot.ingredients).map(ingredient);
  const sharedIngredients = list(snapshot.sharedIngredients).map((item) => {
    const row = object(item);
    return { id: id(row.id), name: text(row.name) };
  });
  const ingredientOverrides = list(snapshot.ingredientOverrides).map(override);
  const categories = list(snapshot.categories).map((item) => {
    const row = object(item);
    return { id: id(row.id), name: text(row.name), kind: member(row.kind, ["dish_type", "cuisine"]) };
  });
  const recipes = list(snapshot.recipes).map((item) => {
    const row = object(item);
    const photoId = optional(row.photoId, id);
    const sourceUrl = optional(row.sourceUrl, (value) => normalizeSourceUrl(text(value)));
    return {
      id: id(row.id), name: text(row.name),
      ...(photoId === undefined ? {} : { photoId }),
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
      ingredients: list(row.ingredients).map(line),
      steps: list(row.steps).map(text),
      categoryIds: unique(list(row.categoryIds).map(id)),
      tags: unique(list(row.tags).map((tag) => member(tag, tagIds))),
    };
  });
  let photoBytes = 0;
  const photos = list(snapshot.photos, backupLimits.photos).map((item) => {
    const row = object(item);
    const bytes = row.bytes;
    requireBackup(bytes instanceof ArrayBuffer && bytes.byteLength > 0, "A photo is missing its bytes.");
    photoBytes += bytes.byteLength;
    if (photoBytes > backupLimits.expandedBytes) throw new BackupError("limit", "The photos exceed the backup size limit.");
    const photo = {
      id: id(row.id), bytes, mimeType: member(row.mimeType, ["image/jpeg", "image/png", "image/webp"]),
      width: positiveInteger(row.width), height: positiveInteger(row.height),
    };
    validatePhotoData(photo);
    return photo;
  });
  const menu = list(snapshot.menu).map((item) => {
    const row = object(item);
    return {
      id: id(row.id), sourceRecipeId: id(row.sourceRecipeId), name: text(row.name),
      portions: positiveInteger(row.portions),
      ingredients: list(row.ingredients).map((item) => {
        const record = object(item);
        const equivalence = optional(record.density, density);
        return { ...line(record), name: text(record.name), ...(equivalence === undefined ? {} : { density: equivalence }) };
      }),
    };
  });

  const sharedById = rowMap(sharedIngredients);
  const overridesById = rowMap(ingredientOverrides);
  for (const item of ingredients) requireBackup(!sharedById.has(item.id), "An ingredient ID is both personal and shared.");
  for (const { id } of ingredientOverrides) requireBackup(sharedById.has(id), "An override lacks its shared reference.");
  const available = [
    ...ingredients,
    ...sharedIngredients.flatMap((item) => {
      const change = overridesById.get(item.id);
      if (change?.hidden) return [];
      return [{ ...item, ...(change?.parentId ? { parentId: change.parentId } : {}) }];
    }),
  ];
  validateIngredientParents(available);

  const ingredientIds = new Set(available.map((item) => item.id));
  const categoryIds = rowMap(categories);
  const photoIds = rowMap(photos);
  const usedPhotos = new Set<string>();
  rowMap(recipes);
  rowMap(menu);
  for (const recipe of recipes) {
    requireBackup(recipe.ingredients.every((line) => ingredientIds.has(line.ingredientId)), "A recipe references a missing ingredient.");
    requireBackup(recipe.categoryIds.every((id) => categoryIds.has(id)), "A recipe references a missing category.");
    if (recipe.photoId !== undefined) {
      requireBackup(photoIds.has(recipe.photoId) && !usedPhotos.has(recipe.photoId), "A recipe photo is missing or shared by several recipes.");
      usedPhotos.add(recipe.photoId);
    }
  }
  requireBackup(usedPhotos.size === photos.length, "A photo has no recipe.");
  const shopping = optional(snapshot.shopping, (value) => {
    const row = object(value);
    const manualItems = list(row.manualItems).map((item) => {
      const entry = object(item);
      return {
        id: id(entry.id), name: text(entry.name), ingredientId: optional(entry.ingredientId, id), amount: amount(entry.amount),
      };
    });
    const balances = list(row.balances).map((item) => {
      const entry = object(item);
      return {
        groupId: text(entry.groupId), unit: member(entry.unit, unitIds),
        bought: optional(entry.bought, rational), onHand: optional(entry.onHand, rational),
      };
    });
    return decodeShoppingState({ ...row, manualItems, balances, checked: list(row.checked) });
  });
  // A frozen batch can outlive both its source recipe and the original ingredient records.
  return {
    catalogVersion: positiveInteger(snapshot.catalogVersion),
    sharedIngredients, ingredients, ingredientOverrides, categories, recipes, photos, menu,
    ...(shopping && (shopping.manualItems.length || shopping.balances.length || shopping.checked.length)
      ? { shopping } : {}),
  };
}

/** Checks a complete personal snapshot and returns normalized records with exact rational values. */
export function validateSnapshot(value: unknown): PersonalSnapshot {
  try {
    return parseSnapshot(value);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("invalid", error instanceof Error ? error.message : "Invalid snapshot.");
  }
}
