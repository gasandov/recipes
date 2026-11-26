import { ActionIcon } from "../ui/components/ActionIcon";
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import type { Rational, UnitId } from "../contracts";
import { convertShoppingTotal } from "../domain";
import { orderedUnits, unitOptionLabel } from "../ui/text";
import {
  formatQuantity,
  formatRemaining,
  getRemainingDisplay,
  preferredUnit,
} from "./display";
import { BalanceForm } from "./forms";
import {
  balanceForUnit,
  clearPurchase,
  getProgress,
  isChecked,
  markPurchased,
  setBalance,
  setChecked,
} from "./workflow";
import type { MeasuredLine, ShoppingState, UnmeasuredLine } from "./workflow";

export type SaveShoppingChange = (
  change: (state: ShoppingState) => ShoppingState,
) => Promise<boolean>;

type RowProps = {
  name: string;
  state: ShoppingState;
  save: SaveShoppingChange;
};

export function MeasuredRow(
  props: RowProps & { line: MeasuredLine; multiple: boolean },
) {
  const id = createUniqueId();
  const [chosen, setChosen] = createSignal<UnitId>();
  const [editing, setEditing] = createSignal(false);
  const label = () =>
    props.multiple
      ? `${props.name} (${unitOptionLabel(props.line.total.amount.unit)})`
      : props.name;
  const options = createMemo(() =>
    orderedUnits.filter((unit) => convertShoppingTotal(props.line.total, unit)),
  );
  const explicitUnit = () => {
    const unit = chosen();
    return unit && options().includes(unit) ? unit : undefined;
  };
  const unit = () => explicitUnit() ?? preferredUnit(props.line);
  const required = () =>
    convertShoppingTotal(props.line.total, unit()) ?? props.line.total;
  const progress = () => getProgress(props.state, props.line, unit());
  const remaining = () =>
    getRemainingDisplay(props.state, props.line, explicitUnit());
  const purchaseAction = () =>
    progress().outstanding ? "Marcar comprado" : "Quitar registro de compra";
  const formatBalance = (value: Rational, approximate: boolean) =>
    `${approximate ? "≈ " : ""}${formatQuantity({ kind: "measured", min: value, unit: unit() })}`;

  return (
    <div class="shopping-entry" role="group" aria-label={label()}>
      <div class="shopping-required">
        <span class="hint">Total requerido</span>
        <ul class="ingredient-list">
          <li class="shopping-total">
            <strong class="ingredient-amount">
              <Show when={required().approximate}>
                <span aria-hidden="true">≈ </span>
              </Show>
              {formatQuantity(required().amount)}
            </strong>
            <Show when={required().approximate}>
              <span class="sr-only"> (aproximado)</span>
            </Show>
            <Show when={options().length > 1}>
              <div class="unit-picker">
                <label class="sr-only" for={id}>
                  Unidad para {label()}
                </label>
                <select
                  id={id}
                  class="control control-small"
                  value={unit()}
                  onChange={(event) =>
                    setChosen(event.currentTarget.value as UnitId)
                  }
                >
                  <For each={options()}>
                    {(option) => (
                      <option value={option}>{unitOptionLabel(option)}</option>
                    )}
                  </For>
                </select>
              </div>
            </Show>
          </li>
        </ul>
      </div>
      <p class="shopping-remaining" aria-live="polite">
        <Show when={progress().outstanding} fallback="Compra cubierta">
          Falta comprar <b>{formatRemaining(remaining())}</b>
        </Show>
      </p>
      <Show when={progress().bought || progress().onHand}>
        <p class="hint shopping-balances">
          <Show when={progress().bought}>
            {(amount) => (
              <span>
                Comprado {formatBalance(amount(), progress().boughtApproximate)}
              </span>
            )}
          </Show>
          <Show when={progress().onHand}>
            {(amount) => (
              <span>
                En casa {formatBalance(amount(), progress().onHandApproximate)}
              </span>
            )}
          </Show>
        </p>
      </Show>
      <div class="actions">
        <Show when={progress().outstanding || progress().bought}>
          <button
            type="button"
            class="btn btn-small"
            aria-label={`${purchaseAction()} · ${label()}`}
            onClick={() => {
              const line = props.line;
              const displayUnit = unit();
              const outstanding = progress().outstanding;
              void props.save((state) =>
                outstanding
                  ? markPurchased(state, line, displayUnit)
                  : clearPurchase(state, line),
              );
            }}
            title={`${purchaseAction()} · ${label()}`}
          >
            <ActionIcon name="purchase" />
            <span class="sr-only">{purchaseAction()}</span>
          </button>
        </Show>
        <button
          type="button"
          class="btn btn-small"
          aria-label={`Editar cantidades · ${label()}`}
          onClick={() => setEditing(true)}
          title={`Editar cantidades · ${label()}`}
        >
          <ActionIcon name="edit" />
          <span class="sr-only">Editar cantidades</span>
        </button>
      </div>
      <Show when={editing()}>
        <BalanceForm
          name={label()}
          groupId={props.line.groupId}
          initialUnit={unit()}
          options={options()}
          state={props.state}
          close={() => setEditing(false)}
          save={async (selected, balance) => {
            if (!options().includes(selected)) return false;
            const { groupId } = props.line;
            return props.save((state) =>
              setBalance(state, groupId, selected, {
                ...balanceForUnit(state, groupId, selected),
                ...balance,
              }),
            );
          }}
        />
      </Show>
    </div>
  );
}

export function UnmeasuredRow(props: RowProps & { line: UnmeasuredLine }) {
  const checked = createMemo(() => isChecked(props.state, props.line));
  const description = () => props.line.note ?? "Sin cantidad";
  return (
    <div class="shopping-entry">
      <ul class="ingredient-list">
        <li class="shopping-note">{description()}</li>
      </ul>
      <label class="shopping-check">
        <input
          type="checkbox"
          checked={checked()}
          onChange={async (event) => {
            const input = event.currentTarget;
            const purchased = input.checked;
            const line = props.line;
            if (
              !(await props.save((state) => setChecked(state, line, purchased)))
            )
              input.checked = checked();
          }}
        />
        <span>
          Comprado{" "}
          <span class="sr-only">
            {props.name}, {description()}
          </span>
        </span>
      </label>
    </div>
  );
}
