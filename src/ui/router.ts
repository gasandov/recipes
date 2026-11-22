import { createMemo, createSignal, onSettled } from "solid-js";
import type { Accessor } from "solid-js";

export type Route =
  | { name: "recipes" }
  | { name: "recipe"; id: string }
  | { name: "new" }
  | { name: "edit"; id: string }
  | { name: "menu" }
  | { name: "shopping" }
  | { name: "ingredients" }
  | { name: "categories" }
  | { name: "missing" };

export const paths = {
  recipes: "#/recetas",
  newRecipe: "#/recetas/nueva",
  recipe: (id: string) => `#/recetas/${encodeURIComponent(id)}`,
  editRecipe: (id: string) => `#/recetas/${encodeURIComponent(id)}/editar`,
  menu: "#/menu",
  shopping: "#/compras",
  ingredients: "#/ingredientes",
  categories: "#/categorias",
} as const;

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

export function parseHash(hash: string): Route {
  const segments = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [first, second, third] = segments;

  if (!first || (first === "recetas" && segments.length === 1)) return { name: "recipes" };
  if (first === "menu" && segments.length === 1) return { name: "menu" };
  if (first === "compras" && segments.length === 1) return { name: "shopping" };
  if (first === "ingredientes" && segments.length === 1) return { name: "ingredients" };
  if (first === "categorias" && segments.length === 1) return { name: "categories" };
  if (first === "recetas" && second === "nueva" && segments.length === 2) return { name: "new" };
  if (first === "recetas" && second !== undefined) {
    const id = decode(second);
    if (id === undefined) return { name: "missing" };
    if (segments.length === 2) return { name: "recipe", id };
    if (segments.length === 3 && third === "editar") return { name: "edit", id };
  }
  return { name: "missing" };
}

export function routeKey(route: Route): string {
  return "id" in route ? `${route.name}:${route.id}` : route.name;
}

export function navigate(hash: string): void {
  if (window.location.hash === hash) return;
  window.location.hash = hash;
}

/** Tracks the hash route. Must be called from a component body. */
export function createRouter(): Accessor<Route> {
  const [hash, setHash] = createSignal(window.location.hash);
  onSettled(() => {
    const update = () => setHash(window.location.hash);
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  });
  // Two hashes for the same view keep the same route object so the view is not rebuilt.
  return createMemo<Route>((previous) => {
    const next = parseHash(hash());
    return previous && routeKey(previous) === routeKey(next) ? previous : next;
  });
}
