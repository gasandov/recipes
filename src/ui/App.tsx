import { createEffect, For, Match, Show, Switch } from "solid-js";
import { ConfirmHost } from "./components/ConfirmHost";
import { Notices } from "./components/Notices";
import { createRouter, paths } from "./router";
import type { Route } from "./router";
import { AppContext, createAppState } from "./state";
import { appName } from "./text";
import { useApp } from "./use-app";
import { Categories } from "./views/Categories";
import { Ingredients } from "./views/Ingredients";
import { Menu } from "./views/Menu";
import { RecipeDetail } from "./views/RecipeDetail";
import { RecipeForm } from "./views/RecipeForm";
import { RecipeList } from "./views/RecipeList";
import { ShoppingList } from "./views/ShoppingList";
import "./styles.css";

type NavItem = { label: string; href: string; active: (route: Route) => boolean };

const navItems: NavItem[] = [
  {
    label: "Recetas",
    href: paths.recipes,
    active: (route) => ["recipes", "recipe", "new", "edit"].includes(route.name),
  },
  { label: "Menú", href: paths.menu, active: (route) => route.name === "menu" },
  { label: "Lista de compras", href: paths.shopping, active: (route) => route.name === "shopping" },
];

const catalogItems: NavItem[] = [
  { label: "Ingredientes", href: paths.ingredients, active: (route) => route.name === "ingredients" },
  { label: "Categorías", href: paths.categories, active: (route) => route.name === "categories" },
];

function NavLinks(props: { items: NavItem[]; route: Route }) {
  return (
    <ul>
      <For each={props.items}>
        {(item) => (
          <li>
            <a href={item.href} aria-current={item.active(props.route) ? "page" : undefined}>{item.label}</a>
          </li>
        )}
      </For>
    </ul>
  );
}

function titleFor(route: Route): string {
  switch (route.name) {
    case "recipes":
    case "recipe":
      return "Recetas";
    case "new":
      return "Nueva receta";
    case "edit":
      return "Editar receta";
    case "menu":
      return "Menú";
    case "shopping":
      return "Lista de compras";
    case "ingredients":
      return "Ingredientes";
    case "categories":
      return "Categorías";
    case "missing":
      return "Página no encontrada";
  }
}

export function App() {
  const state = createAppState();
  return (
    <AppContext value={state}>
      <Shell />
    </AppContext>
  );
}

function Shell() {
  const app = useApp();
  const route = createRouter();

  // Announce the new view to assistive technology by moving focus to its heading.
  // The route object only changes when the view does, so this runs once per navigation.
  createEffect(
    route,
    (current) => {
      document.title = `${titleFor(current)} · ${appName}`;
      document.querySelector<HTMLElement>("main h1")?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    },
    { defer: true },
  );

  const isForm = () => route().name === "new" || route().name === "edit";

  return (
    <>
      <a class="skip-link" href="#contenido" onClick={(event) => {
        event.preventDefault();
        document.querySelector<HTMLElement>("main h1")?.focus();
      }}>
        Saltar al contenido
      </a>
      <header class="app-header">
        <a class="brand" href={paths.recipes}>
          {appName}
        </a>
        <nav class={["app-nav main-nav", { "is-hidden-mobile": isForm() }]} aria-label="Principal">
          <NavLinks items={navItems} route={route()} />
        </nav>
        <nav class={["app-nav catalog-nav", { "is-hidden-mobile": isForm() }]} aria-label="Catálogo">
          <NavLinks items={catalogItems} route={route()} />
        </nav>
      </header>
      <main id="contenido" class="app-main">
        <Switch>
          <Match when={app.status() === "loading"}>
            <p role="status" class="loading-note">
              Abriendo tu recetario…
            </p>
          </Match>
          <Match when={app.status() === "error"}>
            <section class="empty-state" role="alert">
              <h1 tabindex="-1">No pudimos abrir tu recetario</h1>
              <p>
                Tus datos se guardan en este navegador. Revisa que el almacenamiento no esté bloqueado, por ejemplo en una ventana
                privada, e inténtalo de nuevo.
              </p>
              <button type="button" class="btn btn-primary" onClick={() => void app.reload()}>
                Reintentar
              </button>
            </section>
          </Match>
          <Match when={app.status() === "ready"}>
            <Show when={route()} keyed>
              {(current) => <View route={current} />}
            </Show>
          </Match>
        </Switch>
      </main>
      <ConfirmHost />
      <Notices />
    </>
  );
}

function View(props: { route: Route }) {
  const app = useApp();
  const current = props.route;
  switch (current.name) {
    case "recipes":
      return <RecipeList />;
    case "recipe":
      return <RecipeDetail id={current.id} />;
    case "new":
      return <RecipeForm recipe={undefined} />;
    case "edit": {
      const recipe = app.snapshot().recipes.find((item) => item.id === current.id);
      return recipe ? (
        <RecipeForm recipe={recipe} />
      ) : (
        <section class="empty-state">
          <h1 tabindex="-1">No encontramos esta receta</h1>
          <a class="btn btn-primary" href={paths.recipes}>
            Volver a Recetas
          </a>
        </section>
      );
    }
    case "ingredients":
      return <Ingredients />;
    case "menu":
      return <Menu />;
    case "shopping":
      return <ShoppingList />;
    case "categories":
      return <Categories />;
    case "missing":
      return (
        <section class="empty-state">
          <h1 tabindex="-1">Página no encontrada</h1>
          <p>Esa dirección no existe en tu recetario.</p>
          <a class="btn btn-primary" href={paths.recipes}>
            Ir a Recetas
          </a>
        </section>
      );
  }
}
