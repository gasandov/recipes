import { ActionIcon } from "../components/ActionIcon";
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { RECIPE_PORTIONS } from "../../contracts";
import type {
  MeasuredAmount,
  Recipe,
  RecipeIngredient,
  UnitId,
} from "../../contracts";
import {
  convertMeasuredAmount,
  defaultMetricUnit,
  formatMeasuredAmount,
  normalizeSourceUrl,
  usesDensity,
} from "../../domain";
import { AddToMenuButton } from "../components/AddToMenuButton";
import { PhotoImage } from "../components/PhotoImage";
import { navigate, paths } from "../router";
import {
  approximateDecimal,
  tagLabels,
  orderedUnits,
  unitLabel,
  unitOptionLabel,
} from "../text";
import { useApp } from "../use-app";

export function RecipeDetail(props: { id: string }) {
  const app = useApp();
  const [leaving, setLeaving] = createSignal(false);
  const recipe = createMemo(() =>
    app.library().recipes.find((item) => item.id === props.id),
  );

  async function remove(target: Recipe) {
    const accepted = await app.confirm({
      title: "¿Eliminar esta receta?",
      message: `Se eliminará «${target.name}» junto con su foto. Esta acción no se puede deshacer.`,
      confirmLabel: "Eliminar receta",
      danger: true,
    });
    if (!accepted) return;
    if (await app.deleteRecipe(target.id)) {
      setLeaving(true);
      app.notify("success", "Receta eliminada.");
      navigate(paths.recipes);
    } else {
      app.notify("error", "No se pudo eliminar la receta. Inténtalo de nuevo.");
    }
  }

  return (
    <Show
      when={recipe()}
      keyed
      fallback={
        <Show when={!leaving()}>
          <section class="empty-state">
            <h1 tabindex="-1">No encontramos esta receta</h1>
            <p>Puede que ya se haya eliminado.</p>
            <a
              class="btn btn-primary"
              href={paths.recipes}
              title="Volver a Recetas"
            >
              <ActionIcon name="recipes" />
              <span class="sr-only">Volver a Recetas</span>
            </a>
          </section>
        </Show>
      }
    >
      {(current) => (
        <RecipeView recipe={current} onDelete={() => void remove(current)} />
      )}
    </Show>
  );
}

function RecipeView(props: { recipe: Recipe; onDelete: () => void }) {
  const app = useApp();
  const categories = () =>
    props.recipe.categoryIds
      .map((id) => app.categoriesById().get(id))
      .filter((category) => category !== undefined);
  const source = createMemo(() => {
    try {
      const href = normalizeSourceUrl(props.recipe.sourceUrl ?? "");
      return href ? { href, host: new URL(href).hostname } : undefined;
    } catch {
      return undefined;
    }
  });

  return (
    <article class="detail">
      <p class="breadcrumb">
        <a href={paths.recipes}>← Recetas</a>
      </p>
      <header class="detail-head">
        <h1 tabindex="-1">{props.recipe.name}</h1>
        <div class="actions">
          <AddToMenuButton
            recipeId={props.recipe.id}
            recipeName={props.recipe.name}
            primary
          />
          <a
            class="btn"
            href={paths.editRecipe(props.recipe.id)}
            title="Editar"
          >
            <ActionIcon name="edit" />
            <span class="sr-only">Editar</span>
          </a>
          <button
            type="button"
            class="btn btn-danger-quiet"
            onClick={props.onDelete}
            title="Eliminar"
          >
            <ActionIcon name="delete" />
            <span class="sr-only">Eliminar</span>
          </button>
        </div>
      </header>

      <Show when={props.recipe.photoId}>
        <div class="detail-photo">
          <PhotoImage
            photoId={props.recipe.photoId}
            alt={`Foto de ${props.recipe.name}`}
            fallback={null}
          />
        </div>
      </Show>

      <Show when={categories().length > 0 || props.recipe.tags.length > 0}>
        <ul class="chip-row" aria-label="Categorías y etiquetas">
          <For each={categories()}>
            {(category) => <li class="chip">{category.name}</li>}
          </For>
          <For each={props.recipe.tags}>
            {(tag) => <li class="chip chip-tag">{tagLabels[tag]}</li>}
          </For>
        </ul>
      </Show>

      <Show when={source()} keyed>
        {(link) => (
          <p class="source">
            Fuente:{" "}
            <a href={link.href} target="_blank" rel="noopener noreferrer">
              {link.host}
              <span class="sr-only"> (se abre en una pestaña nueva)</span>
            </a>
          </p>
        )}
      </Show>

      <section class="panel" aria-labelledby="detail-ingredients">
        <div class="section-head">
          <h2 id="detail-ingredients">Ingredientes</h2>
          <p class="muted">Para {RECIPE_PORTIONS} porciones</p>
        </div>
        <Show
          when={props.recipe.ingredients.length > 0}
          fallback={
            <p class="empty-inline">
              Esta receta aún no tiene ingredientes.{" "}
              <a href={paths.editRecipe(props.recipe.id)}>
                Agrégalos al editarla
              </a>
              .
            </p>
          }
        >
          <ul class="ingredient-list">
            <For each={props.recipe.ingredients}>
              {(line) => <IngredientRow line={line} />}
            </For>
          </ul>
          <p class="hint">
            Cambiar la unidad ajusta cómo se muestra la cantidad.
          </p>
        </Show>
      </section>

      <section class="panel" aria-labelledby="detail-steps">
        <h2 id="detail-steps">Preparación</h2>
        <Show
          when={props.recipe.steps.length > 0}
          fallback={
            <p class="empty-inline">
              Esta receta aún no tiene pasos.{" "}
              <a href={paths.editRecipe(props.recipe.id)}>
                Agrégalos al editarla
              </a>
              .
            </p>
          }
        >
          <ol class="steps">
            <For each={props.recipe.steps}>{(step) => <li>{step}</li>}</For>
          </ol>
        </Show>
      </section>
    </article>
  );
}

