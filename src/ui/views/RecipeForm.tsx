import { ActionIcon } from "../components/ActionIcon";
import {
  createMemo,
  createSignal,
  createStore,
  createUniqueId,
  flush,
  For,
  Match,
  onSettled,
  Show,
  Switch,
} from "solid-js";
import type {
  CapturedIngredient,
  CapturedRecipe,
} from "../../capture/contract";
import { RECIPE_PORTIONS } from "../../contracts";
import type {
  Amount,
  Ingredient,
  Recipe,
  RecipeDraft,
  RecipeIngredient,
  TagId,
  UnitId,
} from "../../contracts";
import {
  formatMeasuredAmount,
  normalizeLookupText,
  normalizeSourceUrl,
  parseMeasuredAmount,
  suggestTags,
} from "../../domain";
import { FieldError } from "../components/FieldError";
import { IngredientCombobox } from "../components/IngredientCombobox";
import { PhotoField } from "../components/PhotoField";
import type { PhotoChoice } from "../components/PhotoField";
import { navigate, paths } from "../router";
import {
  categoryKindLabels,
  compareNames,
  orderedTags,
  orderedUnits,
  tagLabels,
  unitOptionLabel,
} from "../text";
import { focusSelector, useApp } from "../use-app";

type LineKind = "measured" | "qualitative" | "unspecified";

type LineDraft = {
  key: number;
  ingredientId: string;
  query: string;
  kind: LineKind;
  quantity: string;
  unit: UnitId;
  note: string;
};

type StepRow = { key: number; text: string };

type FormState = {
  name: string;
  portions: string;
  sourceUrl: string;
  categoryIds: string[];
  tags: TagId[];
  lines: LineDraft[];
};

type Props = { recipe: Recipe | undefined; captured?: CapturedRecipe };

const defaultNote = "al gusto";
const quantityHint = "Ejemplos: 2, 1/2, 1 1/2, 0.5 o un rango como 2-3.";
const submitFailure =
  "Tus cambios siguen en este formulario. Inténtalo de nuevo. Si el problema continúa, revisa el espacio disponible en el dispositivo.";

let counter = 0;
const nextKey = () => ++counter;

function emptyLine(): LineDraft {
  return {
    key: nextKey(),
    ingredientId: "",
    query: "",
    kind: "measured",
    quantity: "",
    unit: "gram",
    note: defaultNote,
  };
}

function lineFromRecipe(
  line: RecipeIngredient,
  ingredients: Map<string, Ingredient>,
): LineDraft {
  const draft: LineDraft = { ...emptyLine(), ingredientId: line.ingredientId };
  const ingredient = ingredients.get(line.ingredientId);
  if (ingredient) draft.query = ingredient.name;
  else draft.ingredientId = "";

  switch (line.amount.kind) {
    case "measured":
      draft.quantity = formatMeasuredAmount(line.amount);
      draft.unit = line.amount.unit;
      break;
    case "qualitative":
      draft.kind = "qualitative";
      draft.note = line.amount.text;
      break;
    case "unspecified":
      draft.kind = "unspecified";
      break;
  }
  return draft;
}

function pluralOf(word: string): string {
  if (word.endsWith("z")) return `${word.slice(0, -1)}ces`;
  return /[aeiou]$/.test(word) ? `${word}s` : `${word}es`;
}

function matchCapturedIngredient(
  name: string,
  ingredients: Ingredient[],
): Ingredient | undefined {
  const normalized = normalizeLookupText(name);
  const labels = ingredients.map((ingredient) => ({
    ingredient,
    key: normalizeLookupText(ingredient.name),
  }));
  const exact = labels.filter(({ key }) => key === normalized);
  if (exact.length) return exact.length === 1 ? exact[0].ingredient : undefined;
  const words = normalized.split(" ");
  const variants = labels.filter(({ key }) => {
    const candidate = key.split(" ");
    return (
      candidate.length === words.length &&
      candidate.every(
        (word, index) =>
          word === words[index] ||
          pluralOf(word) === words[index] ||
          word === pluralOf(words[index]),
      )
    );
  });
  return variants.length === 1 ? variants[0].ingredient : undefined;
}

