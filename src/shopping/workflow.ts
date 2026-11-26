import { RECIPE_PORTIONS } from "../contracts";
import type { Amount, Ingredient, MenuEntry, Rational, UnitId } from "../contracts";
import { convertMeasuredAmount, units, usesDensity } from "../domain/measurements";
import { addRational, compareRational, rational } from "../domain/rational";
import { aggregateShoppingList } from "../domain/shopping";
import type { ShoppingIngredient } from "../domain/shopping";

export type ManualItem = { id: string; name: string; ingredientId?: string; amount: Amount };
type Balance = { bought?: Rational; onHand?: Rational };
export type ShoppingBalance = Balance & { groupId: string; unit: UnitId };
export type CheckedShoppingLine = { groupId: string; note: string | null };

/** Shopping data for the app's single active menu. The menu requirements are derived on read. */
export type ShoppingState = {
  version: 1;
  manualItems: ManualItem[];
  balances: ShoppingBalance[];
  checked: CheckedShoppingLine[];
};

export function emptyShoppingState(): ShoppingState {
  return { version: 1, manualItems: [], balances: [], checked: [] };
}

type MeasuredTotal = ShoppingIngredient["measured"][number];
export type MeasuredLine = { kind: "measured"; id: string; groupId: string; total: MeasuredTotal };
export type UnmeasuredLine = { kind: "unmeasured"; id: string; groupId: string; note: string | null };
export type ShoppingLine = MeasuredLine | UnmeasuredLine;
export type ShoppingGroup = {
  id: string;
  name: string;
  ingredientId?: string;
  fromMenu: boolean;
  manualItems: ManualItem[];
  lines: ShoppingLine[];
};

const catalogGroup = (id: string) => JSON.stringify(["catalog", id]);
const manualGroup = (id: string) => JSON.stringify(["manual", id]);

export function buildShoppingList(
  menu: readonly MenuEntry[],
  manualItems: readonly ManualItem[],
  catalog: ReadonlyMap<string, Ingredient>,
): ShoppingGroup[] {
  const ingredientIds = new Map<string, string>();
  const menuGroups = new Set<string>();
  const manualsByGroup = new Map<string, ManualItem[]>();
  const menuEntries = menu.map((entry) => ({
    ...entry,
    ingredients: entry.ingredients.map((line) => {
      const groupId = catalogGroup(line.ingredientId);
      ingredientIds.set(groupId, line.ingredientId);
      menuGroups.add(groupId);
      return { ...line, ingredientId: groupId };
    }),
  }));

  // Manual lines are already absolute quantities. A four-portion contribution leaves them unscaled.
  const manualEntry: MenuEntry = {
    id: "", name: "", sourceRecipeId: "", portions: RECIPE_PORTIONS,
    ingredients: manualItems.map((item) => {
      const ingredient = item.ingredientId === undefined ? undefined : catalog.get(item.ingredientId);
      const groupId = item.ingredientId === undefined ? manualGroup(item.id) : catalogGroup(item.ingredientId);
      if (item.ingredientId !== undefined) ingredientIds.set(groupId, item.ingredientId);
      const previous = manualsByGroup.get(groupId);
      if (previous) previous.push(item);
      else manualsByGroup.set(groupId, [item]);
      return { ingredientId: groupId, name: ingredient?.name ?? item.name, amount: item.amount, density: ingredient?.density };
    }),
  };

  return aggregateShoppingList([...menuEntries, manualEntry]).map((group) => {
    const groupId = group.ingredientId;
    const lines: ShoppingLine[] = group.measured.map((total) => ({
      kind: "measured", id: JSON.stringify([groupId, "measured", total.amount.unit]), groupId, total,
    }));
    const notes: (string | null)[] = group.notes.slice();
    if (group.unspecified) notes.push(null);
    for (const note of notes) {
      lines.push({ kind: "unmeasured", id: JSON.stringify([groupId, "unmeasured", note]), groupId, note });
    }
    return {
      id: groupId,
      name: group.name,
      ingredientId: ingredientIds.get(groupId),
      fromMenu: menuGroups.has(groupId),
      manualItems: manualsByGroup.get(groupId) ?? [],
      lines,
    };
  });
}

function add(left: Rational | undefined, right: Rational): Rational {
  return left ? addRational(left, right) : right;
}

function subtract(quantity: Rational, deduction?: Rational): Rational | undefined {
  if (!deduction) return quantity;
  if (compareRational(quantity, deduction) <= 0) return undefined;
  const a = BigInt(quantity.numerator);
  const b = BigInt(quantity.denominator);
  const c = BigInt(deduction.numerator);
  const d = BigInt(deduction.denominator);
  return rational(a * d - c * b, b * d);
}

function sameDimension(left: UnitId, right: UnitId): boolean {
  return units[left].dimension === units[right].dimension;
}

