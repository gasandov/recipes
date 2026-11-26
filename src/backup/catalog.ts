import type { Ingredient } from "../contracts";
import type { SharedIngredientCatalog } from "../data/catalog";
import { sameValue } from "./equality";
import type { CatalogReference, IngredientOverride, PersonalSnapshot } from "./types";
import { requireBackup, validateIngredientParents } from "./validate";

function shouldKeepOverride(current: unknown, base: unknown, cached: unknown): boolean {
  return !sameValue(current, base) || (cached !== undefined && sameValue(current, cached ?? undefined));
}

export function splitIngredients(
  catalog: SharedIngredientCatalog,
  cachedBases: Ingredient[],
  cachedOverrides: IngredientOverride[],
  ingredients: Ingredient[],
  recipes: PersonalSnapshot["recipes"],
  menu: PersonalSnapshot["menu"],
): Pick<PersonalSnapshot, "sharedIngredients" | "ingredients" | "ingredientOverrides"> {
  const bases = new Map([...catalog.ingredients, ...cachedBases].map((entry) => [entry.id, entry]));
  const previousOverrides = new Map(cachedOverrides.map((entry) => [entry.id, entry]));
  const current = new Map(ingredients.map((entry) => [entry.id, entry]));
  const records = ingredients.filter(({ id }) => !bases.has(id));
  const ingredientOverrides: IngredientOverride[] = [];
  const refs = new Set<string>();

  for (const [id, base] of bases) {
    const entry = current.get(id);
    if (!entry) {
      ingredientOverrides.push({ id, hidden: true });
      refs.add(id);
      continue;
    }
    const override: IngredientOverride = { id };
    const cached = previousOverrides.get(id);
    if (entry.name !== base.name || cached?.name === entry.name) override.name = entry.name;
    if (shouldKeepOverride(entry.parentId, base.parentId, cached?.parentId)) override.parentId = entry.parentId ?? null;
    if (shouldKeepOverride(entry.classification, base.classification, cached?.classification)) {
      override.classification = entry.classification ?? null;
    }
    if (shouldKeepOverride(entry.density, base.density, cached?.density)) override.density = entry.density ?? null;
    if (Object.keys(override).length > 1) {
      ingredientOverrides.push(override);
      refs.add(id);
    }
  }

  for (const recipe of recipes) for (const line of recipe.ingredients) refs.add(line.ingredientId);
  for (const batch of menu) for (const line of batch.ingredients) refs.add(line.ingredientId);
  for (const { parentId } of [...records, ...ingredientOverrides]) {
    if (parentId) refs.add(parentId);
  }

  const sharedIngredients: CatalogReference[] = [];
  for (const id of refs) {
    const base = bases.get(id);
    if (base) sharedIngredients.push({ id, name: base.name });
  }
  return { sharedIngredients, ingredients: records, ingredientOverrides };
}

export function materializeIngredients(
  snapshot: PersonalSnapshot,
  catalog: SharedIngredientCatalog,
): { ingredients: Ingredient[]; bases: Ingredient[] } {
  const bases = new Map(catalog.ingredients.map((entry) => [entry.id, entry]));
  for (const reference of snapshot.sharedIngredients) {
    bases.set(reference.id, { ...bases.get(reference.id), ...reference });
  }
  requireBackup(snapshot.ingredients.every(({ id }) => !bases.has(id)), "A personal ingredient uses a published catalog ID.");

  const overrides = new Map(snapshot.ingredientOverrides.map((entry) => [entry.id, entry]));
  const visible = new Set([...bases.keys(), ...snapshot.ingredients.map(({ id }) => id)]);
  for (const change of overrides.values()) if (change.hidden) visible.delete(change.id);

  const ingredients = [...snapshot.ingredients];
  for (const [id, base] of bases) {
    if (!visible.has(id)) continue;
    const change = overrides.get(id);
    const parentId = change?.parentId === undefined
      ? base.parentId && visible.has(base.parentId) ? base.parentId : undefined
      : change.parentId;
    const classification = change?.classification === undefined ? base.classification : change.classification;
    const density = change?.density === undefined ? base.density : change.density;
    ingredients.push({
      id, name: change?.name ?? base.name,
      ...(parentId ? { parentId } : {}),
      ...(classification ? { classification } : {}),
      ...(density ? { density } : {}),
    });
    // A published parent might be missing from this installation or hidden by the user.
    // Cache the effective inherited parent so removing it here does not become a new override.
    if (change?.parentId === undefined && base.parentId && !parentId) {
      const { parentId: _missing, ...withoutParent } = base;
      bases.set(id, withoutParent);
    }
  }
  validateIngredientParents(ingredients);
  return { ingredients, bases: [...bases.values()] };
}
