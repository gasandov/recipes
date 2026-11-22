import type {
  Ingredient, IngredientClassification, Library, Recipe, RecipeFilters, RecipeIngredient, TagId,
} from "../contracts";

export function normalizeLookupText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("es-MX").trim().replace(/\s+/gu, " ");
}

export function filterRecipes(library: Library, filters: RecipeFilters): Recipe[] {
  const query = normalizeLookupText(filters.query);
  const categories = new Map(library.categories.map((category) => [category.id, category.kind]));
  const parents = new Map(library.ingredients.map((ingredient) => [ingredient.id, ingredient.parentId]));
  const selectedDishTypes = new Set(filters.dishTypeIds.filter((id) => categories.get(id) === "dish_type"));
  const selectedCuisines = new Set(filters.cuisineIds.filter((id) => categories.get(id) === "cuisine"));
  const selectedIngredients = new Set(filters.ingredientIds.filter((id) => parents.has(id)));

  function matchesIngredient(id: string): boolean {
    const visited = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined && !visited.has(current)) {
      if (selectedIngredients.has(current)) return true;
      visited.add(current);
      current = parents.get(current);
    }
    return false;
  }

  function matchesCategories(recipe: Recipe, selected: Set<string>): boolean {
    return selected.size === 0 || recipe.categoryIds.some((id) => selected.has(id));
  }

  return library.recipes.filter((recipe) =>
    normalizeLookupText(recipe.name).includes(query)
    && matchesCategories(recipe, selectedDishTypes)
    && matchesCategories(recipe, selectedCuisines)
    && (filters.tagIds.length === 0 || recipe.tags.some((id) => filters.tagIds.includes(id)))
    && (selectedIngredients.size === 0 || recipe.ingredients.some((line) => matchesIngredient(line.ingredientId))),
  );
}

const vegetarianClassifications = new Set<IngredientClassification>(["plant", "dairy", "egg"]);

export function suggestTags(lines: RecipeIngredient[], ingredients: Ingredient[]): TagId[] {
  const catalog = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient.classification]));
  const classifications = lines.map((line) => catalog.get(line.ingredientId));
  const suggestions: TagId[] = [];

  if (classifications.length > 0 && classifications.every((type) => type === "plant")) {
    suggestions.push("vegan");
  }
  if (classifications.length > 0 && classifications.every((type) => type && vegetarianClassifications.has(type))) {
    suggestions.push("vegetarian");
  }
  if (classifications.includes("meat")) suggestions.push("meat");
  if (classifications.includes("fish")) suggestions.push("fish");
  if (classifications.includes("shellfish")) suggestions.push("shellfish");

  return suggestions;
}
