import { ActionIcon } from "../ui/components/ActionIcon";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import type { Amount, Ingredient, Rational, UnitId } from "../contracts";
import {
  formatMeasuredAmount,
  formatRational,
  parseMeasuredAmount,
  parseRational,
  usesDensity,
} from "../domain";
import { FieldError } from "../ui/components/FieldError";
import { Modal } from "../ui/components/Modal";
import { orderedUnits, unitOptionLabel } from "../ui/text";
import { balanceForUnit } from "./workflow";
import type { ManualItem, ShoppingState } from "./workflow";

type UnitSelectProps = {
  id: string;
  value: UnitId;
  options: readonly UnitId[];
  onChange: (unit: UnitId) => void;
};

export function UnitSelect(props: UnitSelectProps) {
  return (
    <select
      id={props.id}
      class="control"
      value={props.value}
      onChange={(event) => props.onChange(event.currentTarget.value as UnitId)}
    >
      <For each={props.options}>
        {(unit) => <option value={unit}>{unitOptionLabel(unit)}</option>}
      </For>
    </select>
  );
}

type ManualFormProps = {
  item?: ManualItem;
  ingredients: Ingredient[];
  close: () => void;
  save: (item: ManualItem) => Promise<boolean>;
};

export function ManualItemForm(props: ManualFormProps) {
  const id = createUniqueId();
  const [ingredientId, setIngredientId] = createSignal(
    props.item?.ingredientId,
  );
  const ingredient = () =>
    props.ingredients.find((item) => item.id === ingredientId());
  const [name, setName] = createSignal(props.item?.name ?? "");
  const [kind, setKind] = createSignal<Amount["kind"]>(
    props.item?.amount.kind ?? "unspecified",
  );
  const initial = props.item?.amount;
  const [unit, setUnit] = createSignal<UnitId>(
    initial?.kind === "measured" ? initial.unit : "piece",
  );
  const [quantity, setQuantity] = createSignal(
    initial?.kind === "measured" ? formatMeasuredAmount(initial) : "",
  );
  const [note, setNote] = createSignal(
    initial?.kind === "qualitative" ? initial.text : "",
  );
  const [error, setError] = createSignal<string>();
  const [submitting, setSubmitting] = createSignal(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (submitting()) return;
    const itemName = ingredient()?.name ?? name().trim();
    if (!itemName) {
      setError("Escribe el nombre del artículo.");
      return;
    }
    let amount: Amount = { kind: "unspecified" };
    if (kind() === "measured") {
      try {
        amount = parseMeasuredAmount(quantity(), unit());
      } catch {
        setError(
          "Escribe una cantidad mayor que cero, una fracción o un rango válido.",
        );
        return;
      }
    } else if (kind() === "qualitative") {
      if (!note().trim()) {
        setError("Escribe un detalle para la cantidad.");
        return;
      }
      amount = { kind: "qualitative", text: note().trim() };
    }
    setSubmitting(true);
    const saved = await props.save({
      id: props.item?.id ?? crypto.randomUUID(),
      name: itemName,
      ingredientId: ingredientId(),
      amount,
    });
    setSubmitting(false);
    if (saved) props.close();
  }

  return (
    <Modal
      title={props.item ? "Editar artículo manual" : "Agregar artículo manual"}
      onClose={props.close}
    >
      <form
        onSubmit={submit}
        aria-describedby={error() ? `${id}-error` : undefined}
      >
        <div class="field">
          <label for={`${id}-ingredient`}>Vincular con un ingrediente</label>
          <select
            id={`${id}-ingredient`}
            class="control"
            value={ingredientId() ?? ""}
            onChange={(event) =>
              setIngredientId(event.currentTarget.value || undefined)
            }
          >
            <option value="">Artículo independiente</option>
            <Show when={ingredientId() && !ingredient()}>
              <option value={ingredientId()}>
                {props.item?.name} (ya no está en el catálogo)
              </option>
            </Show>
            <For each={props.ingredients} keyed={(item) => item.id}>
              {(item) => <option value={item().id}>{item().name}</option>}
            </For>
          </select>
        </div>
        <Show when={ingredientId() === undefined}>
          <div class="field">
            <label for={`${id}-name`}>Nombre del artículo</label>
            <input
              id={`${id}-name`}
              class="control"
              value={name()}
              required
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </div>
        </Show>
        <div class="field">
          <label for={`${id}-kind`}>Tipo de cantidad</label>
          <select
            id={`${id}-kind`}
            class="control"
            value={kind()}
            onChange={(event) =>
              setKind(event.currentTarget.value as Amount["kind"])
            }
          >
            <option value="unspecified">Sin cantidad</option>
            <option value="measured">Con medida</option>
            <option value="qualitative">Con una nota</option>
          </select>
        </div>
        <Show when={kind() === "measured"}>
          <div class="shopping-fields">
            <div class="field">
              <label for={`${id}-quantity`}>Cantidad</label>
              <input
                id={`${id}-quantity`}
                class="control"
                value={quantity()}
                placeholder="Ej. 1 1/2 o 2–3"
                required
                onInput={(event) => setQuantity(event.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label for={`${id}-unit`}>Unidad</label>
              <UnitSelect
                id={`${id}-unit`}
                value={unit()}
                options={orderedUnits}
                onChange={setUnit}
              />
            </div>
          </div>
        </Show>
        <Show when={kind() === "qualitative"}>
          <div class="field">
            <label for={`${id}-note`}>Nota sobre la cantidad</label>
            <input
              id={`${id}-note`}
              class="control"
              value={note()}
              placeholder="Ej. al gusto"
              required
              onInput={(event) => setNote(event.currentTarget.value)}
            />
          </div>
        </Show>
        <div role="alert">
          <FieldError id={`${id}-error`} message={error()} />
        </div>
        <div class="actions shopping-dialog-actions">
          <button
            type="submit"
            class="btn btn-primary"
            aria-disabled={submitting() ? "true" : undefined}
            title="Guardar artículo"
          >
            <ActionIcon name="save" />
            <span class="sr-only">Guardar artículo</span>
          </button>
          <button
            type="button"
            class="btn"
            onClick={props.close}
            title="Cancelar"
          >
            <ActionIcon name="close" />
            <span class="sr-only">Cancelar</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}

type BalanceFormProps = {
  name: string;
  groupId: string;
  initialUnit: UnitId;
  options: readonly UnitId[];
  state: ShoppingState;
  close: () => void;
  save: (
    unit: UnitId,
    balance: { bought?: Rational; onHand?: Rational },
  ) => Promise<boolean>;
};

function parseBalance(input: string): Rational | undefined {
  const value = input.trim();
  if (!value || /^(?:0+(?:[.,]0+)?|[.,]0+)$/.test(value)) return undefined;
  return parseRational(value);
}

export function BalanceForm(props: BalanceFormProps) {
  const id = createUniqueId();
  const [unit, setUnit] = createSignal(props.initialUnit);
  const stored = () => balanceForUnit(props.state, props.groupId, unit());
  const [bought, setBought] = createSignal<string>();
  const [onHand, setOnHand] = createSignal<string>();
  const [error, setError] = createSignal<"bought" | "onHand">();
  const asInput = (value: Rational | undefined) =>
    value ? formatRational(value) : "";
  const boughtInput = () => bought() ?? asInput(stored().bought);
  const onHandInput = () => onHand() ?? asInput(stored().onHand);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    let field: "bought" | "onHand" = "bought";
    const balance: Parameters<BalanceFormProps["save"]>[1] = {};
    try {
      if (bought() !== undefined) balance.bought = parseBalance(boughtInput());
      field = "onHand";
      if (onHand() !== undefined) balance.onHand = parseBalance(onHandInput());
    } catch {
      setError(field);
      document.getElementById(`${id}-${field}`)?.focus();
      return;
    }
    if (
      (bought() === undefined && onHand() === undefined) ||
      (await props.save(unit(), balance))
    )
      props.close();
  }

  function changeUnit(next: UnitId) {
    setUnit(next);
    setError(undefined);
  }

  return (
    <Modal title={`Editar cantidades de ${props.name}`} onClose={props.close}>
      <form onSubmit={submit}>
        <p class="hint" id={`${id}-hint`}>
          Escribe cuánto llevas comprado y cuánto tienes en casa. Usa 0 o deja
          el campo vacío para quitar una cantidad.
        </p>
        <div class="field">
          <label for={`${id}-unit`}>Unidad para registrar cantidades</label>
          <UnitSelect
            id={`${id}-unit`}
            value={unit()}
            options={props.options}
            onChange={changeUnit}
          />
          <Show
            when={props.options.some((option) => usesDensity(unit(), option))}
          >
            <p class="hint">
              Elige una unidad de peso o de volumen para consultar y editar su
              registro.
            </p>
          </Show>
        </div>
        <div class="shopping-fields">
          <div class="field">
            <label for={`${id}-bought`}>Total comprado</label>
            <input
              id={`${id}-bought`}
              class="control"
              value={boughtInput()}
              aria-invalid={error() === "bought" ? "true" : undefined}
              aria-describedby={
                error() === "bought" ? `${id}-hint ${id}-error` : `${id}-hint`
              }
              onInput={(event) => {
                setBought(event.currentTarget.value);
                setError(undefined);
              }}
            />
          </div>
          <div class="field">
            <label for={`${id}-onHand`}>Cantidad en casa</label>
            <input
              id={`${id}-onHand`}
              class="control"
              value={onHandInput()}
              aria-invalid={error() === "onHand" ? "true" : undefined}
              aria-describedby={
                error() === "onHand" ? `${id}-hint ${id}-error` : `${id}-hint`
              }
              onInput={(event) => {
                setOnHand(event.currentTarget.value);
                setError(undefined);
              }}
            />
          </div>
        </div>
        <div role="alert">
          <FieldError
            id={`${id}-error`}
            message={
              error()
                ? "Escribe un número o una fracción mayor que cero."
                : undefined
            }
          />
        </div>
        <div class="actions shopping-dialog-actions">
          <button
            type="submit"
            class="btn btn-primary"
            title="Guardar cantidades"
          >
            <ActionIcon name="save" />
            <span class="sr-only">Guardar cantidades</span>
          </button>
          <button
            type="button"
            class="btn"
            onClick={props.close}
            title="Cancelar"
          >
            <ActionIcon name="close" />
            <span class="sr-only">Cancelar</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}
