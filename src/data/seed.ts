import type { Category } from "../contracts";

export const initialCategories: Category[] = [
  { id: "dish-breakfast", name: "Desayunos", kind: "dish_type" },
  { id: "dish-dessert", name: "Postres", kind: "dish_type" },
  { id: "dish-sauce", name: "Salsas", kind: "dish_type" },
  { id: "dish-main", name: "Platillos fuertes", kind: "dish_type" },
  { id: "dish-side", name: "Acompañamientos", kind: "dish_type" },
  { id: "cuisine-mexican", name: "Mexicana", kind: "cuisine" },
  { id: "cuisine-chinese", name: "China", kind: "cuisine" },
];
