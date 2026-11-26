import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { Ingredient } from "../../contracts";
import { normalizeLookupText } from "../../domain";
import { compareNames } from "../text";

type Item = { kind: "ingredient"; ingredient: Ingredient; parentName?: string } | { kind: "create"; name: string };

type Props = {
  /** The input's ID. The caller renders the `<label for>` that names it. */
  id: string;
  value: string;
  selectedId?: string;
  ingredients: Ingredient[];
  placeholder?: string;
  invalid?: boolean;
  describedBy?: string;
  /** Offers `Crear «nombre»` when no catalog entry matches exactly. */
  canCreate: boolean;
  /** Clears the text after a pick. Used by filters that collect several choices. */
  clearOnSelect?: boolean;
  onInput: (text: string) => void;
  onPick: (ingredient: Ingredient) => void;
  onCreate: (name: string) => Promise<void>;
};

const maxResults = 8;

export function IngredientCombobox(props: Props) {
  const [open, setOpen] = createSignal(false);
  const [active, setActive] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const listId = () => `${props.id}-list`;
  const optionId = (index: number) => `${props.id}-option-${index}`;

  const exactMatch = createMemo(() => {
    const query = normalizeLookupText(props.value);
    return query ? props.ingredients.find((item) => normalizeLookupText(item.name) === query) : undefined;
  });

  const items = createMemo<Item[]>(() => {
    const query = normalizeLookupText(props.value);
    const names = new Map(props.ingredients.map((item) => [item.id, item.name]));
    const matches = props.ingredients
      .filter((item) => !query || normalizeLookupText(item.name).includes(query))
      .sort((a, b) => {
        const aStarts = normalizeLookupText(a.name).startsWith(query) ? 0 : 1;
        const bStarts = normalizeLookupText(b.name).startsWith(query) ? 0 : 1;
        return aStarts - bStarts || compareNames(a.name, b.name);
      })
      .slice(0, maxResults)
      .map<Item>((ingredient) => ({
        kind: "ingredient",
        ingredient,
        parentName: ingredient.parentId ? names.get(ingredient.parentId) : undefined,
      }));
    const name = props.value.trim().replace(/\s+/gu, " ");
    if (props.canCreate && name && !exactMatch()) matches.push({ kind: "create", name });
    return matches;
  });

  const expanded = () => open() && items().length > 0;
  const activeIndex = () => Math.max(0, Math.min(active(), items().length - 1));
  const activeId = () => (expanded() ? optionId(activeIndex()) : undefined);

  createEffect(activeId, (id) => {
    if (id) document.getElementById(id)?.scrollIntoView({ block: "nearest" });
  });

  const status = () => {
    if (!open()) return "";
    const count = items().length;
    if (count === 0) return "Sin coincidencias.";
    const last = items()[count - 1];
    const create = last?.kind === "create" ? " Puedes crear un ingrediente nuevo." : "";
    return `${count === 1 ? "1 opción" : `${count} opciones`} disponibles.${create}`;
  };

  async function choose(item: Item | undefined) {
    if (!item || busy()) return;
    setOpen(false);
    if (item.kind === "ingredient") {
      props.onPick(item.ingredient);
      return;
    }
    setBusy(true);
    try {
      await props.onCreate(item.name);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open()) setOpen(true);
        else setActive(Math.min(activeIndex() + 1, items().length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!open()) setOpen(true);
        else setActive(Math.max(activeIndex() - 1, 0));
        break;
      case "Enter":
        if (expanded()) {
          event.preventDefault();
          void choose(items()[activeIndex()]);
        }
        break;
      case "Escape":
        if (open()) {
          event.preventDefault();
          setOpen(false);
        }
        break;
    }
  }

  function onBlur() {
    setOpen(false);
    const match = exactMatch();
    if (!props.clearOnSelect && match && match.id !== props.selectedId) props.onPick(match);
  }

  return (
    <div class="combobox">
      <input
        id={props.id}
        type="text"
        role="combobox"
        class="control"
        autocomplete="off"
        autocapitalize="sentences"
        spellcheck={false}
        aria-autocomplete="list"
        aria-expanded={expanded() ? "true" : "false"}
        aria-controls={listId()}
        aria-activedescendant={activeId()}
        aria-invalid={props.invalid ? "true" : undefined}
        aria-describedby={props.describedBy}
        aria-busy={busy() ? "true" : undefined}
        placeholder={props.placeholder}
        readonly={busy()}
        value={props.value}
        onFocus={() => {
          if (!props.selectedId && props.value.trim()) {
            setActive(0);
            setOpen(true);
          }
        }}
        onInput={(event) => {
          props.onInput(event.currentTarget.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      <Show when={expanded()}>
        <ul id={listId()} role="listbox" class="combobox-list">
          <For each={items()}>
            {(item, index) => (
              <li
                id={optionId(index())}
                role="option"
                aria-selected={index() === activeIndex() ? "true" : "false"}
                class={["combobox-option", { "is-active": index() === activeIndex(), "is-create": item.kind === "create" }]}
                // Keep focus in the input so the list does not close before the click lands.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void choose(item)}
              >
                {item.kind === "create" ? (
                  <span>
                    Crear ingrediente nuevo: <strong>«{item.name}»</strong>
                  </span>
                ) : (
                  <>
                    <span>{item.ingredient.name}</span>
                    <Show when={item.parentName}>
                      <small class="muted"> · tipo de {item.parentName}</small>
                    </Show>
                  </>
                )}
              </li>
            )}
          </For>
        </ul>
      </Show>
      <span class="sr-only" role="status">
        {status()}
      </span>
    </div>
  );
}
