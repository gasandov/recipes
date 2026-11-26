import { ActionIcon } from "../components/ActionIcon";
import {
  createMemo,
  createSignal,
  createUniqueId,
  flush,
  For,
  onSettled,
  Show,
} from "solid-js";
import {
  createShoppingSnapshot,
  formatManualAmount,
} from "../../shopping/display";
import { ManualItemForm } from "../../shopping/forms";
import { activeShoppingRepository } from "../../shopping/repository";
import { MeasuredRow, UnmeasuredRow } from "../../shopping/rows";
import type { SaveShoppingChange } from "../../shopping/rows";
import {
  buildShoppingList,
  emptyShoppingState,
  removeManualItem,
  resetShoppingProgress,
  saveManualItem,
} from "../../shopping/workflow";
import type { ManualItem } from "../../shopping/workflow";
import { Modal } from "../components/Modal";
import { paths } from "../router";
import { compareNames } from "../text";
import { useApp } from "../use-app";
import "../../shopping/shopping.css";

export function ShoppingList() {
  const app = useApp();
  const [state, setState] = createSignal(emptyShoppingState());
  const [loadError, setLoadError] = createSignal(false);
  const [manual, setManual] = createSignal<{ item?: ManualItem }>();
  const [snapshot, setSnapshot] = createSignal<string>();
  const [resetting, setResetting] = createSignal(false);
  const catalog = createMemo(() =>
    [...app.ingredientsById().values()].sort((a, b) =>
      compareNames(a.name, b.name),
    ),
  );
  const groups = createMemo(() =>
    buildShoppingList(
      app.menu(),
      state().manualItems,
      app.ingredientsById(),
    ).sort((a, b) => compareNames(a.name, b.name)),
  );
  const hasProgress = () =>
    state().balances.length > 0 || state().checked.length > 0;

  let readId = 0;
  async function refresh() {
    const id = ++readId;
    try {
      const stored = await activeShoppingRepository.read();
      if (id !== readId) return;
      setState(stored);
      setLoadError(false);
    } catch {
      if (id === readId) setLoadError(true);
    }
  }

  onSettled(() => {
    const unsubscribe = activeShoppingRepository.subscribe(
      () => void refresh(),
    );
    void refresh();
    return () => {
      readId++;
      unsubscribe();
    };
  });

  const save: SaveShoppingChange = async (change) => {
    try {
      await activeShoppingRepository.update(change);
      await refresh();
      return true;
    } catch {
      app.notify(
        "error",
        "No se pudieron guardar los cambios de la lista. Inténtalo de nuevo.",
      );
      return false;
    }
  };

  async function reset() {
    if (resetting()) return;
    setResetting(true);
    const accepted = await app.confirm({
      title: "¿Restablecer el progreso de compras?",
      message:
        "Se borrarán las marcas de compra y las cantidades compradas o que tienes en casa.",
      confirmLabel: "Restablecer progreso",
      danger: true,
    });
    setResetting(false);
    if (accepted && (await save(resetShoppingProgress))) {
      app.notify("success", "Se restableció el progreso de compras.");
      restoreFocus();
    }
  }

  async function share() {
    const title = "Lista de compras";
    const text = createShoppingSnapshot(groups(), state());
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title, text });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
      }
    }
    setSnapshot(text);
  }

  function restoreFocus() {
    flush();
    if (document.activeElement === document.body)
      document.getElementById("shopping-heading")?.focus();
  }

  return (
    <div class="shopping-view">
      <header class="page-head">
        <h1 id="shopping-heading" tabindex="-1">
          Lista de compras
        </h1>
        <a class="btn" href={paths.menu} title="Ver menú">
          <ActionIcon name="menu" />
          <span class="sr-only">Ver menú</span>
        </a>
      </header>
      <div class="actions shopping-toolbar">
        <button
          type="button"
          class="btn btn-primary"
          onClick={() => setManual({})}
          title="Agregar artículo manual"
        >
          <ActionIcon name="add" />
          <span class="sr-only">Agregar artículo manual</span>
        </button>
        <Show when={groups().length > 0}>
          <button
            type="button"
            class="btn"
            onClick={() => void share()}
            title="Compartir lista"
          >
            <ActionIcon name="share" />
            <span class="sr-only">Compartir lista</span>
          </button>
        </Show>
        <Show when={hasProgress()}>
          <button
            type="button"
            class="btn btn-danger-quiet"
            aria-disabled={resetting() ? "true" : undefined}
            onClick={() => void reset()}
            title="Restablecer progreso"
          >
            <ActionIcon name="retry" />
            <span class="sr-only">Restablecer progreso</span>
          </button>
        </Show>
      </div>
      <Show when={loadError()}>
        <p role="alert" class="error-box">
          No se pudo abrir el progreso guardado de la lista de compras.
        </p>
      </Show>
      <Show
        when={groups().length > 0}
        fallback={
          <section class="empty-state">
            <h2>Aún no hay ingredientes para comprar</h2>
            <p>
              {app.menu().length === 0
                ? "Agrega recetas a tu menú para armar la lista."
                : "Ninguno de los lotes del menú tiene ingredientes."}
            </p>
          </section>
        }
      >
        <ul class="planning-list">
          <For each={groups()} keyed={(group) => group.id}>
            {(group) => (
              <li class="panel shopping-ingredient">
                <h2>{group().name}</h2>
                <Show
                  when={
                    group().ingredientId !== undefined &&
                    group().fromMenu &&
                    !app.ingredientsById().has(group().ingredientId ?? "")
                  }
                >
                  <p class="hint">
                    Guardado en el menú. Ya no está en el catálogo.
                  </p>
                </Show>
                <Show when={group().manualItems.length > 0}>
                  <ul
                    class="shopping-manual-items"
                    aria-label="Artículos manuales"
                  >
                    <For each={group().manualItems} keyed={(item) => item.id}>
                      {(item, index) => {
                        const description = () =>
                          `${group().name}, ${formatManualAmount(item().amount)}${group().manualItems.length > 1 ? `, artículo ${index() + 1}` : ""}`;
                        return (
                          <li class="shopping-manual-item">
                            <span>
                              Manual · {formatManualAmount(item().amount)}
                            </span>
                            <div class="actions">
                              <button
                                type="button"
                                class="btn btn-small"
                                aria-label={`Editar artículo manual · ${description()}`}
                                onClick={() => setManual({ item: item() })}
                                title={`Editar artículo manual · ${description()}`}
                              >
                                <ActionIcon name="edit" />
                                <span class="sr-only">Editar</span>
                              </button>
                              <button
                                type="button"
                                class="btn btn-danger-quiet btn-small"
                                aria-label={`Quitar artículo manual · ${description()}`}
                                onClick={async () => {
                                  const id = item().id;
                                  if (
                                    await save((current) =>
                                      removeManualItem(current, id),
                                    )
                                  ) {
                                    app.notify(
                                      "success",
                                      "Se quitó el artículo manual.",
                                    );
                                    restoreFocus();
                                  }
                                }}
                                title={`Quitar artículo manual · ${description()}`}
                              >
                                <ActionIcon name="delete" />
                                <span class="sr-only">Quitar</span>
                              </button>
                            </div>
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </Show>
                <For
                  each={group().lines.filter(
                    (line) => line.kind === "measured",
                  )}
                  keyed={(line) => line.id}
                >
                  {(line) => (
                    <MeasuredRow
                      name={group().name}
                      line={line()}
                      state={state()}
                      save={save}
                      multiple={
                        group().lines.filter((item) => item.kind === "measured")
                          .length > 1
                      }
                    />
                  )}
                </For>
                <For
                  each={group().lines.filter(
                    (line) => line.kind === "unmeasured",
                  )}
                  keyed={(line) => line.id}
                >
                  {(line) => (
                    <UnmeasuredRow
                      name={group().name}
                      line={line()}
                      state={state()}
                      save={save}
                    />
                  )}
                </For>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={manual()}>
        {(form) => (
          <ManualItemForm
            item={form().item}
            ingredients={catalog()}
            close={() => {
              setManual(undefined);
              restoreFocus();
            }}
            save={(item) => save((current) => saveManualItem(current, item))}
          />
        )}
      </Show>
      <Show when={snapshot()}>
        {(text) => (
          <ShareSnapshot text={text()} close={() => setSnapshot(undefined)} />
        )}
      </Show>
    </div>
  );
}

function ShareSnapshot(props: { text: string; close: () => void }) {
  const id = createUniqueId();
  const [message, setMessage] = createSignal("");
  let field: HTMLTextAreaElement | undefined;
  async function copy() {
    try {
      await navigator.clipboard.writeText(props.text);
      setMessage("Lista copiada.");
    } catch {
      field?.focus();
      field?.select();
      setMessage(
        "Seleccionamos la lista. Usa la opción de copiar de tu dispositivo.",
      );
    }
  }

  return (
    <Modal title="Compartir lista" onClose={props.close}>
      <p class="hint">Envía una copia de las cantidades que faltan.</p>
      <label for={id}>Texto para compartir</label>
      <textarea
        id={id}
        ref={(element) => (field = element)}
        class="control shopping-share-text"
        value={props.text}
        readonly
      />
      <div class="actions shopping-dialog-actions">
        <button
          type="button"
          class="btn btn-primary"
          onClick={() => void copy()}
          title="Copiar texto"
        >
          <ActionIcon name="copy" />
          <span class="sr-only">Copiar texto</span>
        </button>
        <button type="button" class="btn" onClick={props.close} title="Cerrar">
          <ActionIcon name="close" />
          <span class="sr-only">Cerrar</span>
        </button>
      </div>
      <p role="status">{message()}</p>
    </Modal>
  );
}
