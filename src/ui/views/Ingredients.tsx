import { ActionIcon } from "../components/ActionIcon";
import {
  createMemo,
  createSignal,
  createUniqueId,
  flush,
  For,
  Show,
} from "solid-js";
import type { Ingredient, IngredientClassification } from "../../contracts";
import { normalizeLookupText, parseRational } from "../../domain";
import { FieldError } from "../components/FieldError";
import { Modal } from "../components/Modal";
import {
  approximateDecimal,
  classificationLabels,
  compareNames,
  orderedClassifications,
  recipeCount,
} from "../text";
import { useApp } from "../use-app";

const defaultDensitySource = "Medida propia";

export function Ingredients() {
  const app = useApp();
  const ids = createUniqueId();
  const [query, setQuery] = createSignal("");
  const [editing, setEditing] = createSignal<
    { ingredient?: Ingredient } | undefined
  >(undefined);

  const usage = createMemo(() => {
    const recipes = new Map<string, number>();
    for (const recipe of app.library().recipes) {
      for (const id of new Set(
        recipe.ingredients.map((line) => line.ingredientId),
      )) {
        recipes.set(id, (recipes.get(id) ?? 0) + 1);
      }
    }
    return recipes;
  });

  const list = createMemo(() => {
    const text = normalizeLookupText(query());
    return app
      .library()
      .ingredients.filter(
        (item) => !text || normalizeLookupText(item.name).includes(text),
      )
      .sort((a, b) => compareNames(a.name, b.name));
  });

  async function remove(ingredient: Ingredient) {
    const used = usage().get(ingredient.id) ?? 0;
    if (used > 0) {
      app.notify(
        "error",
        `No se puede eliminar «${ingredient.name}» porque se usa en ${recipeCount(used)}. Quítalo primero de esas recetas.`,
      );
      return;
    }
    const children = app
      .library()
      .ingredients.filter((item) => item.parentId === ingredient.id).length;
    const accepted = await app.confirm({
      title: "¿Eliminar este ingrediente?",
      message:
        children > 0
          ? `Se eliminará «${ingredient.name}» del catálogo. Los ingredientes que lo tienen como tipo quedarán sin tipo.`
          : `Se eliminará «${ingredient.name}» del catálogo. Esta acción no se puede deshacer.`,
      confirmLabel: "Eliminar ingrediente",
      danger: true,
    });
    if (!accepted) return;
    if (await app.deleteIngredient(ingredient.id))
      app.notify("success", `Se eliminó «${ingredient.name}».`);
    else
      app.notify(
        "error",
        "No se pudo eliminar el ingrediente. Inténtalo de nuevo.",
      );
  }

  return (
    <>
      <div class="page-head">
        <h1 tabindex="-1">Ingredientes</h1>
        <button
          type="button"
          class="btn btn-primary"
          onClick={() => setEditing({})}
          title="Nuevo ingrediente"
        >
          <ActionIcon name="add" />
          <span class="sr-only">Nuevo ingrediente</span>
        </button>
      </div>
      <p class="lede">
        Tu catálogo se usa al escribir recetas. Un ingrediente puede ser un tipo
        de otro, como «Pechuga de pollo» dentro de «Pollo», y puede tener una
        densidad para convertir entre peso y volumen.
      </p>

      <div class="field">
        <label for={`${ids}-query`}>Buscar ingrediente</label>
        <input
          id={`${ids}-query`}
          class="control"
          type="search"
          autocomplete="off"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      <p role="status" class="results-count">
        {list().length === 1
          ? "1 ingrediente"
          : `${list().length} ingredientes`}
      </p>

      <Show
        when={list().length > 0}
        fallback={
          <section class="empty-state">
            <h2>
              {app.library().ingredients.length === 0
                ? "El catálogo está vacío"
                : "Ningún ingrediente coincide"}
            </h2>
            <p>
              {app.library().ingredients.length === 0
                ? "Crea ingredientes aquí o desde el formulario de una receta."
                : "Prueba con otro nombre."}
            </p>
          </section>
        }
      >
        <ul class="catalog-list">
          <For each={list()}>
            {(ingredient) => {
              const parent = () =>
                ingredient.parentId
                  ? app.ingredientsById().get(ingredient.parentId)
                  : undefined;
              const used = () => usage().get(ingredient.id) ?? 0;
              return (
                <li class="catalog-row">
                  <div class="catalog-main">
                    <h2 class="catalog-name">{ingredient.name}</h2>
                    <p class="card-meta">
                      <Show when={parent()}>
                        {(item) => <span>Tipo de {item().name}</span>}
                      </Show>
                      <Show when={ingredient.classification}>
                        {(value) => (
                          <span>{classificationLabels[value()]}</span>
                        )}
                      </Show>
                      <Show when={ingredient.density}>
                        {(density) => (
                          <span>
                            Densidad{" "}
                            {approximateDecimal(density().gramsPerMilliliter)}{" "}
                            g/ml
                          </span>
                        )}
                      </Show>
                      <span>
                        {used() > 0 ? `En ${recipeCount(used())}` : "Sin usar"}
                      </span>
                    </p>
                  </div>
                  <div class="actions">
                    <button
                      type="button"
                      class="btn btn-small"
                      aria-label={`Editar ${ingredient.name}`}
                      onClick={() => setEditing({ ingredient })}
                      title={`Editar ${ingredient.name}`}
                    >
                      <ActionIcon name="edit" />
                      <span class="sr-only">Editar</span>
                    </button>
                    <button
                      type="button"
                      class="btn btn-small btn-danger-quiet"
                      aria-label={`Eliminar ${ingredient.name}`}
                      onClick={() => void remove(ingredient)}
                      title={`Eliminar ${ingredient.name}`}
                    >
                      <ActionIcon name="delete" />
                      <span class="sr-only">Eliminar</span>
                    </button>
                  </div>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>

      <Show when={editing()} keyed>
        {(state) => (
          <IngredientDialog
            ingredient={state.ingredient}
            onClose={() => setEditing(undefined)}
          />
        )}
      </Show>
    </>
  );
}

function IngredientDialog(props: {
  ingredient: Ingredient | undefined;
  onClose: () => void;
}) {
  const app = useApp();
  const ids = createUniqueId();
  const original = props.ingredient;
  const seedDensity = original?.density
    ? approximateDecimal(original.density.gramsPerMilliliter)
    : "";

  const [name, setName] = createSignal(original?.name ?? "");
  const [parentId, setParentId] = createSignal(original?.parentId ?? "");
  const [classification, setClassification] = createSignal<
    IngredientClassification | ""
  >(original?.classification ?? "");
  const [density, setDensity] = createSignal(seedDensity);
  const [densitySource, setDensitySource] = createSignal(
    original?.density?.source ?? "",
  );
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const [failure, setFailure] = createSignal("");
  const [saving, setSaving] = createSignal(false);

  // A parent cannot be the ingredient itself or one of its descendants.
  const parentOptions = createMemo(() => {
    const excluded = new Set<string>();
    if (original) {
      excluded.add(original.id);
      let grew = true;
      while (grew) {
        grew = false;
        for (const item of app.library().ingredients) {
          if (
            item.parentId &&
            excluded.has(item.parentId) &&
            !excluded.has(item.id)
          ) {
            excluded.add(item.id);
            grew = true;
          }
        }
      }
    }
    return app
      .library()
      .ingredients.filter((item) => !excluded.has(item.id))
      .sort((a, b) => compareNames(a.name, b.name));
  });

  const clear = (field: string) =>
    setErrors((current) => {
      const { [field]: _removed, ...rest } = current;
      return rest;
    });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving()) return;
    flush();
    setFailure("");
    const found: Record<string, string> = {};

    const trimmed = name().trim().replace(/\s+/gu, " ");
    if (!trimmed) found.name = "Escribe el nombre del ingrediente.";
    else {
      const key = normalizeLookupText(trimmed);
      const duplicate = app
        .library()
        .ingredients.some(
          (item) =>
            item.id !== original?.id && normalizeLookupText(item.name) === key,
        );
      if (duplicate) found.name = "Ya existe un ingrediente con ese nombre.";
    }

    let densityValue: Ingredient["density"];
    const densityText = density().trim();
    if (densityText) {
      if (original?.density && densityText === seedDensity) {
        // The field shows a rounded value, so an untouched field keeps the exact stored ratio.
        densityValue = {
          gramsPerMilliliter: original.density.gramsPerMilliliter,
          source: densitySource().trim() || original.density.source,
        };
      } else {
        try {
          densityValue = {
            gramsPerMilliliter: parseRational(densityText),
            source: densitySource().trim() || defaultDensitySource,
          };
        } catch (error) {
          console.error(
            "Invalid density entered in the ingredient form.",
            error,
          );
          found.density =
            "Escribe un número mayor que cero, por ejemplo 0.8 o 4/5.";
        }
      }
    }

    setErrors(found);
    const first = Object.keys(found)[0];
    if (first) {
      document.getElementById(`${ids}-${first}`)?.focus();
      return;
    }

    setSaving(true);
    const result = await app.saveIngredient({
      ...(original ? { id: original.id } : {}),
      name: trimmed,
      ...(parentId() ? { parentId: parentId() } : {}),
      ...(classification()
        ? { classification: classification() as IngredientClassification }
        : {}),
      ...(densityValue ? { density: densityValue } : {}),
    });
    setSaving(false);

    if (result.ok) {
      app.notify(
        "success",
        original ? "Ingrediente actualizado." : "Ingrediente creado.",
      );
      props.onClose();
    } else {
      setFailure(
        "No pudimos guardar el ingrediente. Tus datos siguen aquí. Inténtalo de nuevo.",
      );
    }
  }

  return (
    <Modal
      title={original ? "Editar ingrediente" : "Nuevo ingrediente"}
      onClose={() => !saving() && props.onClose()}
    >
      <form novalidate onSubmit={(event) => void submit(event)}>
        <div role="alert">
          <Show when={failure()}>
            <p class="error-box">{failure()}</p>
          </Show>
        </div>
        <div class="field">
          <label for={`${ids}-name`}>
            Nombre <span class="required">(obligatorio)</span>
          </label>
          <input
            id={`${ids}-name`}
            class="control"
            type="text"
            autocomplete="off"
            aria-required="true"
            aria-invalid={errors().name ? "true" : undefined}
            aria-describedby={errors().name ? `${ids}-name-error` : undefined}
            value={name()}
            onInput={(event) => {
              setName(event.currentTarget.value);
              clear("name");
            }}
          />
          <FieldError id={`${ids}-name-error`} message={errors().name} />
        </div>

        <div class="field">
          <label for={`${ids}-parent`}>
            Es un tipo de <span class="muted">(opcional)</span>
          </label>
          <select
            id={`${ids}-parent`}
            class="control"
            aria-describedby={`${ids}-parent-hint`}
            value={parentId()}
            onChange={(event) => setParentId(event.currentTarget.value)}
          >
            <option value="">Ninguno</option>
            <For each={parentOptions()}>
              {(item) => <option value={item.id}>{item.name}</option>}
            </For>
          </select>
          <p class="hint" id={`${ids}-parent-hint`}>
            Filtrar por el ingrediente general también encuentra recetas con
            este. En la lista de compras siguen separados.
          </p>
        </div>

        <div class="field">
          <label for={`${ids}-classification`}>
            Clasificación <span class="muted">(opcional)</span>
          </label>
          <select
            id={`${ids}-classification`}
            class="control"
            aria-describedby={`${ids}-classification-hint`}
            value={classification()}
            onChange={(event) =>
              setClassification(
                event.currentTarget.value as IngredientClassification | "",
              )
            }
          >
            <option value="">Sin clasificar</option>
            <For each={orderedClassifications}>
              {(value) => (
                <option value={value}>{classificationLabels[value]}</option>
              )}
            </For>
          </select>
          <p class="hint" id={`${ids}-classification-hint`}>
            Se usa para sugerir etiquetas como Vegana o Contiene carne.
          </p>
        </div>

        <div class="field">
          <label for={`${ids}-density`}>
            Densidad en g/ml <span class="muted">(opcional)</span>
          </label>
          <input
            id={`${ids}-density`}
            class="control"
            type="text"
            inputmode="text"
            autocomplete="off"
            placeholder="0.53"
            aria-invalid={errors().density ? "true" : undefined}
            aria-describedby={
              errors().density ? `${ids}-density-error` : `${ids}-density-hint`
            }
            value={density()}
            onInput={(event) => {
              setDensity(event.currentTarget.value);
              clear("density");
            }}
          />
          <FieldError id={`${ids}-density-error`} message={errors().density} />
          <Show when={!errors().density}>
            <p class="hint" id={`${ids}-density-hint`}>
              Gramos por mililitro. Se usa para convertir entre peso y volumen
              de forma aproximada. Déjalo vacío si no la conoces.
            </p>
          </Show>
        </div>

        <Show when={density().trim() !== ""}>
          <div class="field">
            <label for={`${ids}-source`}>Fuente de la densidad</label>
            <input
              id={`${ids}-source`}
              class="control"
              type="text"
              autocomplete="off"
              placeholder={defaultDensitySource}
              value={densitySource()}
              onInput={(event) => setDensitySource(event.currentTarget.value)}
            />
          </div>
        </Show>

        <div class="actions actions-end">
          <button
            type="button"
            class="btn"
            disabled={saving()}
            onClick={props.onClose}
            title="Cancelar"
          >
            <ActionIcon name="close" />
            <span class="sr-only">Cancelar</span>
          </button>
          <button
            type="submit"
            class="btn btn-primary"
            disabled={saving()}
            title={saving() ? "Guardando…" : "Guardar"}
          >
            <ActionIcon name="save" />
            <span class="sr-only">{saving() ? "Guardando…" : "Guardar"}</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}
