import { ActionIcon } from "../components/ActionIcon";
import {
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Show,
  flush,
} from "solid-js";
import type { MenuEntry } from "../../contracts";
import { FieldError } from "../components/FieldError";
import { paths } from "../router";
import { ingredientCount } from "../text";
import { useApp } from "../use-app";

export function Menu() {
  const app = useApp();
  const [clearing, setClearing] = createSignal(false);
  const recipeIds = createMemo(
    () => new Set(app.library().recipes.map(({ id }) => id)),
  );

  async function clear() {
    if (clearing()) return;
    setClearing(true);
    const accepted = await app.confirm({
      title: "¿Vaciar el menú?",
      message:
        "Se quitarán los lotes del menú y se reiniciará el progreso de compras. Tus artículos manuales se conservarán.",
      confirmLabel: "Sí, vaciar el menú",
      danger: true,
    });
    if (accepted) {
      if (await app.clearActiveMenu()) {
        app.notify("success", "Se vació el menú.");
        restoreMenuFocus();
      } else {
        app.notify("error", "No se pudo vaciar el menú. Inténtalo de nuevo.");
      }
    }
    setClearing(false);
  }

  return (
    <>
      <header class="page-head">
        <h1 id="menu-heading" tabindex="-1">
          Menú
        </h1>
        <Show when={app.menu().length > 0}>
          <div class="actions">
            <a
              class="btn btn-primary"
              href={paths.shopping}
              title="Ver lista de compras"
            >
              <ActionIcon name="shopping" />
              <span class="sr-only">Ver lista de compras</span>
            </a>
            <button
              type="button"
              class="btn btn-danger-quiet"
              aria-disabled={clearing() ? "true" : undefined}
              onClick={() => void clear()}
              title="Vaciar menú"
            >
              <ActionIcon name="delete" />
              <span class="sr-only">Vaciar menú</span>
            </button>
          </div>
        </Show>
      </header>
      <Show
        when={app.menu().length > 0}
        fallback={
          <section class="empty-state">
            <h2>Tu menú está vacío</h2>
            <p>
              Agrega las recetas que quieres preparar y ajusta las porciones de
              cada lote.
            </p>
            <a
              class="btn btn-primary"
              href={paths.recipes}
              title="Explorar recetas"
            >
              <ActionIcon name="recipes" />
              <span class="sr-only">Explorar recetas</span>
            </a>
          </section>
        }
      >
        <ul class="planning-list">
          <For each={app.menu()} keyed={(entry) => entry.id}>
            {(entry) => (
              <MenuBatch
                entry={entry()}
                sourceExists={recipeIds().has(entry().sourceRecipeId)}
              />
            )}
          </For>
        </ul>
      </Show>
    </>
  );
}

function restoreMenuFocus() {
  flush();
  if (document.activeElement === document.body)
    document.getElementById("menu-heading")?.focus();
}

function MenuBatch(props: { entry: MenuEntry; sourceExists: boolean }) {
  const app = useApp();
  const id = createUniqueId();
  const [draft, setDraft] = createSignal<string>();
  const [error, setError] = createSignal<string>();
  const [pending, setPending] = createSignal(false);
  const entered = () => draft() ?? String(props.entry.portions);
  const missingIngredients = createMemo(() => [
    ...new Set(
      props.entry.ingredients
        .filter((line) => !app.ingredientsById().has(line.ingredientId))
        .map((line) => line.name),
    ),
  ]);

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (pending()) return;
    const text = entered().trim();
    const portions = Number(text);
    if (
      !/^\d+$/.test(text) ||
      !Number.isSafeInteger(portions) ||
      portions <= 0
    ) {
      setError("Escribe un número entero de porciones mayor que cero.");
      document.getElementById(`${id}-portions`)?.focus();
      return;
    }

    setPending(true);
    const saved = await app.setMenuBatchPortions(props.entry.id, portions);
    setPending(false);
    if (saved) {
      setDraft(undefined);
      app.notify("success", "Porciones actualizadas.");
    } else {
      app.notify(
        "error",
        "No se pudieron guardar las porciones. Inténtalo de nuevo.",
      );
    }
  }

  async function remove() {
    if (pending()) return;
    setPending(true);
    const removed = await app.removeMenuBatch(props.entry.id);
    setPending(false);
    if (removed) {
      app.notify("success", "Se quitó el lote del menú.");
      restoreMenuFocus();
    } else {
      app.notify("error", "No se pudo quitar el lote. Inténtalo de nuevo.");
    }
  }

  return (
    <li class="panel menu-batch">
      <div class="section-head">
        <h2 id={`${id}-title`}>
          <Show when={props.sourceExists} fallback={props.entry.name}>
            <a href={paths.recipe(props.entry.sourceRecipeId)}>
              {props.entry.name}
            </a>
          </Show>
        </h2>
        <button
          type="button"
          class="btn btn-danger-quiet btn-small"
          aria-label={`Quitar lote de «${props.entry.name}»`}
          aria-disabled={pending() ? "true" : undefined}
          onClick={() => void remove()}
          title={`Quitar lote de «${props.entry.name}»`}
        >
          <ActionIcon name="delete" />
          <span class="sr-only">Quitar lote</span>
        </button>
      </div>
      <Show when={!props.sourceExists}>
        <p class="hint">
          La receta original se eliminó. El lote sigue en tu menú.
        </p>
      </Show>
      <p class="hint">
        {props.entry.ingredients.length > 0
          ? ingredientCount(
              new Set(props.entry.ingredients.map((line) => line.ingredientId))
                .size,
            )
          : "Este lote no tiene ingredientes para la lista de compras."}
      </p>
      <Show when={missingIngredients().length > 0}>
        <p class="hint">
          Ya no están en el catálogo los siguientes ingredientes del lote (
          {missingIngredients().join(", ")}).
        </p>
      </Show>

      <form
        aria-labelledby={`${id}-title`}
        class="batch-form"
        onSubmit={(event) => void save(event)}
      >
        <div class="batch-controls">
          <div>
            <label for={`${id}-portions`}>Porciones</label>
            <input
              id={`${id}-portions`}
              class="control"
              type="text"
              inputmode="numeric"
              autocomplete="off"
              value={entered()}
              readonly={pending()}
              aria-invalid={error() ? "true" : undefined}
              aria-describedby={error() ? `${id}-error` : undefined}
              onInput={(event) => {
                setDraft(event.currentTarget.value);
                setError(undefined);
              }}
            />
          </div>
          <button
            type="submit"
            class="btn btn-small"
            aria-disabled={pending() ? "true" : undefined}
            title="Guardar porciones"
          >
            <ActionIcon name="save" />
            <span class="sr-only">Guardar porciones</span>
          </button>
        </div>
        <div role="alert">
          <FieldError id={`${id}-error`} message={error()} />
        </div>
      </form>
    </li>
  );
}
