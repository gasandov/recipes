import { describe, expect, it } from "vitest";
import type { MenuEntry, UnitId } from "../contracts";
import { aggregateShoppingList, convertShoppingTotal, defaultMetricUnit, formatMeasuredAmount, parseMeasuredAmount, parseRational } from "./index";

type SnapshotLine = MenuEntry["ingredients"][number];

const oilDensity = { gramsPerMilliliter: parseRational("0.8"), source: "Test equivalence" };

function line(ingredientId: string, quantity: string, unit: UnitId): SnapshotLine {
  return { ingredientId, name: ingredientId, amount: parseMeasuredAmount(quantity, unit) };
}

function batch(id: string, ingredients: SnapshotLine[], portions = 4): MenuEntry {
  return { id, sourceRecipeId: id, name: id, portions, ingredients };
}

describe("shopping aggregation", () => {
  it("groups by stable ID and sums equivalent metric units, counts, and range endpoints", () => {
    const groups = aggregateShoppingList([
      batch("first", [line("flour", "500", "gram"), line("egg", "2", "piece"), line("chile", "2–3", "piece")]),
      batch("second", [
        { ...line("flour", "1", "kilogram"), name: "Renamed flour" },
        line("egg", "2", "piece"), line("chile", "1", "piece"),
        { ...line("other-chile", "5", "piece"), name: "chile" },
      ]),
    ]);
    expect(groups.map(({ ingredientId }) => ingredientId)).toEqual(["flour", "egg", "chile", "other-chile"]);
    expect(groups[0].name).toBe("flour");
    const [flour] = groups[0].measured;
    expect(flour.amount).toEqual(parseMeasuredAmount("1500", "gram"));
    const shown = convertShoppingTotal(flour, defaultMetricUnit(flour.amount));
    expect(shown?.amount.unit).toBe("kilogram");
    expect(shown && formatMeasuredAmount(shown.amount, true)).toBe("1.5");
    expect(groups[1].measured[0].amount).toEqual(parseMeasuredAmount("4", "piece"));
    expect(groups[2].measured[0].amount).toEqual(parseMeasuredAmount("3–4", "piece"));
    expect(groups[3].measured[0].amount).toEqual(parseMeasuredAmount("5", "piece"));
  });

  it("keeps chicken cuts and household units separate while preserving exact fractional portions", () => {
    const ingredients = [
      line("breast", "2", "piece"), line("cutlet", "2", "piece"),
      line("herb", "1", "pinch"), line("herb", "1", "bunch"),
    ];
    const original = batch("first", ingredients);
    const second = batch("second", [line("herb", "1", "pinch"), line("breast", "1", "piece")], 1);
    const groups = aggregateShoppingList([{ ...original, portions: 8 }, second]);
    expect(groups.map(({ ingredientId, measured }) => [ingredientId, measured.map(({ amount }) => amount)])).toEqual([
      ["breast", [parseMeasuredAmount("4 1/4", "piece")]],
      ["cutlet", [parseMeasuredAmount("4", "piece")]],
      ["herb", [parseMeasuredAmount("2 1/4", "pinch"), parseMeasuredAmount("2", "bunch")]],
    ]);
    expect(convertShoppingTotal(groups[2].measured[0], "bunch")).toBeUndefined();
    expect(aggregateShoppingList([original])[0].measured[0].amount).toEqual(parseMeasuredAmount("2", "piece"));
  });

  it("converts a cup back and forth with milliliters while preserving the snapshot", () => {
    const entry = batch("dough", [line("flour", "1", "cup")]);
    const [total] = aggregateShoppingList([entry])[0].measured;
    expect(total.amount).toEqual(parseMeasuredAmount("250", "milliliter"));
    expect(total.preferredUnit).toBe("cup");
    const cup = convertShoppingTotal(total, "cup");
    expect(cup).toMatchObject({ amount: parseMeasuredAmount("1", "cup"), approximate: false });
    expect(cup && convertShoppingTotal(cup, "milliliter")?.amount).toEqual(total.amount);
    expect(entry.ingredients[0].amount).toEqual(parseMeasuredAmount("1", "cup"));
  });

  it("uses a consistent density to combine two dimensions and keeps every display approximate", () => {
    const liquid = { ...line("oil", "100", "milliliter"), density: oilDensity };
    const solid = {
      ...line("oil", "80", "gram"),
      density: { ...oilDensity, gramsPerMilliliter: { numerator: "8", denominator: "10" } },
    };
    const [{ measured }] = aggregateShoppingList([batch("first", [liquid]), batch("second", [solid])]);
    expect(measured).toEqual([{ amount: parseMeasuredAmount("160", "gram"), approximate: true, density: solid.density }]);
    expect(convertShoppingTotal(measured[0], "milliliter")).toMatchObject({
      amount: parseMeasuredAmount("200", "milliliter"), approximate: true,
    });

    const [onlyVolume] = aggregateShoppingList([batch("first", [liquid])])[0].measured;
    expect(onlyVolume.approximate).toBe(false);
    expect(convertShoppingTotal(onlyVolume, "gram")).toMatchObject({
      amount: parseMeasuredAmount("80", "gram"), approximate: true,
    });
  });

  it.each([undefined, { ...oilDensity, gramsPerMilliliter: parseRational("0.9") }])(
    "keeps mass and volume separate when a contributing equivalence is absent or changed (%j)",
    (density) => {
      const [{ measured }] = aggregateShoppingList([
        batch("first", [
          { ...line("oil", "100", "milliliter"), density: oilDensity },
          { ...line("oil", "50", "milliliter"), density },
          { ...line("oil", "80", "gram"), density: oilDensity },
        ]),
      ]);
      expect(measured.map(({ amount }) => amount)).toEqual([
        parseMeasuredAmount("150", "milliliter"), parseMeasuredAmount("80", "gram"),
      ]);
      expect(convertShoppingTotal(measured[0], "gram")).toBeUndefined();
      expect(convertShoppingTotal(measured[1], "milliliter")).toBeUndefined();
    },
  );

  it("retains distinct qualitative notes and unspecified amounts alongside the measured total", () => {
    const measured = line("salt", "1/3", "teaspoon");
    const note: SnapshotLine = { ...measured, amount: { kind: "qualitative", text: "al gusto" } };
    const other: SnapshotLine = { ...measured, amount: { kind: "qualitative", text: "para servir" } };
    const unspecified: SnapshotLine = { ...measured, amount: { kind: "unspecified" } };
    const groups = aggregateShoppingList([
      batch("first", [note, measured, unspecified]), batch("second", [note, other, unspecified], 8), batch("empty", []),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ notes: ["al gusto", "para servir"], unspecified: true });
    expect(convertShoppingTotal(groups[0].measured[0], "teaspoon")?.amount).toEqual(measured.amount);
    expect(aggregateShoppingList([batch("empty", [])])).toEqual([]);
    expect(aggregateShoppingList([])).toEqual([]);
  });
});
