import type { Recipe } from "../contracts";
import { normalizeLookupText } from "../domain/discovery";
import type { ShoppingState } from "../shopping/workflow";
import { sameValue } from "./equality";
import { BackupError } from "./types";
import type { PersonalSnapshot } from "./types";
import { requireBackup, validateSnapshot } from "./validate";

type Collection = Exclude<keyof PersonalSnapshot, "catalogVersion" | "sharedIngredients" | "shopping">;

type ConflictFor<Key extends Collection> = {
  key: string;
  collection: Key;
  local: PersonalSnapshot[Key][number] | undefined;
  incoming: PersonalSnapshot[Key][number] | undefined;
};

type ShoppingConflict = { key: string; collection: "shopping"; local: ShoppingState; incoming: ShoppingState };
export type MergeConflict = { [Key in Collection]: ConflictFor<Key> }[Collection] | ShoppingConflict;
export type MergeChoice = "local" | "incoming";
export type RecipeMatch = { localId: string; incomingId: string };
export type RecipeMatchSuggestion = { local: Recipe; incoming: Recipe[] };

export function suggestRecipeMatches(local: PersonalSnapshot, incoming: PersonalSnapshot): RecipeMatchSuggestion[] {
  const localIds = new Set(local.recipes.map(({ id }) => id));
  const incomingIds = new Set(incoming.recipes.map(({ id }) => id));
  const candidates = new Map<string, Recipe[]>();
  for (const recipe of incoming.recipes) {
    if (localIds.has(recipe.id)) continue;
    const key = normalizeLookupText(recipe.name);
    const named = candidates.get(key) ?? [];
    named.push(recipe);
    candidates.set(key, named);
  }
  return local.recipes.flatMap((recipe) => {
    const matching = candidates.get(normalizeLookupText(recipe.name));
    return matching?.length && !incomingIds.has(recipe.id) ? [{ local: recipe, incoming: matching }] : [];
  });
}

function referencedIngredients(snapshot: PersonalSnapshot): Set<string> {
  return new Set([
    ...snapshot.recipes.flatMap((recipe) => recipe.ingredients.map((line) => line.ingredientId)),
    ...[...snapshot.ingredients, ...snapshot.ingredientOverrides].flatMap((entry) => entry.parentId ? [entry.parentId] : []),
  ]);
}

/** Builds a reusable stable-ID merge. Explicit same-name pairs are opt-in. */
export function planMerge(
  local: PersonalSnapshot,
  incoming: PersonalSnapshot,
  matches: readonly RecipeMatch[] = [],
): { conflicts: MergeConflict[]; resolve: (choices: ReadonlyMap<string, MergeChoice>) => PersonalSnapshot } {
  const conflicts: MergeConflict[] = [];
  const localRefs = referencedIngredients(local);
  const incomingRefs = referencedIngredients(incoming);
  const localMatches = new Map<string, Recipe>();
  const incomingMatches = new Set<string>();
  if (matches.length) {
    const candidates = new Map(suggestRecipeMatches(local, incoming).map((pair) => [pair.local.id, pair.incoming]));
    for (const { localId, incomingId } of matches) {
      const match = candidates.get(localId)?.find(({ id }) => id === incomingId);
      requireBackup(match && !localMatches.has(localId) && !incomingMatches.has(incomingId),
        "Invalid or repeated recipe match.");
      localMatches.set(localId, match);
      incomingMatches.add(incomingId);
    }
  }

  function collection<Key extends Collection>(key: Key) {
    type Row = PersonalSnapshot[Key][number];
    const left = local[key] as Row[];
    const right = incoming[key] as Row[];
    const rightById = new Map(right.map((row) => [row.id, row]));
    const leftIds = new Set(left.map((row) => row.id));
    const potential = left.flatMap<ConflictFor<Key>>((row) => {
      const match = key === "recipes" ? localMatches.get(row.id) as Row | undefined : undefined;
      const duplicate = match ?? rightById.get(row.id);
      const hidden = key === "ingredientOverrides" && "hidden" in row && row.hidden && incomingRefs.has(row.id);
      return (duplicate && (match || !sameValue(row, duplicate))) || (!duplicate && hidden)
        ? [{ key: JSON.stringify([key, row.id]), collection: key, local: row, incoming: duplicate }]
        : [];
    });

    if (key === "ingredientOverrides") {
      for (const row of right) {
        if (!leftIds.has(row.id) && "hidden" in row && row.hidden && localRefs.has(row.id)) {
          potential.push({ key: JSON.stringify([key, row.id]), collection: key, local: undefined, incoming: row });
        }
      }
    }

    conflicts.push(...potential as MergeConflict[]);
    const changed = new Map(potential.flatMap((conflict) => {
      const row = conflict.local ?? conflict.incoming;
      return row ? [[row.id, conflict] as const] : [];
    }));
    return (choices: ReadonlyMap<string, MergeChoice>): Row[] => {
      const selected: Row[] = [];
      for (const row of left) {
        const conflict = changed.get(row.id);
        const winner = conflict && choices.get(conflict.key) === "incoming" ? conflict.incoming : row;
        if (winner) selected.push(winner);
      }
      for (const row of right) {
        if (leftIds.has(row.id) || (key === "recipes" && incomingMatches.has(row.id))) continue;
        const conflict = changed.get(row.id);
        if (!conflict || choices.get(conflict.key) === "incoming") selected.push(row);
      }
      return selected;
    };
  }

  const ingredients = collection("ingredients");
  const ingredientOverrides = collection("ingredientOverrides");
  const categories = collection("categories");
  const recipes = collection("recipes");
  const photos = collection("photos");
  const menu = collection("menu");
  const shoppingKey = JSON.stringify(["shopping", "active"]);
  if (local.shopping && incoming.shopping && !sameValue(local.shopping, incoming.shopping)) {
    conflicts.push({ key: shoppingKey, collection: "shopping", local: local.shopping, incoming: incoming.shopping });
  }
  const shared = new Map(incoming.sharedIngredients.map((item) => [item.id, item]));
  for (const item of local.sharedIngredients) shared.set(item.id, item);

  return {
    conflicts,
    resolve(choices) {
      if (conflicts.some(({ key }) => !["local", "incoming"].includes(choices.get(key) ?? ""))) {
        throw new BackupError("conflicts", "Every changed duplicate needs a decision.");
      }
      const selectedRecipes = recipes(choices);
      const selectedIds = new Set(selectedRecipes.map(({ id }) => id));
      const photoIds = new Set(selectedRecipes.flatMap((recipe) => recipe.photoId ? [recipe.photoId] : []));
      const aliases = new Map<string, string>();
      for (const [id, incomingRecipe] of localMatches) {
        if (selectedIds.has(id)) aliases.set(incomingRecipe.id, id);
        else aliases.set(id, incomingRecipe.id);
      }
      return validateSnapshot({
        catalogVersion: Math.max(local.catalogVersion, incoming.catalogVersion),
        sharedIngredients: [...shared.values()],
        ingredients: ingredients(choices),
        ingredientOverrides: ingredientOverrides(choices),
        categories: categories(choices),
        recipes: selectedRecipes,
        photos: photos(choices).filter(({ id }) => photoIds.has(id)),
        shopping: choices.get(shoppingKey) === "incoming" ? incoming.shopping : local.shopping ?? incoming.shopping,
        menu: menu(choices).map((entry) => {
          const sourceRecipeId = aliases.get(entry.sourceRecipeId);
          return sourceRecipeId ? { ...entry, sourceRecipeId } : entry;
        }),
      });
    },
  };
}
