import type { Category, Ingredient, MenuEntry, Recipe } from "../contracts";
import type { IngredientOverride } from "../data/catalog";
import type { StoredPhoto } from "../data/database";
import type { ShoppingState } from "../shopping/workflow";

export type CatalogReference = { id: string; name: string };

export type { IngredientOverride } from "../data/catalog";

/** Portable personal data. Missing shopping data also represents the original ZIP format. */
export type PersonalSnapshot = {
  catalogVersion: number;
  sharedIngredients: CatalogReference[];
  ingredients: Ingredient[];
  ingredientOverrides: IngredientOverride[];
  categories: Category[];
  recipes: Recipe[];
  photos: StoredPhoto[];
  menu: MenuEntry[];
  shopping?: ShoppingState;
};

export class BackupError extends Error {
  constructor(readonly code: "invalid" | "limit" | "version" | "conflicts" | "stale", message: string) {
    super(message);
    this.name = "BackupError";
  }
}

export const backupLimits = {
  archiveBytes: 128 * 1024 * 1024,
  expandedBytes: 128 * 1024 * 1024,
  manifestBytes: 8 * 1024 * 1024,
  photoBytes: 10 * 1024 * 1024,
  photoDimension: 4096,
  photos: 2000,
  records: 20_000,
  rationalDigits: 128,
} as const;
