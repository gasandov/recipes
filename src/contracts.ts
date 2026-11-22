export const RECIPE_PORTIONS = 4;

export const unitIds = [
  "gram", "kilogram", "milliliter", "liter", "cup", "tablespoon", "teaspoon",
  "ounce", "fluidOunceUs", "piece", "pinch", "bunch",
] as const;
export type UnitId = (typeof unitIds)[number];

export type Rational = {
  numerator: string;
  denominator: string;
};

export type MeasuredAmount = {
  kind: "measured";
  unit: UnitId;
  min: Rational;
  max?: Rational;
};

export type Amount =
  | MeasuredAmount
  | { kind: "qualitative"; text: string }
  | { kind: "unspecified" };

export type RecipeIngredient = {
  ingredientId: string;
  amount: Amount;
};

export const tagIds = ["vegan", "vegetarian", "meat", "fish", "shellfish"] as const;
export type TagId = (typeof tagIds)[number];

export const ingredientClassifications = [
  "plant", "dairy", "egg", "meat", "fish", "shellfish", "otherAnimal",
] as const;
export type IngredientClassification = (typeof ingredientClassifications)[number];

export type Density = {
  gramsPerMilliliter: Rational;
  source: string;
};

export type Ingredient = {
  id: string;
  name: string;
  parentId?: string;
  classification?: IngredientClassification;
  density?: Density;
};

export type Category = {
  id: string;
  name: string;
  kind: "dish_type" | "cuisine";
};

export type Recipe = {
  id: string;
  name: string;
  photoId?: string;
  sourceUrl?: string;
  ingredients: RecipeIngredient[];
  steps: string[];
  categoryIds: string[];
  tags: TagId[];
};

export type RecipeDraft = Omit<Recipe, "id" | "photoId"> & {
  id?: string;
  enteredPortions: number;
};

export type PhotoInput = {
  blob: Blob;
  width: number;
  height: number;
};

export type Photo = PhotoInput & { id: string };

export type MenuEntry = {
  id: string;
  sourceRecipeId: string;
  name: string;
  portions: number;
  ingredients: (RecipeIngredient & { name: string; density?: Density })[];
};

export type RecipeFilters = {
  query: string;
  dishTypeIds: string[];
  cuisineIds: string[];
  tagIds: TagId[];
  ingredientIds: string[];
};

export type Library = {
  recipes: Recipe[];
  categories: Category[];
  ingredients: Ingredient[];
};

export interface RecipeRepository {
  getLibrary(): Promise<Library>;
  getPhoto(id: string): Promise<Photo | undefined>;
  // Omit the photo to keep it, or pass null to remove it.
  saveRecipe(draft: RecipeDraft, photo?: PhotoInput | null): Promise<Recipe>;
  deleteRecipe(id: string): Promise<void>;
  saveCategory(draft: Omit<Category, "id"> & { id?: string }): Promise<Category>;
  deleteCategory(id: string): Promise<void>;
  saveIngredient(draft: Omit<Ingredient, "id"> & { id?: string }): Promise<Ingredient>;
  deleteIngredient(id: string): Promise<void>;
  getActiveMenu(): Promise<MenuEntry[]>;
  saveActiveMenu(entries: MenuEntry[]): Promise<void>;
}
