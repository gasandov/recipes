import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import type { UnitId } from "../../contracts";
import { aggregateShoppingList, convertShoppingTotal, defaultMetricUnit, formatMeasuredAmount } from "../../domain";
import type { ShoppingIngredient } from "../../domain/shopping";
import { paths } from "../router";
import { compareNames, orderedUnits, unitLabel, unitOptionLabel } from "../text";
import { useApp } from "../use-app";

export function ShoppingList() {
  const app = useApp();
  const ingredients = createMemo(() => aggregateShoppingList(app.menu()).sort((a, b) => compareNames(a.name, b.name)));

  return (
    <>
      <header class="page-head">
        <h1 tabindex="-1">Lista de compras</h1>
        <a class="btn" href={paths.menu}>Ver menú</a>
      </header>
      <Show when={ingredients().length > 0} fallback={
        <section class="empty-state">
          <h2>Aún no hay ingredientes para comprar</h2>
          <p>{app.menu().length === 0
            ? "Agrega recetas a tu menú para armar la lista."
            : "Ninguno de los lotes del menú tiene ingredientes."}</p>
        </section>
      }>
        <ul class="planning-list">
          <For each={ingredients()} keyed={(ingredient) => ingredient.ingredientId}>
            {(group) => (
              <li class="panel shopping-ingredient">
                <h2>{group().name}</h2>
                <Show when={!app.ingredientsById().has(group().ingredientId)}>
                  <p class="hint">Guardado en el menú. Ya no está en el catálogo.</p>
                </Show>
                <ul class="ingredient-list">
                  <For each={group().measured} keyed={(total) => total.amount.unit}>
                    {(total) => (
                      <MeasuredTotal name={group().name} total={total()} multiple={group().measured.length > 1} />
                    )}
                  </For>
                  <For each={group().notes}>
                    {(note) => <li class="shopping-note">{note}</li>}
                  </For>
                  <Show when={group().unspecified}>
                    <li class="shopping-note">Sin cantidad</li>
                  </Show>
                </ul>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </>
  );
}

function MeasuredTotal(props: { name: string; total: ShoppingIngredient["measured"][number]; multiple: boolean }) {
  const id = createUniqueId();
  const [chosen, setChosen] = createSignal<UnitId>();
  const options = createMemo(() => orderedUnits.filter((unit) => convertShoppingTotal(props.total, unit)));
  const shown = createMemo(() => {
    const preferred = chosen();
    const defaultUnit = props.total.preferredUnit ?? defaultMetricUnit(props.total.amount);
    const unit = preferred && options().includes(preferred) ? preferred : defaultUnit;
    return convertShoppingTotal(props.total, unit) ?? props.total;
  });
  const amount = () => shown().amount;
  const quantity = () => {
    const current = amount();
    const preferDecimal = current.unit === "kilogram" || current.unit === "liter";
    return `${formatMeasuredAmount(current, preferDecimal)} ${unitLabel(current.unit, current.max ?? current.min)}`;
  };

  return (
    <li class="shopping-total">
      <strong class="ingredient-amount">
        <Show when={shown().approximate}>
          <span aria-hidden="true">≈ </span>
        </Show>
        {quantity()}
      </strong>
      <Show when={shown().approximate}>
        <span class="sr-only"> (aproximado)</span>
      </Show>
      <Show when={options().length > 1}>
        <div class="unit-picker">
          <label class="sr-only" for={id}>
            Unidad para {props.name}{props.multiple ? ` (${unitOptionLabel(props.total.amount.unit)})` : ""}
          </label>
          <select id={id} class="control control-small" value={amount().unit}
            onChange={(event) => setChosen(event.currentTarget.value as UnitId)}>
            <For each={options()}>{(unit) => <option value={unit}>{unitOptionLabel(unit)}</option>}</For>
          </select>
        </div>
      </Show>
    </li>
  );
}