function IngredientRow(props: { line: RecipeIngredient }) {
  const app = useApp();
  const [chosen, setChosen] = createSignal<UnitId | undefined>(undefined);
  const selectId = createUniqueId();
  const ingredient = () => app.ingredientsById().get(props.line.ingredientId);
  const name = () => ingredient()?.name ?? "Ingrediente eliminado";
  const measured = (): MeasuredAmount | undefined =>
    props.line.amount.kind === "measured" ? props.line.amount : undefined;

  const options = createMemo<UnitId[]>(() => {
    const amount = measured();
    if (!amount) return [];
    const density = ingredient()?.density;
    return orderedUnits.filter(
      (unit) => convertMeasuredAmount(amount, unit, density) !== undefined,
    );
  });

  const shown = createMemo(() => {
    const amount = measured();
    if (!amount) return undefined;
    const unit = chosen() ?? defaultMetricUnit(amount);
    if (unit === amount.unit) return { amount, converted: false };
    const result = convertMeasuredAmount(amount, unit, ingredient()?.density);
    return result
      ? { amount: result, converted: true }
      : { amount, converted: false };
  });

  const approximate = () => {
    const amount = measured();
    const current = shown();
    return Boolean(
      amount &&
        current?.converted &&
        usesDensity(amount.unit, current.amount.unit),
    );
  };

  const exactQuantity = () => {
    const current = shown();
    return current ? formatMeasuredAmount(current.amount) : "";
  };

  /** Converted values with long fractions read better as decimals. The stored value stays exact. */
  const quantityText = createMemo(() => {
    const current = shown();
    if (!current) return "";
    const exact = exactQuantity();
    const longFraction = [...exact.matchAll(/\/(\d+)/g)].some(
      (match) => Number(match[1]) > 16,
    );
    if (!current.converted || !longFraction) return exact;
    const min = approximateDecimal(current.amount.min);
    const max = current.amount.max
      ? approximateDecimal(current.amount.max)
      : "";
    if (!min || min === "0" || (current.amount.max && (!max || max === "0")))
      return exact;
    return `≈ ${max ? `${min}–${max}` : min}`;
  });

  const unitText = () => {
    const current = shown();
    return current
      ? unitLabel(current.amount.unit, current.amount.max ?? current.amount.min)
      : "";
  };

  return (
    <li class="ingredient-row">
      <div class="ingredient-main">
        <span class="ingredient-amount">
          <Show when={measured()}>
            <Show when={approximate() && !quantityText().startsWith("≈")}>
              <span aria-hidden="true">≈ </span>
            </Show>
            <strong>{quantityText()}</strong> {unitText()}
            <Show when={approximate()}>
              <span class="sr-only"> (aproximado)</span>
            </Show>
          </Show>
          <Show
            when={
              props.line.amount.kind === "qualitative"
                ? props.line.amount
                : undefined
            }
            keyed
          >
            {(amount) => <em>{amount.text}</em>}
          </Show>
        </span>
        <span class="ingredient-name">
          {name()}
          <Show when={props.line.amount.kind === "unspecified"}>
            <span class="sr-only"> (sin cantidad)</span>
          </Show>
        </span>
        <Show when={options().length > 1}>
          <span class="unit-picker">
            <label class="sr-only" for={selectId}>
              Unidad para {name()}
            </label>
            <select
              id={selectId}
              class="control control-small"
              value={shown()?.amount.unit}
              onChange={(event) =>
                setChosen(event.currentTarget.value as UnitId)
              }
            >
              <For each={options()}>
                {(unit) => (
                  <option value={unit}>
                    {unitOptionLabel(unit)}
                    {unit === measured()?.unit ? " (original)" : ""}
                  </option>
                )}
              </For>
            </select>
          </span>
        </Show>
      </div>
      <Show when={!approximate() && quantityText().startsWith("≈")}>
        <details class="approx-note">
          <summary title="Ver cantidad exacta">
            <ActionIcon name="expand" />
            <span class="sr-only">Ver cantidad exacta</span>
          </summary>
          <p class="source-text">
            {exactQuantity()} {unitText()}
          </p>
        </details>
      </Show>
      <Show when={approximate() ? ingredient()?.density : undefined} keyed>
        {(density) => (
          <div class="approx-note">
            <p>
              <strong>Aproximado:</strong> usa la densidad de {name()} (
              {approximateDecimal(density.gramsPerMilliliter)} g/ml).
            </p>
            <details>
              <summary title="Fuente de la densidad">
                <ActionIcon name="expand" />
                <span class="sr-only">Fuente de la densidad</span>
              </summary>
              <p class="source-text">{density.source}</p>
            </details>
          </div>
        )}
      </Show>
    </li>
  );
}