function matchingBalances(state: ShoppingState, line: MeasuredLine) {
  const { amount, density } = line.total;
  return state.balances.filter((balance) => balance.groupId === line.groupId
    && (sameDimension(balance.unit, amount.unit)
      || (density && usesDensity(balance.unit, amount.unit))));
}

function convertBalance(value: Rational, from: UnitId, to: UnitId, density?: MeasuredTotal["density"]): Rational | undefined {
  return convertMeasuredAmount({ kind: "measured", unit: from, min: value }, to, density)?.min;
}

export function balanceForUnit(state: ShoppingState, groupId: string, unit: UnitId): Balance {
  const balance = state.balances.find((item) => item.groupId === groupId && sameDimension(item.unit, unit));
  return balance ? {
    bought: balance.bought && convertBalance(balance.bought, balance.unit, unit),
    onHand: balance.onHand && convertBalance(balance.onHand, balance.unit, unit),
  } : {};
}

export function setBalance(state: ShoppingState, groupId: string, unit: UnitId, balance: Balance): ShoppingState {
  const balances = state.balances.filter((item) => item.groupId !== groupId || !sameDimension(item.unit, unit));
  if (balance.bought || balance.onHand) balances.push({ groupId, unit, ...balance });
  return { ...state, balances };
}

export function getProgress(state: ShoppingState, line: MeasuredLine, unit: UnitId = line.total.amount.unit) {
  const { amount, density } = line.total;
  const required = convertMeasuredAmount(amount, unit, density) ?? amount;
  let bought: Rational | undefined;
  let onHand: Rational | undefined;
  let boughtApproximate = false;
  let onHandApproximate = false;
  for (const balance of matchingBalances(state, line)) {
    const conversionIsApproximate = usesDensity(balance.unit, required.unit);
    if (balance.bought) {
      boughtApproximate ||= conversionIsApproximate;
      const converted = convertBalance(balance.bought, balance.unit, required.unit, density);
      if (converted) bought = add(bought, converted);
    }
    if (balance.onHand) {
      onHandApproximate ||= conversionIsApproximate;
      const converted = convertBalance(balance.onHand, balance.unit, required.unit, density);
      if (converted) onHand = add(onHand, converted);
    }
  }
  const deduction = bought && onHand ? addRational(bought, onHand) : bought ?? onHand;
  const min = subtract(required.min, deduction);
  const max = required.max && subtract(required.max, deduction);
  const approximate = line.total.approximate || usesDensity(amount.unit, required.unit) || boughtApproximate || onHandApproximate;
  return { required, bought, onHand, min, max, outstanding: max ?? min, approximate, boughtApproximate, onHandApproximate };
}

export function markPurchased(state: ShoppingState, line: MeasuredLine, unit: UnitId): ShoppingState {
  const { outstanding, required } = getProgress(state, line, unit);
  if (!outstanding) return state;
  const balance = balanceForUnit(state, line.groupId, required.unit);
  return setBalance(state, line.groupId, required.unit, { ...balance, bought: add(balance.bought, outstanding) });
}

export function clearPurchase(state: ShoppingState, line: MeasuredLine): ShoppingState {
  const matching = new Set(matchingBalances(state, line));
  const balances = state.balances.flatMap((item) => {
    if (!matching.has(item)) return [item];
    return item.onHand ? [{ groupId: item.groupId, unit: item.unit, onHand: item.onHand }] : [];
  });
  return { ...state, balances };
}

export function isChecked(state: ShoppingState, line: UnmeasuredLine): boolean {
  return state.checked.some((item) => item.groupId === line.groupId && item.note === line.note);
}

export function setChecked(state: ShoppingState, line: UnmeasuredLine, purchased: boolean): ShoppingState {
  const checked = state.checked.filter((item) => item.groupId !== line.groupId || item.note !== line.note);
  if (purchased) checked.push({ groupId: line.groupId, note: line.note });
  return { ...state, checked };
}

function clearGroupProgress(state: ShoppingState, groupId: string): ShoppingState {
  return {
    ...state,
    balances: state.balances.filter((item) => item.groupId !== groupId),
    checked: state.checked.filter((item) => item.groupId !== groupId),
  };
}

export function saveManualItem(state: ShoppingState, item: ManualItem): ShoppingState {
  const previous = state.manualItems.find((existing) => existing.id === item.id);
  if (!previous) return { ...state, manualItems: [...state.manualItems, item] };
  const next = previous.ingredientId === undefined && item.ingredientId !== undefined
    ? clearGroupProgress(state, manualGroup(item.id)) : state;
  return { ...next, manualItems: next.manualItems.map((existing) => existing.id === item.id ? item : existing) };
}

export function removeManualItem(state: ShoppingState, id: string): ShoppingState {
  return {
    ...clearGroupProgress(state, manualGroup(id)),
    manualItems: state.manualItems.filter((item) => item.id !== id),
  };
}

export function resetShoppingProgress(state: ShoppingState): ShoppingState {
  return { ...state, balances: [], checked: [] };
}
