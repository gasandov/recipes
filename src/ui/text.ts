import { ingredientClassifications, tagIds, unitIds } from "../contracts";
import type { Category, IngredientClassification, Rational, TagId, UnitId } from "../contracts";
import { compareRational } from "../domain";

export const appName = "Recetario";

export const tagLabels: Readonly<Record<TagId, string>> = {
  vegan: "Vegana",
  vegetarian: "Vegetariana",
  meat: "Contiene carne",
  fish: "Contiene pescado",
  shellfish: "Mariscos",
};

export const classificationLabels: Readonly<Record<IngredientClassification, string>> = {
  plant: "Origen vegetal",
  dairy: "Lácteo",
  egg: "Huevo",
  meat: "Carne",
  fish: "Pescado",
  shellfish: "Marisco",
  otherAnimal: "Otro origen animal",
};

export const categoryKindLabels: Readonly<Record<Category["kind"], string>> = {
  dish_type: "Tipo de platillo",
  cuisine: "Cocina",
};

export const orderedTags: readonly TagId[] = tagIds;
export const orderedClassifications: readonly IngredientClassification[] = ingredientClassifications;
export const orderedUnits: readonly UnitId[] = unitIds;

/** Compares user-visible names using Mexican Spanish collation. */
export function compareNames(left: string, right: string): number {
  return left.localeCompare(right, "es-MX", { sensitivity: "base" });
}

export function recipeCount(count: number): string {
  return count === 1 ? "1 receta" : `${count} recetas`;
}

export function ingredientCount(count: number): string {
  return count === 1 ? "1 ingrediente" : `${count} ingredientes`;
}

/** Shows a rational as a decimal for density display, such as `0.82`. */
export function approximateDecimal(value: Rational): string {
  const numerator = Number(value.numerator);
  const denominator = Number(value.denominator);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return "";
  return String(Number((numerator / denominator).toFixed(3)));
}

const dimensions: Readonly<Record<UnitId, "mass" | "volume" | "other">> = {
  gram: "mass",
  kilogram: "mass",
  ounce: "mass",
  milliliter: "volume",
  liter: "volume",
  cup: "volume",
  tablespoon: "volume",
  teaspoon: "volume",
  fluidOunceUs: "volume",
  piece: "other",
  pinch: "other",
  bunch: "other",
};

export function unitDimension(unit: UnitId): "mass" | "volume" | "other" {
  return dimensions[unit];
}

type UnitText = { singular: string; plural: string; option: string };

const unitText: Readonly<Record<UnitId, UnitText>> = {
  gram: { singular: "g", plural: "g", option: "g (gramos)" },
  kilogram: { singular: "kg", plural: "kg", option: "kg (kilogramos)" },
  milliliter: { singular: "ml", plural: "ml", option: "ml (mililitros)" },
  liter: { singular: "L", plural: "L", option: "L (litros)" },
  cup: { singular: "taza", plural: "tazas", option: "taza" },
  tablespoon: { singular: "cda", plural: "cda", option: "cda (cucharada)" },
  teaspoon: { singular: "cdta", plural: "cdta", option: "cdta (cucharadita)" },
  ounce: { singular: "oz", plural: "oz", option: "oz (onza, peso)" },
  fluidOunceUs: {
    singular: "fl oz EE. UU.",
    plural: "fl oz EE. UU.",
    option: "fl oz EE. UU. (onza líquida, volumen)",
  },
  piece: { singular: "pieza", plural: "piezas", option: "pieza" },
  pinch: { singular: "pizca", plural: "pizcas", option: "pizca" },
  bunch: { singular: "manojo", plural: "manojos", option: "manojo" },
};

const one: Rational = { numerator: "1", denominator: "1" };

/** Returns the unit as written next to a quantity, using the singular up to one. */
export function unitLabel(unit: UnitId, largest: Rational): string {
  return compareRational(largest, one) <= 0 ? unitText[unit].singular : unitText[unit].plural;
}

/** Returns the long unit name used in selection lists. */
export function unitOptionLabel(unit: UnitId): string {
  return unitText[unit].option;
}
