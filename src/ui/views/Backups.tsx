import { ActionIcon } from "../components/ActionIcon";
import {
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onSettled,
  Show,
} from "solid-js";
import {
  backupRepository,
  BackupError,
  encodeBackup,
  planMerge,
  readBackup,
  suggestRecipeMatches,
} from "../../backup";
import type {
  IngredientOverride,
  MergeChoice,
  MergeConflict,
  PersonalSnapshot,
} from "../../backup";
import type { Density, Ingredient, RecipeIngredient } from "../../contracts";
import { formatMeasuredAmount, formatRational } from "../../domain";
import { formatManualAmount, formatQuantity } from "../../shopping/display";
import { buildShoppingList } from "../../shopping/workflow";
import { Modal } from "../components/Modal";
import {
  categoryKindLabels,
  classificationLabels,
  tagLabels,
  unitLabel,
} from "../text";

type RestoreBaseline = Awaited<
  ReturnType<typeof backupRepository.prepareRestore>
>;
type Preview = {
  name: string;
  snapshot: PersonalSnapshot;
  baseline: RestoreBaseline;
};

const labels: Record<MergeConflict["collection"], string> = {
  recipes: "Receta",
  categories: "Categoría",
  ingredients: "Ingrediente personal",
  ingredientOverrides: "Ajuste de ingrediente compartido",
  photos: "Foto",
  menu: "Lote del menú",
  shopping: "Lista de compras",
};

const number = new Intl.NumberFormat("es-MX");

