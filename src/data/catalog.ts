import type { Density, Ingredient, IngredientClassification } from "../contracts";
import { divideRational, parseRational } from "../domain/rational";

const usCupMl = parseRational("236.5882365");
const bakingChart = "https://www.kingarthurbaking.com/learn/ingredient-weight-chart";
const flourMethod = "https://www.kingarthurbaking.com/blog/2023/10/13/how-to-measure-flour";
const usdaHandbook = "https://www.ars.usda.gov/ARSUserFiles/80400525/Data/hg72/hg72_2002.pdf";

function densityFromUsCup(grams: string, source: string): Density {
  return { gramsPerMilliliter: divideRational(parseRational(grams), usCupMl), source };
}

const ingredients: Ingredient[] = [
  {
    id: "flour",
    name: "Harina de trigo",
    classification: "plant",
    density: densityFromUsCup(
      "120", `King Arthur Baking · Harina de trigo de uso general, aireada y nivelada · 120 g por taza de EE. UU. · ${bakingChart} · ${flourMethod}`,
    ),
  },
  {
    id: "sugar",
    name: "Azúcar blanca granulada",
    classification: "plant",
    density: densityFromUsCup("198", `King Arthur Baking · 198 g por taza de EE. UU. · ${bakingChart}`),
  },
  {
    id: "canola-oil",
    name: "Aceite de canola",
    classification: "plant",
    density: densityFromUsCup("218", `USDA · Tabla 9, alimento 171 · 218 g por taza de EE. UU. · ${usdaHandbook}`),
  },
  { id: "chicken", name: "Pollo", classification: "meat" },
  { id: "chicken-breast", name: "Pechuga de pollo", parentId: "chicken", classification: "meat" },
  { id: "chicken-cutlet", name: "Milanesa de pollo", parentId: "chicken-breast", classification: "meat" },
  { id: "egg", name: "Huevo", classification: "egg" },
  { id: "milk", name: "Leche", classification: "dairy" },
  { id: "shrimp", name: "Camarón", classification: "shellfish" },
  { id: "fish", name: "Pescado", classification: "fish" },
  { id: "chile", name: "Chile", classification: "plant" },
  { id: "tomato", name: "Jitomate", classification: "plant" },
  { id: "onion", name: "Cebolla", classification: "plant" },
  { id: "garlic", name: "Ajo", classification: "plant" },
];

export type SharedIngredientCatalog = {
  version: number;
  ingredients: readonly Ingredient[];
};

/** The published asset is bundled with the offline PWA. Existing IDs are never reassigned. */
export const sharedIngredientCatalog: SharedIngredientCatalog = { version: 1, ingredients };

/** Omitted fields inherit from the published catalog. Null removes an optional field. */
export type IngredientOverride = {
  id: string;
  hidden?: true;
  name?: string;
  parentId?: string | null;
  classification?: IngredientClassification | null;
  density?: Density | null;
};
