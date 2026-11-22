import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import type { Recipe, RecipeFilters, TagId } from "../../contracts";
import { filterRecipes } from "../../domain";
import { IngredientCombobox } from "../components/IngredientCombobox";
import { PhotoImage } from "../components/PhotoImage";
import { emptyFilters } from "../state";
import { paths } from "../router";
import { categoryKindLabels, compareNames, ingredientCount, orderedTags, recipeCount, tagLabels } from "../text";
import { useApp } from "../use-app";

type ActiveFilter = { key: string; label: string; remove: () => void };

function toggle<T>(list: T[], value: T, selected: boolean): T[] {
  const without = list.filter((item) => item !== value);
  return selected ? [...without, value] : without;
}

export function RecipeList() {
  const app = useApp();
  const ids = createUniqueId();
  const [panelOpen, setPanelOpen] = createSignal(false);
  const [ingredientText, setIngredientText] = createSignal("");

  const update = (patch: Partial<RecipeFilters>) => app.setFilters({ ...app.filters(), ...patch });

  // Drop filter IDs whose category or ingredient was deleted, so they cannot hide every recipe unseen.
  const effective = createMemo<RecipeFilters>(() => {
    const filters = app.filters();
    const categories = app.categoriesById();
    const ingredients = app.ingredientsById();
    return {
      query: filters.query,
      dishTypeIds: filters.dishTypeIds.filter((id) => categories.has(id)),
      cuisineIds: filters.cuisineIds.filter((id) => categories.has(id)),
      tagIds: filters.tagIds,
      ingredientIds: filters.ingredientIds.filter((id) => ingredients.has(id)),
    };
  });

  const results = createMemo(() =>
    filterRecipes(app.library(), effective()).sort((a, b) => compareNames(a.name, b.name)),
  );
  const dishTypes = createMemo(() =>
    app.library().categories.filter((category) => category.kind === "dish_type").sort((a, b) => compareNames(a.name, b.name)),
  );
  const cuisines = createMemo(() =>
    app.library().categories.filter((category) => category.kind === "cuisine").sort((a, b) => compareNames(a.name, b.name)),
  );

  const activeFilters = createMemo<ActiveFilter[]>(() => {
    const filters = effective();
    const list: ActiveFilter[] = [];
    for (const id of filters.dishTypeIds) {
      const name = app.categoriesById().get(id)?.name;
      if (name) list.push({ key: `d-${id}`, label: name, remove: () => update({ dishTypeIds: toggle(app.filters().dishTypeIds, id, false) }) });
    }
    for (const id of filters.cuisineIds) {
      const name = app.categoriesById().get(id)?.name;
      if (name) list.push({ key: `c-${id}`, label: name, remove: () => update({ cuisineIds: toggle(app.filters().cuisineIds, id, false) }) });
    }
    for (const tag of filters.tagIds) {
      list.push({ key: `t-${tag}`, label: tagLabels[tag], remove: () => update({ tagIds: toggle(app.filters().tagIds, tag, false) }) });
    }
    for (const id of filters.ingredientIds) {
      const name = app.ingredientsById().get(id)?.name;
      if (name) list.push({ key: `i-${id}`, label: name, remove: () => update({ ingredientIds: toggle(app.filters().ingredientIds, id, false) }) });
    }
    return list;
  });
  const hasFilters = () => activeFilters().length > 0 || effective().query.trim() !== "";

  return (
    <>
      <div class="page-head">
        <h1 tabindex="-1">Recetas</h1>
        <a class="btn btn-primary" href={paths.newRecipe}>
          Nueva receta
        </a>
      </div>

      <Show
        when={app.library().recipes.length > 0}
        fallback={
          <section class="empty-state">
            <h2>Aún no tienes recetas</h2>
            <p>Guarda la primera receta para armar tu recetario. Solo el nombre es obligatorio.</p>
            <a class="btn btn-primary" href={paths.newRecipe}>
              Crear mi primera receta
            </a>
          </section>
        }
      >
        <div class="toolbar" role="search">
          <div class="field">
            <label for={`${ids}-query`}>Buscar por nombre</label>
            <input
              id={`${ids}-query`}
              class="control"
              type="search"
              autocomplete="off"
              value={app.filters().query}
              onInput={(event) => update({ query: event.currentTarget.value })}
            />
          </div>
          <button
            type="button"
            class="btn"
            aria-expanded={panelOpen() ? "true" : "false"}
            aria-controls={`${ids}-filters`}
            onClick={() => setPanelOpen(!panelOpen())}
          >
            Filtros{activeFilters().length > 0 ? ` (${activeFilters().length})` : ""}
          </button>
        </div>

        <div id={`${ids}-filters`} class="filter-panel" hidden={!panelOpen()}>
          <fieldset class="check-group">
            <legend>{categoryKindLabels.dish_type}</legend>
            <Show when={dishTypes().length > 0} fallback={<p class="hint">Sin tipos de platillo.</p>}>
              <For each={dishTypes()}>
                {(category) => (
                  <label class="check">
                    <input
                      type="checkbox"
                      checked={app.filters().dishTypeIds.includes(category.id)}
                      onChange={(event) =>
                        update({ dishTypeIds: toggle(app.filters().dishTypeIds, category.id, event.currentTarget.checked) })
                      }
                    />
                    <span>{category.name}</span>
                  </label>
                )}
              </For>
            </Show>
          </fieldset>
          <fieldset class="check-group">
            <legend>{categoryKindLabels.cuisine}</legend>
            <Show when={cuisines().length > 0} fallback={<p class="hint">Sin cocinas.</p>}>
              <For each={cuisines()}>
                {(category) => (
                  <label class="check">
                    <input
                      type="checkbox"
                      checked={app.filters().cuisineIds.includes(category.id)}
                      onChange={(event) =>
                        update({ cuisineIds: toggle(app.filters().cuisineIds, category.id, event.currentTarget.checked) })
                      }
                    />
                    <span>{category.name}</span>
                  </label>
                )}
              </For>
            </Show>
          </fieldset>
          <fieldset class="check-group">
            <legend>Etiquetas</legend>
            <For each={orderedTags}>
              {(tag: TagId) => (
                <label class="check">
                  <input
                    type="checkbox"
                    checked={app.filters().tagIds.includes(tag)}
                    onChange={(event) => update({ tagIds: toggle(app.filters().tagIds, tag, event.currentTarget.checked) })}
                  />
                  <span>{tagLabels[tag]}</span>
                </label>
              )}
            </For>
          </fieldset>
          <div class="field">
            <label for={`${ids}-ingredient`}>Ingrediente</label>
            <IngredientCombobox
              id={`${ids}-ingredient`}
              value={ingredientText()}
              ingredients={app.library().ingredients}
              canCreate={false}
              clearOnSelect
              placeholder="Escribe para buscar, por ejemplo pollo"
              describedBy={`${ids}-ingredient-hint`}
              onInput={setIngredientText}
              onPick={(ingredient) => {
                update({ ingredientIds: toggle(app.filters().ingredientIds, ingredient.id, true) });
                setIngredientText("");
              }}
              onCreate={async () => {}}
            />
            <p class="hint" id={`${ids}-ingredient-hint`}>
              Un ingrediente general, como pollo, también encuentra recetas con sus cortes.
            </p>
          </div>
        </div>

        <Show when={activeFilters().length > 0}>
          <ul class="chip-row" aria-label="Filtros activos">
            <For each={activeFilters()}>
              {(filter) => (
                <li>
                  <button
                    type="button"
                    class="chip chip-removable"
                    aria-label={`Quitar el filtro ${filter.label}`}
                    onClick={filter.remove}
                  >
                    {filter.label} <span aria-hidden="true">×</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <div class="results-bar">
          <p role="status" class="results-count">
            {recipeCount(results().length)}
          </p>
          <Show when={hasFilters()}>
            <button
              type="button"
              class="btn btn-quiet btn-small"
              onClick={() => {
                app.setFilters(emptyFilters);
                setIngredientText("");
              }}
            >
              Limpiar búsqueda y filtros
            </button>
          </Show>
        </div>

        <Show
          when={results().length > 0}
          fallback={
            <section class="empty-state">
              <h2>Ninguna receta coincide</h2>
              <p>Prueba con otro nombre o quita algún filtro.</p>
            </section>
          }
        >
          <ul class="card-grid">
            <For each={results()}>{(recipe) => <RecipeCard recipe={recipe} />}</For>
          </ul>
        </Show>
      </Show>
      <p class="hint">Tus recetas se guardan en este dispositivo. Si borras los datos del sitio en tu navegador, puedes perderlas.</p>
    </>
  );
}

function RecipeCard(props: { recipe: Recipe }) {
  const app = useApp();
  const categories = () =>
    props.recipe.categoryIds
      .map((id) => app.categoriesById().get(id)?.name)
      .filter((name): name is string => name !== undefined)
      .join(" · ");

  return (
    <li class="card">
      <a class="card-link" href={paths.recipe(props.recipe.id)}>
        <div class="card-photo">
          <PhotoImage
            photoId={props.recipe.photoId}
            alt=""
            fallback={<span class="card-initial" aria-hidden="true">{props.recipe.name.trim().charAt(0).toLocaleUpperCase("es-MX")}</span>}
          />
        </div>
        <div class="card-body">
          <h2 class="card-title">{props.recipe.name}</h2>
          <Show when={categories()}>
            <p class="card-meta">{categories()}</p>
          </Show>
          <Show when={props.recipe.tags.length > 0}>
            <p class="card-tags">{props.recipe.tags.map((tag) => tagLabels[tag]).join(" · ")}</p>
          </Show>
          <p class="card-meta">
            {props.recipe.ingredients.length > 0 ? ingredientCount(props.recipe.ingredients.length) : "Sin ingredientes"}
          </p>
        </div>
      </a>
    </li>
  );
}
