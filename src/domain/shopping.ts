import { RECIPE_PORTIONS } from "../contracts";
import type { Density, MeasuredAmount, MenuEntry, UnitId } from "../contracts";
import { convertMeasuredAmount, scaleMeasuredAmount, units, usesDensity } from "./measurements";
import { addRational, compareRational, rational } from "./rational";
import { validatePortions } from "./recipes";

type ShoppingTotal = {
  amount: MeasuredAmount;
  approximate: boolean;
  density?: Density;
  preferredUnit?: UnitId;
};

type IngredientGroup = {
  ingredientId: string;
  name: string;
  measured: Map<UnitId, ShoppingTotal>;
  notes: Set<string>;
  unspecified: boolean;
};

export type ShoppingIngredient = Omit<IngredientGroup, "measured" | "notes"> & {
  measured: ShoppingTotal[];
  notes: string[];
};

const baseUnits: Record<(typeof units)[UnitId]["dimension"], UnitId> = {
  mass: "gram",
  volume: "milliliter",
  piece: "piece",
  pinch: "pinch",
  bunch: "bunch",
};

const cookingVolumeUnits: readonly UnitId[] = ["cup", "tablespoon", "teaspoon"];

function sumAmounts(left: MeasuredAmount, right: MeasuredAmount): MeasuredAmount {
  const min = addRational(left.min, right.min);
  return left.max || right.max
    ? { ...left, min, max: addRational(left.max ?? left.min, right.max ?? right.min) }
    : { ...left, min };
}

function commonDensity(left?: Density, right?: Density): Density | undefined {
  if (left && right && compareRational(left.gramsPerMilliliter, right.gramsPerMilliliter) === 0) {
    return left;
  }
  return undefined;
}

function combineMassAndVolume(measured: Map<UnitId, ShoppingTotal>): void {
  const mass = measured.get("gram");
  const volume = measured.get("milliliter");
  if (!mass || !volume) return;

  const density = commonDensity(mass.density, volume.density);
  const converted = density && convertMeasuredAmount(volume.amount, "gram", density);
  if (converted) {
    measured.set("gram", { amount: sumAmounts(mass.amount, converted), approximate: true, density });
    measured.delete("milliliter");
  } else {
    // Keep the two totals in distinct dimensions when any contributing equivalence is incompatible.
    measured.set("gram", { ...mass, density: undefined });
    measured.set("milliliter", { ...volume, density: undefined });
  }
}

/** Derives purchases from the four-portion snapshots and each batch's current portion count. */
export function aggregateShoppingList(entries: readonly MenuEntry[]): ShoppingIngredient[] {
  const groups = new Map<string, IngredientGroup>();

  for (const entry of entries) {
    validatePortions(entry.portions);
    const factor = rational(BigInt(entry.portions), BigInt(RECIPE_PORTIONS));
    for (const { ingredientId, name, amount, density } of entry.ingredients) {
      let group = groups.get(ingredientId);
      if (!group) {
        group = { ingredientId, name, measured: new Map(), notes: new Set(), unspecified: false };
        groups.set(ingredientId, group);
      }

      if (amount.kind === "qualitative") {
        group.notes.add(amount.text);
      } else if (amount.kind === "unspecified") {
        group.unspecified = true;
      } else {
        const unit = baseUnits[units[amount.unit].dimension];
        const scaled = scaleMeasuredAmount(amount, factor);
        const normalized = convertMeasuredAmount(scaled, unit);
        if (!normalized) throw new RangeError("A measured amount needs a compatible base unit.");
        const previous = group.measured.get(unit);
        // Keep a familiar kitchen unit when every contribution used it.
        const preferredUnit = cookingVolumeUnits.includes(amount.unit) && (!previous || previous.preferredUnit === amount.unit)
          ? amount.unit : undefined;
        group.measured.set(unit, {
          amount: previous ? sumAmounts(previous.amount, normalized) : normalized,
          approximate: false,
          density: previous ? commonDensity(previous.density, density) : density,
          ...(preferredUnit ? { preferredUnit } : {}),
        });
      }
    }
  }

  return [...groups.values()].map(({ measured, notes, ...group }) => {
    combineMassAndVolume(measured);
    return { ...group, measured: [...measured.values()], notes: [...notes] };
  });
}

export function convertShoppingTotal(total: ShoppingTotal, unit: UnitId): ShoppingTotal | undefined {
  const amount = convertMeasuredAmount(total.amount, unit, total.density);
  return amount && {
    ...total,
    amount,
    approximate: total.approximate || usesDensity(total.amount.unit, unit),
  };
}
