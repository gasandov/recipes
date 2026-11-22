import { createMemo, createSignal, createUniqueId, flush, For, Show } from "solid-js";
import type { Category } from "../../contracts";
import { normalizeLookupText } from "../../domain";
import { FieldError } from "../components/FieldError";
import { compareNames, recipeCount } from "../text";
import { focusSelector, useApp } from "../use-app";

export function Categories() {
  return (
    <>
      <div class="page-head">
        <h1 tabindex="-1">Categorías</h1>
      </div>
      <p class="lede">Organiza tus recetas por tipo de platillo y por cocina. Puedes asignar varias a una misma receta.</p>
      <CategorySection
        kind="dish_type"
        title="Tipos de platillo"
        singular="tipo de platillo"
        emptyText="Aún no tienes tipos de platillo."
      />
      <CategorySection kind="cuisine" title="Cocinas" singular="cocina" emptyText="Aún no tienes cocinas." />
    </>
  );
}

function CategorySection(props: { kind: Category["kind"]; title: string; singular: string; emptyText: string }) {
  const app = useApp();
  const ids = createUniqueId();
  const [newName, setNewName] = createSignal("");
  const [newError, setNewError] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | undefined>(undefined);
  const [editName, setEditName] = createSignal("");
  const [editError, setEditError] = createSignal("");
  const [savingEdit, setSavingEdit] = createSignal(false);

  const list = createMemo(() =>
    app.library().categories.filter((category) => category.kind === props.kind).sort((a, b) => compareNames(a.name, b.name)),
  );
  const usage = createMemo(() => {
    const counts = new Map<string, number>();
    for (const recipe of app.library().recipes) {
      for (const id of new Set(recipe.categoryIds)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  });

  /** Returns an error message when the name is blank or already used in this section. */
  function problem(text: string, ignoreId?: string): string | undefined {
    const trimmed = text.trim();
    if (!trimmed) return "Escribe un nombre.";
    const key = normalizeLookupText(trimmed);
    const duplicate = list().some((category) => category.id !== ignoreId && normalizeLookupText(category.name) === key);
    return duplicate ? "Ya existe una categoría con ese nombre en esta sección." : undefined;
  }

  async function add(event: SubmitEvent) {
    event.preventDefault();
    if (adding()) return;
    flush();
    const error = problem(newName());
    setNewError(error ?? "");
    if (error) {
      focusSelector(`#${ids}-new`);
      return;
    }
    setAdding(true);
    const result = await app.saveCategory({ name: newName().trim().replace(/\s+/gu, " "), kind: props.kind });
    setAdding(false);
    if (result.ok) {
      setNewName("");
      app.notify("success", `Se agregó «${result.value.name}».`);
      focusSelector(`#${ids}-new`);
    } else {
      setNewError("No pudimos guardar la categoría. Tu texto sigue aquí. Inténtalo de nuevo.");
    }
  }

  function startEdit(category: Category) {
    setEditingId(category.id);
    setEditName(category.name);
    setEditError("");
    // The input exists only after the row re-renders.
    flush();
    focusSelector(`#${ids}-edit`);
  }

  function stopEdit(id: string) {
    setEditingId(undefined);
    flush();
    focusSelector(`#${ids}-edit-${id}`);
  }

  async function saveEdit(event: SubmitEvent, category: Category) {
    event.preventDefault();
    if (savingEdit()) return;
    flush();
    const error = problem(editName(), category.id);
    setEditError(error ?? "");
    if (error) {
      focusSelector(`#${ids}-edit`);
      return;
    }
    setSavingEdit(true);
    const result = await app.saveCategory({ id: category.id, name: editName().trim().replace(/\s+/gu, " "), kind: category.kind });
    setSavingEdit(false);
    if (result.ok) {
      app.notify("success", "Categoría actualizada.");
      stopEdit(category.id);
    } else {
      setEditError("No pudimos guardar la categoría. Tu texto sigue aquí. Inténtalo de nuevo.");
    }
  }

  async function remove(category: Category) {
    const used = usage().get(category.id) ?? 0;
    const accepted = await app.confirm({
      title: "¿Eliminar esta categoría?",
      message:
        used > 0
          ? `Se quitará «${category.name}» de ${recipeCount(used)}. Las recetas no se eliminan.`
          : `Se eliminará «${category.name}». Esta acción no se puede deshacer.`,
      confirmLabel: "Eliminar categoría",
      danger: true,
    });
    if (!accepted) return;
    if (await app.deleteCategory(category.id)) {
      app.notify("success", `Se eliminó «${category.name}».`);
      focusSelector(`#${ids}-new`);
    } else {
      app.notify("error", "No se pudo eliminar la categoría. Inténtalo de nuevo.");
    }
  }

  return (
    <section class="panel" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`}>{props.title}</h2>
      <Show when={list().length > 0} fallback={<p class="empty-inline">{props.emptyText}</p>}>
        <ul class="catalog-list">
          <For each={list()}>
            {(category) => (
              <li class="catalog-row">
                <Show
                  when={editingId() === category.id}
                  fallback={
                    <>
                      <div class="catalog-main">
                        <h3 class="catalog-name">{category.name}</h3>
                        <p class="card-meta">
                          {usage().get(category.id) ? `En ${recipeCount(usage().get(category.id) ?? 0)}` : "Sin usar"}
                        </p>
                      </div>
                      <div class="actions">
                        <button
                          type="button"
                          id={`${ids}-edit-${category.id}`}
                          class="btn btn-small"
                          aria-label={`Renombrar ${category.name}`}
                          onClick={() => startEdit(category)}
                        >
                          Renombrar
                        </button>
                        <button
                          type="button"
                          class="btn btn-small btn-danger-quiet"
                          aria-label={`Eliminar ${category.name}`}
                          onClick={() => void remove(category)}
                        >
                          Eliminar
                        </button>
                      </div>
                    </>
                  }
                >
                  <form class="inline-form" novalidate onSubmit={(event) => void saveEdit(event, category)}>
                    <div class="field">
                      <label for={`${ids}-edit`}>Nombre de la categoría</label>
                      <input
                        id={`${ids}-edit`}
                        class="control"
                        type="text"
                        autocomplete="off"
                        aria-invalid={editError() ? "true" : undefined}
                        aria-describedby={editError() ? `${ids}-edit-error` : undefined}
                        value={editName()}
                        onInput={(event) => {
                          setEditName(event.currentTarget.value);
                          setEditError("");
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") stopEdit(category.id);
                        }}
                      />
                      <FieldError id={`${ids}-edit-error`} message={editError()} />
                    </div>
                    <div class="actions">
                      <button type="submit" class="btn btn-small btn-primary" disabled={savingEdit()}>
                        {savingEdit() ? "Guardando…" : "Guardar"}
                      </button>
                      <button type="button" class="btn btn-small" onClick={() => stopEdit(category.id)}>
                        Cancelar
                      </button>
                    </div>
                  </form>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <form class="inline-form add-form" novalidate onSubmit={(event) => void add(event)}>
        <div class="field">
          <label for={`${ids}-new`}>Agregar {props.singular}</label>
          <input
            id={`${ids}-new`}
            class="control"
            type="text"
            autocomplete="off"
            aria-invalid={newError() ? "true" : undefined}
            aria-describedby={newError() ? `${ids}-new-error` : undefined}
            value={newName()}
            onInput={(event) => {
              setNewName(event.currentTarget.value);
              setNewError("");
            }}
          />
          <FieldError id={`${ids}-new-error`} message={newError()} />
        </div>
        <button type="submit" class="btn btn-primary" disabled={adding()}>
          {adding() ? "Agregando…" : "Agregar"}
        </button>
      </form>
    </section>
  );
}