export function Backups(props: { onRestored?: () => void | Promise<unknown> }) {
  const id = createUniqueId();
  const [busy, setBusy] = createSignal(false);
  const [preview, setPreview] = createSignal<Preview>();
  const [mode, setMode] = createSignal<"replace" | "merge">("merge");
  const [confirmReplace, setConfirmReplace] = createSignal(false);
  const [matches, setMatches] = createSignal(new Map<string, string>());
  const [choices, setChoices] = createSignal(new Map<string, MergeChoice>());
  const [error, setError] = createSignal("");
  const [status, setStatus] = createSignal("");
  const merge = createMemo(() => {
    const current = preview();
    return (
      current &&
      planMerge(
        current.baseline.local,
        current.snapshot,
        [...matches()].map(([localId, incomingId]) => ({
          localId,
          incomingId,
        })),
      )
    );
  });
  const suggestions = createMemo(() => {
    const current = preview();
    return current
      ? suggestRecipeMatches(current.baseline.local, current.snapshot)
      : [];
  });

  function resetChoices() {
    setMatches(new Map<string, string>());
    setChoices(new Map<string, MergeChoice>());
  }

  async function download() {
    if (busy()) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const backup = encodeBackup(await backupRepository.readSnapshot());
      const url = URL.createObjectURL(
        new Blob([backup], { type: "application/zip" }),
      );
      const link = document.createElement("a");
      link.href = url;
      const date = new Intl.DateTimeFormat("en-CA", {
        dateStyle: "short",
      }).format(new Date());
      link.download = `recetario-${date}.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setStatus("El respaldo ZIP está listo.");
    } catch (error) {
      setError(
        error instanceof BackupError && error.code === "limit"
          ? "Tu recetario supera el tamaño permitido para un respaldo."
          : "No pudimos crear el respaldo. Inténtalo de nuevo.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function inspect(file: File) {
    if (busy()) return;
    setBusy(true);
    setPreview(undefined);
    resetChoices();
    setMode("merge");
    setError("");
    setStatus("");

    try {
      const snapshot = await readBackup(file);
      const baseline = await backupRepository.prepareRestore();
      baseline.validate(snapshot);
      setPreview({ name: file.name, snapshot, baseline });
      setStatus(
        "El archivo es válido. Revisa el contenido antes de restaurarlo.",
      );
    } catch (error) {
      if (error instanceof BackupError && error.code === "version") {
        setError(
          "Esta versión del respaldo requiere una versión compatible de Recetario.",
        );
      } else if (error instanceof BackupError && error.code === "limit") {
        setError(
          "El archivo supera el tamaño permitido para restaurar un respaldo.",
        );
      } else {
        setError(
          "No pudimos validar el archivo. Elige un ZIP de respaldo de Recetario.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    const current = preview();
    if (busy() || !current) return;
    setBusy(true);
    setConfirmReplace(false);
    setError("");
    setStatus("");
    let snapshot: PersonalSnapshot;
    try {
      snapshot =
        mode() === "merge" ? merge()!.resolve(choices()) : current.snapshot;
      current.baseline.validate(snapshot);
    } catch (error) {
      setError(
        error instanceof BackupError && error.code === "conflicts"
          ? "Elige qué versión conservar en cada conflicto."
          : "Estas opciones dejan datos relacionados incompletos. Revisa qué versiones elegiste.",
      );
      setBusy(false);
      return;
    }

    try {
      await current.baseline.commit(snapshot);
      setPreview(undefined);
      setStatus("Se restauró el respaldo.");
      try {
        await props.onRestored?.();
      } catch {
        setStatus(
          "Se restauró el respaldo. Recarga la página para ver los cambios.",
        );
      }
    } catch (error) {
      if (error instanceof BackupError && error.code === "stale") {
        try {
          const baseline = await backupRepository.prepareRestore();
          setPreview({ ...current, baseline });
          resetChoices();
          setError(
            "Tu recetario cambió mientras revisabas el respaldo. Revisa la vista previa actualizada.",
          );
        } catch {
          setPreview(undefined);
          setError(
            "Tu recetario cambió. Vuelve a elegir el archivo para revisar el respaldo.",
          );
        }
      } else {
        setError("No pudimos guardar el respaldo. Tu recetario sigue intacto.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header class="page-head">
        <h1 tabindex="-1">Respaldos</h1>
      </header>
      <section class="panel" aria-labelledby={`${id}-export`}>
        <h2 id={`${id}-export`}>Descargar respaldo</h2>
        <p>
          Guarda tu recetario, menú y lista de compras en un archivo ZIP sin
          contraseña.
        </p>
        <button
          type="button"
          class="btn btn-primary"
          disabled={busy()}
          onClick={() => void download()}
          title="Descargar ZIP"
        >
          <ActionIcon name="download" />
          <span class="sr-only">Descargar ZIP</span>
        </button>
      </section>

      <section class="panel" aria-labelledby={`${id}-import`}>
        <h2 id={`${id}-import`}>Restaurar respaldo</h2>
        <div class="field">
          <label for={`${id}-file`}>Archivo de respaldo</label>
          <span class="file-picker">
            <input
              id={`${id}-file`}
              class="control"
              type="file"
              accept=".zip,application/zip"
              disabled={busy()}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void inspect(file);
              }}
            />
            <ActionIcon name="upload" />
          </span>
        </div>

        <div role="status">
          <Show when={status()}>{(message) => <p>{message()}</p>}</Show>
          <Show when={busy()}>
            <p>Procesando respaldo…</p>
          </Show>
        </div>
        <div role="alert">
          <Show when={error()}>
            {(message) => <p class="error-box">{message()}</p>}
          </Show>
        </div>

        <Show when={preview()} keyed>
          {(current) => (
            <>
              <h3>Vista previa</h3>
              <p>{current.name}</p>
              <ul>
                <li>
                  {number.format(current.snapshot.recipes.length)} recetas
                </li>
                <li>{number.format(current.snapshot.photos.length)} fotos</li>
                <li>
                  {number.format(current.snapshot.categories.length)} categorías
                </li>
                <li>
                  {number.format(current.snapshot.ingredients.length)}{" "}
                  ingredientes personales
                </li>
                <li>
                  {number.format(current.snapshot.ingredientOverrides.length)}{" "}
                  ajustes de ingredientes compartidos
                </li>
                <li>
                  {number.format(current.snapshot.menu.length)} lotes del menú
                </li>
                <Show when={current.snapshot.shopping}>
                  {(shopping) => (
                    <li>
                      {number.format(shopping().manualItems.length)} artículos
                      manuales en la lista de compras
                    </li>
                  )}
                </Show>
              </ul>
              <Show when={current.snapshot.recipes.length > 0}>
                <details>
                  <summary title="Ver nombres de las recetas">
                    <ActionIcon name="expand" />
                    <span class="sr-only">Ver nombres de las recetas</span>
                  </summary>
                  <ul>
                    <For each={current.snapshot.recipes}>
                      {(recipe) => <li>{recipe.name}</li>}
                    </For>
                  </ul>
                </details>
              </Show>

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (mode() === "replace") setConfirmReplace(true);
                  else void restore();
                }}
              >
                <fieldset disabled={busy()}>
                  <legend>Forma de restaurar</legend>
                  <label>
                    <input
                      type="radio"
                      name={`${id}-mode`}
                      checked={mode() === "merge"}
                      onChange={() => setMode("merge")}
                    />
                    Combinar con mi recetario
                  </label>
                  <label>
                    <input
                      type="radio"
                      name={`${id}-mode`}
                      checked={mode() === "replace"}
                      onChange={() => setMode("replace")}
                    />
                    Reemplazar mi recetario y menú
                  </label>
                </fieldset>

                <Show when={mode() === "merge"}>
                  <Show when={suggestions().length > 0}>
                    <details>
                      <summary title="Revisar recetas con el mismo nombre">
                        <ActionIcon name="expand" />
                        <span class="sr-only">
                          Revisar recetas con el mismo nombre
                        </span>
                      </summary>
                      <p>
                        Las recetas con el mismo nombre se conservan por
                        separado. Puedes indicar cuándo son la misma receta.
                      </p>
                      <For each={suggestions()}>
                        {(suggestion) => (
                          <label class="field">
                            «{suggestion.local.name}» en este dispositivo
                            <select
                              class="control"
                              value={matches().get(suggestion.local.id) ?? ""}
                              disabled={busy()}
                              onChange={(event) => {
                                const next = new Map(matches());
                                const incomingId = event.currentTarget.value;
                                if (incomingId)
                                  next.set(suggestion.local.id, incomingId);
                                else next.delete(suggestion.local.id);
                                setMatches(next);
                                setChoices(new Map<string, MergeChoice>());
                              }}
                            >
                              <option value="">Conservar por separado</option>
                              <For each={suggestion.incoming}>
                                {(candidate, index) => (
                                  <option
                                    value={candidate.id}
                                    disabled={[...matches()].some(
                                      ([localId, incomingId]) =>
                                        localId !== suggestion.local.id &&
                                        incomingId === candidate.id,
                                    )}
                                  >
                                    {candidate.name} ·{" "}
                                    {candidate.steps[0] ||
                                      `Receta ${index() + 1} del respaldo`}
                                  </option>
                                )}
                              </For>
                            </select>
                          </label>
                        )}
                      </For>
                    </details>
                  </Show>
                  <Show when={(merge()?.conflicts.length ?? 0) > 0}>
                    <h3>Elige qué versiones conservar</h3>
                    <ul class="planning-list">
                      <For
                        each={merge()?.conflicts}
                        keyed={(conflict) => conflict.key}
                      >
                        {(conflict) => (
                          <li class="panel">
                            <ConflictChoice
                              conflict={conflict()}
                              local={current.baseline.local}
                              incoming={current.snapshot}
                              value={choices().get(conflict().key)}
                              disabled={busy()}
                              onChoose={(choice) =>
                                setChoices(
                                  new Map(choices()).set(
                                    conflict().key,
                                    choice,
                                  ),
                                )
                              }
                            />
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </Show>

                <div class="actions actions-end">
                  <button
                    type="button"
                    class="btn"
                    disabled={busy()}
                    onClick={() => {
                      setPreview(undefined);
                      setStatus("");
                      setError("");
                    }}
                    title="Cancelar"
                  >
                    <ActionIcon name="close" />
                    <span class="sr-only">Cancelar</span>
                  </button>
                  <button
                    type="submit"
                    class="btn btn-primary"
                    disabled={busy()}
                    title={
                      mode() === "merge"
                        ? "Combinar respaldo"
                        : "Continuar con el reemplazo"
                    }
                  >
                    <ActionIcon name="download" />
                    <span class="sr-only">
                      {mode() === "merge"
                        ? "Combinar respaldo"
                        : "Continuar con el reemplazo"}
                    </span>
                  </button>
                </div>
              </form>
            </>
          )}
        </Show>
      </section>
      <Show when={confirmReplace()}>
        <Modal
          title="¿Reemplazar tus datos con este respaldo?"
          onClose={() => setConfirmReplace(false)}
        >
          <p>
            Se reemplazarán tus recetas, fotos, categorías, ingredientes
            personales, ajustes, menú y lista de compras con los datos del
            respaldo.
          </p>
          <div class="actions actions-end">
            <button
              type="button"
              class="btn"
              autofocus
              onClick={() => setConfirmReplace(false)}
              title="Cancelar"
            >
              <ActionIcon name="close" />
              <span class="sr-only">Cancelar</span>
            </button>
            <button
              type="button"
              class="btn btn-danger"
              onClick={() => void restore()}
              title="Reemplazar con el respaldo"
            >
              <ActionIcon name="download" />
              <span class="sr-only">Reemplazar con el respaldo</span>
            </button>
          </div>
        </Modal>
      </Show>
    </>
  );
}

function ingredientName(snapshot: PersonalSnapshot, id: string): string {
  return (
    snapshot.ingredientOverrides.find((item) => item.id === id)?.name ??
    snapshot.ingredients.find((item) => item.id === id)?.name ??
    snapshot.sharedIngredients.find((item) => item.id === id)?.name ??
    id
  );
}

function ingredientText(
  item: Ingredient | IngredientOverride,
  snapshot: PersonalSnapshot,
): string[] {
  const densityText = (density: Density) =>
    `${formatRational(density.gramsPerMilliliter, true)} g/ml · ${density.source}`;
  return [
    item.name ?? ingredientName(snapshot, item.id),
    ...(item.parentId === undefined
      ? []
      : [
          item.parentId
            ? `Variante de ${ingredientName(snapshot, item.parentId)}`
            : "Sin ingrediente principal",
        ]),
    ...(item.classification === undefined
      ? []
      : [
          item.classification
            ? classificationLabels[item.classification]
            : "Sin clasificación",
        ]),
    ...(item.density === undefined
      ? []
      : [item.density ? densityText(item.density) : "Sin equivalencia"]),
  ];
}

function describeLine(
  line: RecipeIngredient & { name?: string },
  snapshot: PersonalSnapshot,
): string {
  const { amount } = line;
  const name = line.name ?? ingredientName(snapshot, line.ingredientId);
  if (amount.kind === "unspecified") return name;
  const quantity =
    amount.kind === "qualitative"
      ? amount.text
      : `${formatMeasuredAmount(amount)} ${unitLabel(amount.unit, amount.max ?? amount.min)}`;
  return `${name} · ${quantity}`;
}

function PhotoPreview(props: { photo: PersonalSnapshot["photos"][number] }) {
  const [url, setUrl] = createSignal<string>();
  onSettled(() => {
    const photo = props.photo;
    const source = URL.createObjectURL(
      new Blob([photo.bytes], { type: photo.mimeType }),
    );
    setUrl(source);
    return () => URL.revokeObjectURL(source);
  });
  return <img width="120" src={url()} alt="Foto de la receta" loading="lazy" />;
}

function describe(
  conflict: MergeConflict,
  side: MergeChoice,
  snapshot: PersonalSnapshot,
): string[] {
  switch (conflict.collection) {
    case "shopping": {
      const { manualItems, balances, checked } = conflict[side];
      const catalog = new Map(
        snapshot.ingredients.map((ingredient) => [ingredient.id, ingredient]),
      );
      const names = new Map(
        buildShoppingList(snapshot.menu, manualItems, catalog).map(
          ({ id, name }) => [id, name],
        ),
      );
      const nameOf = (id: string) =>
        names.get(id) ?? "Artículo de un menú anterior";
      return [
        ...manualItems.map(
          ({ name, amount }) => `${name} · ${formatManualAmount(amount)}`,
        ),
        ...balances.flatMap(({ groupId, unit, bought, onHand }) => [
          ...(bought
            ? [
                `${nameOf(groupId)} · Comprado ${formatQuantity({ kind: "measured", min: bought, unit })}`,
              ]
            : []),
          ...(onHand
            ? [
                `${nameOf(groupId)} · En casa ${formatQuantity({ kind: "measured", min: onHand, unit })}`,
              ]
            : []),
        ]),
        ...checked.map(
          ({ groupId, note }) =>
            `${nameOf(groupId)} · Comprado${note ? ` (${note})` : ""}`,
        ),
      ];
    }
    case "recipes": {
      const row = conflict[side];
      if (!row) return [];
      const categories = row.categoryIds.map(
        (id) => snapshot.categories.find((item) => item.id === id)?.name ?? id,
      );
      return [
        row.name,
        ...row.ingredients.map((line) => describeLine(line, snapshot)),
        ...row.steps.map((step, index) => `${index + 1}. ${step}`),
        ...categories,
        ...row.tags.map((tag) => tagLabels[tag]),
        ...(row.sourceUrl ? [row.sourceUrl] : []),
      ];
    }
    case "menu": {
      const row = conflict[side];
      return row
        ? [
            row.name,
            `${number.format(row.portions)} porciones`,
            ...row.ingredients.map((line) => describeLine(line, snapshot)),
          ]
        : [];
    }
    case "categories": {
      const row = conflict[side];
      return row ? [row.name, categoryKindLabels[row.kind]] : [];
    }
    case "ingredients": {
      const row = conflict[side];
      return row ? ingredientText(row, snapshot) : [];
    }
    case "ingredientOverrides": {
      const row = conflict[side];
      if (!row) return ["Usar los datos del catálogo"];
      if (row.hidden)
        return [ingredientName(snapshot, row.id), "Ocultar este ingrediente"];
      return ingredientText(row, snapshot);
    }
    case "photos": {
      const row = conflict[side];
      if (!row) return [];
      const recipe = snapshot.recipes.find((item) => item.photoId === row.id);
      return [
        ...(recipe ? [recipe.name] : []),
        `${row.width} × ${row.height} px`,
      ];
    }
  }
}

function ConflictChoice(props: {
  conflict: MergeConflict;
  local: PersonalSnapshot;
  incoming: PersonalSnapshot;
  value?: MergeChoice;
  disabled: boolean;
  onChoose: (choice: MergeChoice) => void;
}) {
  const id = createUniqueId();
  return (
    <fieldset disabled={props.disabled}>
      <legend>{labels[props.conflict.collection]}</legend>
      <For each={["local", "incoming"] as const}>
        {(side) => {
          const snapshot = () =>
            side === "local" ? props.local : props.incoming;
          const contents = createMemo(() =>
            describe(props.conflict, side, snapshot()),
          );
          const photo = createMemo(() => {
            const conflict = props.conflict;
            if (conflict.collection === "photos") return conflict[side];
            if (conflict.collection !== "recipes") return;
            const photoId = conflict[side]?.photoId;
            return snapshot().photos.find((item) => item.id === photoId);
          });
          return (
            <div>
              <label>
                <input
                  type="radio"
                  name={id}
                  checked={props.value === side}
                  onChange={() => props.onChoose(side)}
                />
                {side === "local"
                  ? "Conservar en este dispositivo"
                  : "Usar la versión del respaldo"}
                {contents()[0] ? ` · ${contents()[0]}` : ""}
              </label>
              <Show when={contents().length > 1 || photo()}>
                <details>
                  <summary title="Ver detalles">
                    <ActionIcon name="expand" />
                    <span class="sr-only">Ver detalles</span>
                  </summary>
                  <ul>
                    <For each={contents()}>{(item) => <li>{item}</li>}</For>
                  </ul>
                  <Show when={photo()} keyed>
                    {(item) => <PhotoPreview photo={item} />}
                  </Show>
                </details>
              </Show>
            </div>
          );
        }}
      </For>
    </fieldset>
  );
}