function lineFromCapture(
  line: CapturedIngredient,
  ingredients: Ingredient[],
): LineDraft {
  const matched = matchCapturedIngredient(line.name, ingredients);
  const draft: LineDraft = {
    ...emptyLine(),
    ingredientId: matched?.id ?? "",
    query: matched?.name ?? line.name,
    kind: line.amount.kind,
  };
  if (line.amount.kind === "measured") {
    draft.quantity = formatMeasuredAmount(line.amount);
    draft.unit = line.amount.unit;
  }
  if (line.amount.kind === "qualitative") draft.note = line.amount.text;
  return draft;
}

export function RecipeForm(props: Props) {
  const app = useApp();
  // The form edits its own copy. Library refreshes (for example after creating an ingredient) must not reset it.
  const seed = app.snapshot();
  const original = props.recipe;
  const captured = props.captured;
  const needsPortionConfirmation =
    captured !== undefined && captured.portions === undefined;
  const catalog = new Map(
    seed.ingredients.map((ingredient) => [ingredient.id, ingredient]),
  );
  const initialSteps = original?.steps ?? captured?.steps ?? [];

  const [form, setForm] = createStore<FormState>({
    name: original?.name ?? captured?.name ?? "",
    portions: String(captured?.portions ?? RECIPE_PORTIONS),
    sourceUrl: original?.sourceUrl ?? captured?.sourceUrl ?? "",
    categoryIds: original ? [...original.categoryIds] : [],
    tags: original ? [...original.tags] : [],
    lines: original
      ? original.ingredients.map((line) => lineFromRecipe(line, catalog))
      : (captured?.ingredients ?? []).map((line) =>
          lineFromCapture(line, seed.ingredients),
        ),
  });
  const [portionsConfirmed, setPortionsConfirmed] = createSignal(
    !needsPortionConfirmation,
  );
  const [steps, setSteps] = createSignal<StepRow[]>(
    (initialSteps.length > 0 ? initialSteps : [""]).map((text) => ({
      key: nextKey(),
      text,
    })),
  );
  const [photo, setPhoto] = createSignal<PhotoChoice>({ kind: "keep" });
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const [summary, setSummary] = createSignal<
    | {
        title: string;
        items: { id: string; message: string }[];
        detail?: string;
      }
    | undefined
  >(undefined);
  const [saving, setSaving] = createSignal(false);
  const [dirty, setDirty] = createSignal(captured !== undefined);
  const [announcement, setAnnouncement] = createSignal("");
  const ids = createUniqueId();
  const isEditing = original !== undefined;

  onSettled(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!dirty()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  });

  const markDirty = () => setDirty(true);
  const clearError = (id: string) =>
    setErrors((current) => {
      if (!(id in current)) return current;
      const { [id]: _removed, ...rest } = current;
      return rest;
    });

  const dishTypes = createMemo(() =>
    app
      .library()
      .categories.filter((category) => category.kind === "dish_type")
      .sort((a, b) => compareNames(a.name, b.name)),
  );
  const cuisines = createMemo(() =>
    app
      .library()
      .categories.filter((category) => category.kind === "cuisine")
      .sort((a, b) => compareNames(a.name, b.name)),
  );

  // --- Ingredient lines ---------------------------------------------------------------------------

  function patchLine(key: number, patch: Partial<LineDraft>) {
    setForm((draft) => {
      const line = draft.lines.find((item) => item.key === key);
      if (line) Object.assign(line, patch);
    });
  }

  function addLine() {
    const line = emptyLine();
    setForm((draft) => {
      draft.lines.push(line);
    });
    markDirty();
    flush();
    focusSelector(`#line-${line.key}-ingredient`);
  }

  function removeLine(key: number) {
    const index = form.lines.findIndex((line) => line.key === key);
    setForm((draft) => {
      draft.lines = draft.lines.filter((line) => line.key !== key);
    });
    markDirty();
    setErrors((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([id]) => !id.startsWith(`line-${key}-`),
        ),
      ),
    );
    setAnnouncement(`Ingrediente ${index + 1} quitado.`);
    flush();
    const remaining = form.lines;
    const neighbour = remaining[Math.min(index, remaining.length - 1)];
    if (neighbour) focusSelector(`#line-${neighbour.key}-ingredient`);
    else focusSelector("#add-line");
  }

  async function createIngredient(key: number, name: string) {
    const result = await app.saveIngredient({ name });
    if (result.ok) {
      patchLine(key, {
        ingredientId: result.value.id,
        query: result.value.name,
      });
      clearError(`line-${key}-ingredient`);
      markDirty();
      setAnnouncement(
        `Ingrediente «${result.value.name}» creado en el catálogo.`,
      );
    } else {
      setErrors((current) => ({
        ...current,
        [`line-${key}-ingredient`]:
          "No se pudo crear el ingrediente. Inténtalo de nuevo.",
      }));
    }
  }

  // --- Steps -----------------------------------------------------------------------------------------

  function addStep() {
    const row: StepRow = { key: nextKey(), text: "" };
    setSteps((current) => [...current, row]);
    markDirty();
    flush();
    focusSelector(`#step-${row.key}`);
  }

  function removeStep(key: number) {
    const index = steps().findIndex((row) => row.key === key);
    setSteps((current) => current.filter((row) => row.key !== key));
    markDirty();
    setAnnouncement(`Paso ${index + 1} quitado.`);
    flush();
    const remaining = steps();
    const neighbour = remaining[Math.min(index, remaining.length - 1)];
    if (neighbour) focusSelector(`#step-${neighbour.key}`);
    else focusSelector("#add-step");
  }

  function moveStep(key: number, delta: -1 | 1) {
    const from = steps().findIndex((row) => row.key === key);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= steps().length) return;
    const next = steps().slice();
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row);
    setSteps(next);
    markDirty();
    setAnnouncement(`Paso movido a la posición ${to + 1} de ${next.length}.`);
    flush();
    // Moving a node can drop focus, and the button may now be disabled at the edge of the list.
    const preferred = `#step-${key}-${delta < 0 ? "up" : "down"}`;
    const fallback = `#step-${key}-${delta < 0 ? "down" : "up"}`;
    const target = document.querySelector<HTMLButtonElement>(preferred);
    if (target && !target.disabled) target.focus();
    else focusSelector(fallback);
  }

  // --- Tags ------------------------------------------------------------------------------------------

  const unresolvedLines = () =>
    form.lines.some((line) => !line.ingredientId && line.query.trim() !== "");
  const resolvedLines = createMemo<RecipeIngredient[]>(() =>
    form.lines
      .filter((line) => line.ingredientId)
      .map((line) => ({
        ingredientId: line.ingredientId,
        amount: { kind: "unspecified" },
      })),
  );
  const unclassified = createMemo(() => {
    const names: string[] = [];
    for (const line of resolvedLines()) {
      const ingredient = app.ingredientsById().get(line.ingredientId);
      if (
        ingredient &&
        !ingredient.classification &&
        !names.includes(ingredient.name)
      )
        names.push(ingredient.name);
    }
    return names;
  });
  // Dietary suggestions need every row resolved, otherwise "vegan" could be suggested for a partial list.
  const suggestions = createMemo<TagId[]>(() =>
    unresolvedLines()
      ? []
      : suggestTags(resolvedLines(), app.library().ingredients).filter(
          (tag) => !form.tags.includes(tag),
        ),
  );

  function setTag(tag: TagId, selected: boolean) {
    setForm((draft) => {
      const present = draft.tags.includes(tag);
      if (selected && !present) draft.tags.push(tag);
      if (!selected && present)
        draft.tags = draft.tags.filter((item) => item !== tag);
    });
    markDirty();
  }

  function toggleCategory(id: string, selected: boolean) {
    setForm((draft) => {
      const present = draft.categoryIds.includes(id);
      if (selected && !present) draft.categoryIds.push(id);
      if (!selected && present)
        draft.categoryIds = draft.categoryIds.filter((item) => item !== id);
    });
    markDirty();
  }

  // --- Submit ----------------------------------------------------------------------------------------

  function validate(): { draft: RecipeDraft } | undefined {
    const found: { id: string; message: string }[] = [];
    const fail = (id: string, message: string) => found.push({ id, message });

    const name = form.name.trim();
    if (!name) fail("recipe-name", "Escribe el nombre de la receta.");

    const portionsText = form.portions.trim();
    const portions = /^\d+$/.test(portionsText)
      ? Number(portionsText)
      : Number.NaN;
    if (!Number.isSafeInteger(portions) || portions <= 0) {
      fail(
        "recipe-portions",
        "Escribe un número entero de porciones mayor que cero, por ejemplo 4.",
      );
    }
    if (!portionsConfirmed())
      fail(
        "recipe-confirm-portions",
        "Confirma cuántas porciones rinde la receta.",
      );

    let sourceUrl: string | undefined;
    try {
      sourceUrl = normalizeSourceUrl(form.sourceUrl);
    } catch {
      fail(
        "recipe-source",
        "Escribe un enlace válido que empiece con http:// o https://.",
      );
    }

    const lines: RecipeIngredient[] = [];
    for (const line of form.lines) {
      const prefix = `line-${line.key}`;
      const blank =
        !line.query.trim() &&
        (line.kind === "unspecified" ||
          (line.kind === "measured"
            ? !line.quantity.trim()
            : !line.note.trim()));
      if (blank) continue;

      let ingredientId = line.ingredientId;
      if (!ingredientId) {
        const query = normalizeLookupText(line.query);
        const matches = query
          ? app
              .library()
              .ingredients.filter(
                (item) => normalizeLookupText(item.name) === query,
              )
          : [];
        const match = matches.length === 1 ? matches[0] : undefined;
        if (match) {
          ingredientId = match.id;
          patchLine(line.key, { ingredientId: match.id, query: match.name });
        } else {
          fail(
            `${prefix}-ingredient`,
            line.query.trim()
              ? "Elige un ingrediente de la lista o crea uno nuevo."
              : "Elige o crea el ingrediente de esta línea.",
          );
          continue;
        }
      }

      let amount: Amount | undefined;
      if (line.kind === "measured") {
        if (!line.quantity.trim()) {
          fail(
            `${prefix}-quantity`,
            "Escribe la cantidad o cambia el tipo a «Sin cantidad».",
          );
          continue;
        }
        try {
          amount = parseMeasuredAmount(line.quantity, line.unit);
        } catch (error) {
          console.error("Invalid quantity entered in the recipe form.", error);
          fail(
            `${prefix}-quantity`,
            "No entendimos esa cantidad. Usa números mayores que cero, fracciones o un rango de menor a mayor, como 2, 1/2, 1 1/2 o 2-3.",
          );
          continue;
        }
      } else if (line.kind === "qualitative") {
        if (!line.note.trim()) {
          fail(
            `${prefix}-note`,
            "Escribe una nota, por ejemplo «al gusto», o cambia el tipo de cantidad.",
          );
          continue;
        }
        amount = { kind: "qualitative", text: line.note.trim() };
      } else {
        amount = { kind: "unspecified" };
      }
      lines.push({ ingredientId, amount });
    }

    setErrors(Object.fromEntries(found.map((item) => [item.id, item.message])));
    if (found.length > 0) {
      setSummary({
        title: "Revisa estos campos antes de guardar",
        items: found,
      });
      return undefined;
    }

    const knownCategories = new Set(
      app.library().categories.map((category) => category.id),
    );
    return {
      draft: {
        ...(original ? { id: original.id } : {}),
        name,
        ...(sourceUrl === undefined ? {} : { sourceUrl }),
        ingredients: lines,
        steps: steps()
          .map((row) => row.text.trim())
          .filter(Boolean),
        categoryIds: form.categoryIds.filter((id) => knownCategories.has(id)),
        tags: [...form.tags],
        enteredPortions: portions,
      },
    };
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving()) return;
    flush();
    setSummary(undefined);

    const result = validate();
    if (!result) {
      flush();
      focusSelector("#form-summary");
      return;
    }

    const choice = photo();
    const photoArgument =
      choice.kind === "replace"
        ? choice.input
        : choice.kind === "remove"
          ? null
          : undefined;

    setSaving(true);
    const outcome = await app.saveRecipe(result.draft, photoArgument);
    setSaving(false);

    if (outcome.ok) {
      setDirty(false);
      app.notify(
        "success",
        isEditing ? "Cambios guardados." : "Receta guardada.",
      );
      navigate(paths.recipe(outcome.value.id));
      return;
    }

    setSummary({
      title: "No se pudo guardar la receta",
      items: [],
      detail: submitFailure,
    });
    flush();
    focusSelector("#form-summary");
  }

  async function cancel() {
    if (dirty()) {
      const discard = await app.confirm({
        title: "¿Descartar los cambios?",
        message: "Los cambios que no guardaste se perderán.",
        confirmLabel: "Descartar cambios",
        danger: true,
      });
      if (!discard) return;
    }
    setDirty(false);
    navigate(original ? paths.recipe(original.id) : paths.recipes);
  }

  // --- View ------------------------------------------------------------------------------------------

  return (
    <form
      class="recipe-form"
      novalidate
      onSubmit={(event) => void submit(event)}
      onInput={markDirty}
      aria-busy={saving() ? "true" : undefined}
    >
      <h1 tabindex="-1">
        {isEditing
          ? "Editar receta"
          : captured
            ? "Revisar receta"
            : "Nueva receta"}
      </h1>

      <Show when={captured}>
        <p class="hint">
          Revisa las cantidades, los ingredientes y los pasos antes de guardar.
        </p>
        <Show when={(captured?.notices?.length ?? 0) > 0}>
          <ul class="hint">
            <For each={captured?.notices ?? []}>
              {(notice) => <li>{notice}</li>}
            </For>
          </ul>
        </Show>
      </Show>

      <Show when={summary()} keyed>
        {(current) => (
          <section
            class="error-summary"
            id="form-summary"
            tabindex="-1"
            aria-labelledby="form-summary-title"
          >
            <h2 id="form-summary-title">{current.title}</h2>
            <Show when={current.detail}>
              <p>{current.detail}</p>
            </Show>
            <Show when={current.items.length > 0}>
              <ul>
                <For each={current.items}>
                  {(item) => (
                    <li>
                      <a
                        href={`#${item.id}`}
                        onClick={(event) => {
                          event.preventDefault();
                          focusSelector(`#${item.id}`);
                        }}
                      >
                        {item.message}
                      </a>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
        )}
      </Show>

      <section class="panel" aria-labelledby={`${ids}-basics`}>
        <h2 id={`${ids}-basics`}>Datos básicos</h2>
        <div class="field">
          <label for="recipe-name">
            Nombre <span class="required">(obligatorio)</span>
          </label>
          <input
            id="recipe-name"
            class="control"
            type="text"
            autocomplete="off"
            aria-required="true"
            aria-invalid={errors()["recipe-name"] ? "true" : undefined}
            aria-describedby={
              errors()["recipe-name"] ? "recipe-name-error" : undefined
            }
            value={form.name}
            onInput={(event) => {
              const value = event.currentTarget.value;
              setForm((draft) => {
                draft.name = value;
              });
              clearError("recipe-name");
            }}
          />
          <FieldError
            id="recipe-name-error"
            message={errors()["recipe-name"]}
          />
        </div>

        <div class="field field-narrow">
          <label for="recipe-portions">Porciones que rinde</label>
          <input
            id="recipe-portions"
            class="control"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            aria-describedby={
              errors()["recipe-portions"]
                ? "recipe-portions-error recipe-portions-hint"
                : "recipe-portions-hint"
            }
            aria-invalid={errors()["recipe-portions"] ? "true" : undefined}
            value={form.portions}
            onInput={(event) => {
              const value = event.currentTarget.value;
              setForm((draft) => {
                draft.portions = value;
              });
              if (needsPortionConfirmation) setPortionsConfirmed(false);
              clearError("recipe-portions");
            }}
          />
          <FieldError
            id="recipe-portions-error"
            message={errors()["recipe-portions"]}
          />
          <p class="hint" id="recipe-portions-hint">
            Escribe las cantidades para esta cantidad de porciones. La receta se
            guarda y se abre para {RECIPE_PORTIONS} porciones.
          </p>
          <Show when={needsPortionConfirmation}>
            <label class="check">
              <input
                id="recipe-confirm-portions"
                type="checkbox"
                checked={portionsConfirmed()}
                aria-describedby={
                  errors()["recipe-confirm-portions"]
                    ? "recipe-confirm-portions-error"
                    : undefined
                }
                onChange={(event) => {
                  setPortionsConfirmed(event.currentTarget.checked);
                  clearError("recipe-confirm-portions");
                }}
              />
              Confirmo las porciones indicadas
            </label>
            <FieldError
              id="recipe-confirm-portions-error"
              message={errors()["recipe-confirm-portions"]}
            />
          </Show>
        </div>

        <div class="field">
          <label for="recipe-source">
            Enlace de origen <span class="muted">(opcional)</span>
          </label>
          <input
            id="recipe-source"
            class="control"
            type="text"
            inputmode="url"
            autocomplete="off"
            autocapitalize="none"
            spellcheck={false}
            placeholder="https://"
            aria-invalid={errors()["recipe-source"] ? "true" : undefined}
            aria-describedby={
              errors()["recipe-source"] ? "recipe-source-error" : undefined
            }
            value={form.sourceUrl}
            onInput={(event) => {
              const value = event.currentTarget.value;
              setForm((draft) => {
                draft.sourceUrl = value;
              });
              clearError("recipe-source");
            }}
          />
          <FieldError
            id="recipe-source-error"
            message={errors()["recipe-source"]}
          />
        </div>

        <PhotoField
          existingPhotoId={original?.photoId}
          choice={photo()}
          onChange={(choice) => {
            setPhoto(choice);
            markDirty();
          }}
        />
      </section>

      <section class="panel" aria-labelledby={`${ids}-ingredients`}>
        <h2 id={`${ids}-ingredients`}>Ingredientes</h2>
        <p class="hint">
          Escribe para buscar en tu catálogo. Si no existe, créalo ahí mismo.
          Puedes dejar la cantidad vacía con «Sin cantidad».
        </p>
        <Show when={form.lines.length === 0}>
          <p class="empty-inline">Todavía no agregas ingredientes.</p>
        </Show>
        <ol class="line-list">
          <For each={form.lines}>
            {(line, index) => {
              const prefix = () => `line-${line.key}`;
              return (
                <li class="line-card">
                  <div class="line-head">
                    <h3>Ingrediente {index() + 1}</h3>
                    <button
                      type="button"
                      class="btn btn-quiet btn-small"
                      aria-label={`Quitar el ingrediente ${index() + 1}`}
                      onClick={() => removeLine(line.key)}
                      title={`Quitar el ingrediente ${index() + 1}`}
                    >
                      <ActionIcon name="delete" />
                      <span class="sr-only">Quitar</span>
                    </button>
                  </div>
                  <div class="field">
                    <label for={`${prefix()}-ingredient`}>Ingrediente</label>
                    <IngredientCombobox
                      id={`${prefix()}-ingredient`}
                      value={line.query}
                      selectedId={line.ingredientId}
                      ingredients={app.library().ingredients}
                      canCreate
                      invalid={Boolean(errors()[`${prefix()}-ingredient`])}
                      describedBy={
                        errors()[`${prefix()}-ingredient`]
                          ? `${prefix()}-ingredient-error`
                          : undefined
                      }
                      onInput={(text) => {
                        patchLine(line.key, { query: text, ingredientId: "" });
                        clearError(`${prefix()}-ingredient`);
                      }}
                      onPick={(ingredient) => {
                        patchLine(line.key, {
                          ingredientId: ingredient.id,
                          query: ingredient.name,
                        });
                        clearError(`${prefix()}-ingredient`);
                        markDirty();
                      }}
                      onCreate={(name) => createIngredient(line.key, name)}
                    />
                    <FieldError
                      id={`${prefix()}-ingredient-error`}
                      message={errors()[`${prefix()}-ingredient`]}
                    />
                  </div>

                  <div class="line-amount">
                    <div class="field">
                      <label for={`${prefix()}-kind`}>Tipo de cantidad</label>
                      <select
                        id={`${prefix()}-kind`}
                        class="control"
                        value={line.kind}
                        onChange={(event) => {
                          patchLine(line.key, {
                            kind: event.currentTarget.value as LineKind,
                          });
                          clearError(`${prefix()}-quantity`);
                          clearError(`${prefix()}-note`);
                          markDirty();
                        }}
                      >
                        <option value="measured">Con medida</option>
                        <option value="qualitative">Nota (al gusto…)</option>
                        <option value="unspecified">Sin cantidad</option>
                      </select>
                    </div>

                    <Switch>
                      <Match when={line.kind === "measured"}>
                        <div class="field">
                          <label for={`${prefix()}-quantity`}>Cantidad</label>
                          <input
                            id={`${prefix()}-quantity`}
                            class="control"
                            type="text"
                            inputmode="text"
                            autocomplete="off"
                            placeholder="1 1/2"
                            aria-invalid={
                              errors()[`${prefix()}-quantity`]
                                ? "true"
                                : undefined
                            }
                            aria-describedby={
                              errors()[`${prefix()}-quantity`]
                                ? `${prefix()}-quantity-error`
                                : `${prefix()}-quantity-hint`
                            }
                            value={line.quantity}
                            onInput={(event) => {
                              const value = event.currentTarget.value;
                              patchLine(line.key, { quantity: value });
                              clearError(`${prefix()}-quantity`);
                            }}
                          />
                        </div>
                        <div class="field">
                          <label for={`${prefix()}-unit`}>Unidad</label>
                          <select
                            id={`${prefix()}-unit`}
                            class="control"
                            value={line.unit}
                            onChange={(event) => {
                              patchLine(line.key, {
                                unit: event.currentTarget.value as UnitId,
                              });
                              markDirty();
                            }}
                          >
                            <For each={orderedUnits}>
                              {(unit) => (
                                <option value={unit}>
                                  {unitOptionLabel(unit)}
                                </option>
                              )}
                            </For>
                          </select>
                        </div>
                        <Show
                          when={errors()[`${prefix()}-quantity`]}
                          fallback={
                            <p
                              class="hint line-wide"
                              id={`${prefix()}-quantity-hint`}
                            >
                              {quantityHint}
                            </p>
                          }
                        >
                          <FieldError
                            id={`${prefix()}-quantity-error`}
                            message={errors()[`${prefix()}-quantity`]}
                          />
                        </Show>
                      </Match>
                      <Match when={line.kind === "qualitative"}>
                        <div class="field line-wide">
                          <label for={`${prefix()}-note`}>Nota</label>
                          <input
                            id={`${prefix()}-note`}
                            class="control"
                            type="text"
                            autocomplete="off"
                            list={`${ids}-notes`}
                            aria-invalid={
                              errors()[`${prefix()}-note`] ? "true" : undefined
                            }
                            aria-describedby={
                              errors()[`${prefix()}-note`]
                                ? `${prefix()}-note-error`
                                : undefined
                            }
                            value={line.note}
                            onInput={(event) => {
                              const value = event.currentTarget.value;
                              patchLine(line.key, { note: value });
                              clearError(`${prefix()}-note`);
                            }}
                          />
                          <FieldError
                            id={`${prefix()}-note-error`}
                            message={errors()[`${prefix()}-note`]}
                          />
                        </div>
                      </Match>
                      <Match when={line.kind === "unspecified"}>
                        <p class="hint line-wide">
                          Se mostrará solo el nombre del ingrediente.
                        </p>
                      </Match>
                    </Switch>
                  </div>
                </li>
              );
            }}
          </For>
        </ol>
        <datalist id={`${ids}-notes`}>
          <option value="al gusto" />
          <option value="opcional" />
          <option value="para decorar" />
          <option value="para freír" />
        </datalist>
        <button
          type="button"
          class="btn"
          id="add-line"
          onClick={addLine}
          title="+ Agregar ingrediente"
        >
          <ActionIcon name="add" />
          <span class="sr-only">+ Agregar ingrediente</span>
        </button>
      </section>

      <section class="panel" aria-labelledby={`${ids}-steps`}>
        <h2 id={`${ids}-steps`}>Pasos</h2>
        <ol class="step-list">
          <For each={steps()}>
            {(row, index) => (
              <li class="step-card">
                <div class="step-head">
                  <label for={`step-${row.key}`}>Paso {index() + 1}</label>
                  <div class="step-tools">
                    <button
                      type="button"
                      id={`step-${row.key}-up`}
                      class="btn btn-icon"
                      aria-label={`Subir el paso ${index() + 1}`}
                      disabled={index() === 0}
                      onClick={() => moveStep(row.key, -1)}
                      title={`Subir el paso ${index() + 1}`}
                    >
                      <ActionIcon name="up" />
                      <span class="sr-only">
                        <span aria-hidden="true">↑</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      id={`step-${row.key}-down`}
                      class="btn btn-icon"
                      aria-label={`Bajar el paso ${index() + 1}`}
                      disabled={index() === steps().length - 1}
                      onClick={() => moveStep(row.key, 1)}
                      title={`Bajar el paso ${index() + 1}`}
                    >
                      <ActionIcon name="down" />
                      <span class="sr-only">
                        <span aria-hidden="true">↓</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      class="btn btn-quiet btn-small"
                      aria-label={`Quitar el paso ${index() + 1}`}
                      onClick={() => removeStep(row.key)}
                      title={`Quitar el paso ${index() + 1}`}
                    >
                      <ActionIcon name="delete" />
                      <span class="sr-only">Quitar</span>
                    </button>
                  </div>
                </div>
                {/* The text lives in the DOM and in the row object, so typing never rebuilds the list. */}
                <textarea
                  id={`step-${row.key}`}
                  class="control"
                  rows={3}
                  value={row.text}
                  onInput={(event) => {
                    row.text = event.currentTarget.value;
                  }}
                />
              </li>
            )}
          </For>
        </ol>
        <button
          type="button"
          class="btn"
          id="add-step"
          onClick={addStep}
          title="+ Agregar paso"
        >
          <ActionIcon name="add" />
          <span class="sr-only">+ Agregar paso</span>
        </button>
        <p class="sr-only" role="status">
          {announcement()}
        </p>
      </section>

      <section class="panel" aria-labelledby={`${ids}-categories`}>
        <h2 id={`${ids}-categories`}>Categorías</h2>
        <fieldset class="check-group">
          <legend>{categoryKindLabels.dish_type}</legend>
          <Show
            when={dishTypes().length > 0}
            fallback={
              <p class="hint">
                Aún no hay tipos de platillo. Créalos en Categorías.
              </p>
            }
          >
            <For each={dishTypes()}>
              {(category) => (
                <label class="check">
                  <input
                    type="checkbox"
                    checked={form.categoryIds.includes(category.id)}
                    onChange={(event) =>
                      toggleCategory(category.id, event.currentTarget.checked)
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
          <Show
            when={cuisines().length > 0}
            fallback={
              <p class="hint">Aún no hay cocinas. Créalas en Categorías.</p>
            }
          >
            <For each={cuisines()}>
              {(category) => (
                <label class="check">
                  <input
                    type="checkbox"
                    checked={form.categoryIds.includes(category.id)}
                    onChange={(event) =>
                      toggleCategory(category.id, event.currentTarget.checked)
                    }
                  />
                  <span>{category.name}</span>
                </label>
              )}
            </For>
          </Show>
        </fieldset>
      </section>

      <section class="panel" aria-labelledby={`${ids}-tags`}>
        <h2 id={`${ids}-tags`}>Etiquetas</h2>
        <fieldset class="check-group">
          <legend>Etiquetas confirmadas</legend>
          <For each={orderedTags}>
            {(tag) => (
              <label class="check">
                <input
                  type="checkbox"
                  checked={form.tags.includes(tag)}
                  onChange={(event) => setTag(tag, event.currentTarget.checked)}
                />
                <span>{tagLabels[tag]}</span>
              </label>
            )}
          </For>
        </fieldset>
        <div class="suggestions">
          <Show when={suggestions().length > 0}>
            <p class="suggestions-title" id={`${ids}-suggested`}>
              Sugeridas según tus ingredientes (revísalas antes de confirmarlas)
            </p>
            <ul class="chip-row" aria-labelledby={`${ids}-suggested`}>
              <For each={suggestions()}>
                {(tag) => (
                  <li>
                    <button
                      type="button"
                      class="chip chip-suggest"
                      aria-label={`Confirmar la etiqueta ${tagLabels[tag]}`}
                      onClick={() => setTag(tag, true)}
                      title={`Confirmar la etiqueta ${tagLabels[tag]}`}
                    >
                      <ActionIcon name="confirm" />
                      <span class="sr-only">+ {tagLabels[tag]}</span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <Show when={suggestions().length > 1}>
              <button
                type="button"
                class="btn btn-quiet btn-small"
                onClick={() =>
                  suggestions().forEach((tag) => setTag(tag, true))
                }
                title="Confirmar todas las sugeridas"
              >
                <ActionIcon name="confirm" />
                <span class="sr-only">Confirmar todas las sugeridas</span>
              </button>
            </Show>
          </Show>
          <Show when={unresolvedLines()}>
            <p class="hint">
              Elige o crea todos los ingredientes para recibir sugerencias de
              etiquetas.
            </p>
          </Show>
          <Show when={!unresolvedLines() && unclassified().length > 0}>
            <p class="hint">
              Para sugerir etiquetas falta clasificar en el catálogo:{" "}
              {unclassified().join(", ")}.
            </p>
          </Show>
        </div>
      </section>

      <div class="form-actions">
        <button
          type="submit"
          class="btn btn-primary"
          disabled={saving()}
          title={
            saving()
              ? "Guardando…"
              : isEditing
                ? "Guardar cambios"
                : "Guardar receta"
          }
        >
          <ActionIcon name="save" />
          <span class="sr-only">
            {saving()
              ? "Guardando…"
              : isEditing
                ? "Guardar cambios"
                : "Guardar receta"}
          </span>
        </button>
        <button
          type="button"
          class="btn"
          disabled={saving()}
          onClick={() => void cancel()}
          title="Cancelar"
        >
          <ActionIcon name="close" />
          <span class="sr-only">Cancelar</span>
        </button>
      </div>
    </form>
  );
}
