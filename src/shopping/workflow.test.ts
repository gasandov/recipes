import { describe, expect, it } from "vitest";
import type { Amount, Ingredient, MenuEntry } from "../contracts";
import { parseMeasuredAmount, parseRational } from "../domain";
import { createShoppingSnapshot, formatRemaining, getRemainingDisplay } from "./display";
import {
  buildShoppingList, clearPurchase, emptyShoppingState, getProgress, isChecked, markPurchased,
  removeManualItem, resetShoppingProgress, saveManualItem, setBalance, setChecked,
} from "./workflow";
import type { ShoppingGroup } from "./workflow";

const flour: Ingredient = { id: "flour", name: "Harina" };
const milk: Ingredient = { id: "milk", name: "Leche", density: { gramsPerMilliliter: parseRational("1.2"), source: "recipe" } };
const catalog = new Map([flour, milk].map((item) => [item.id, item]));

function batch(id: string, portions: number, ingredient: Ingredient, amount: Amount): MenuEntry {
  return {
    id, portions, name: id, sourceRecipeId: id,
    ingredients: [{ ingredientId: ingredient.id, name: ingredient.name, density: ingredient.density, amount }],
  };
}

const measured = (group: ShoppingGroup) => group.lines.filter((line) => line.kind === "measured");

describe("active menu shopping workflow", () => {
  it("starts empty and preserves the existing measured, note and unspecified summaries", () => {
    expect(buildShoppingList([], emptyShoppingState().manualItems, catalog)).toEqual([]);
    const [group] = buildShoppingList([
      batch("bread", 4, flour, parseMeasuredAmount("500", "gram")),
      batch("pancakes", 4, flour, parseMeasuredAmount("1–1 1/2", "kilogram")),
      batch("cake", 4, flour, { kind: "qualitative", text: "al gusto" }),
      batch("sauce", 4, flour, { kind: "unspecified" }),
    ], [], catalog);
    expect(measured(group).map((line) => line.total.amount)).toEqual([parseMeasuredAmount("1500–2000", "gram")]);
    expect(group.lines.filter((line) => line.kind === "unmeasured").map((line) => line.note)).toEqual(["al gusto", null]);
  });

  it("carries the quantity bought through rescaling, temporary removal and adding a different batch", () => {
    const recipe = batch("cake", 4, flour, parseMeasuredAmount("500", "gram"));
    const [first] = measured(buildShoppingList([recipe], [], catalog)[0]);
    const state = markPurchased(emptyShoppingState(), first, "gram");
    expect(getProgress(state, first).outstanding).toBeUndefined();
    expect(buildShoppingList([], state.manualItems, catalog)).toEqual([]);

    const [doubled] = measured(buildShoppingList([{ ...recipe, portions: 8 }], [], catalog)[0]);
    expect(doubled.id).toBe(first.id);
    expect(formatRemaining(getRemainingDisplay(state, doubled))).toBe("500 g");
    const [combined] = measured(buildShoppingList([recipe, { ...recipe, id: "another" }], [], catalog)[0]);
    expect(getProgress(state, combined, "kilogram")).toMatchObject({
      bought: parseRational("1/2"), outstanding: parseRational("1/2"),
    });
  });

  it("adds linked manual contributions, keeps independent identities and retains exact fractions", () => {
    const menu = [batch("cake", 4, flour, parseMeasuredAmount("1/3", "kilogram"))];
    const linked = { id: "linked", name: flour.name, ingredientId: flour.id, amount: parseMeasuredAmount("1/6", "kilogram") };
    const custom = { ...linked, id: "custom", ingredientId: undefined, amount: parseMeasuredAmount("2", "piece") };
    let state = saveManualItem(saveManualItem(emptyShoppingState(), linked), custom);
    const [group, separate] = buildShoppingList(menu, state.manualItems, catalog);
    expect(group.fromMenu).toBe(true);
    expect(group.manualItems).toEqual([linked]);
    expect(measured(group)[0].total.amount).toEqual(parseMeasuredAmount("500", "gram"));
    expect(separate.fromMenu).toBe(false);
    expect(separate.id).not.toBe(group.id);
    state = setBalance(state, separate.id, "piece", { bought: parseRational("1/2") });
    state = saveManualItem(state, { ...custom, name: "Otra harina", amount: parseMeasuredAmount("3", "piece") });
    expect(getProgress(state, measured(buildShoppingList([], state.manualItems, catalog)[1])[0]).outstanding)
      .toEqual(parseRational("2 1/2"));
    state = removeManualItem(state, "custom");
    expect(state.balances).toEqual([]);
    state = removeManualItem(state, "linked");
    expect(measured(buildShoppingList(menu, state.manualItems, catalog)[0])[0].total.amount)
      .toEqual(parseMeasuredAmount("1000/3", "gram"));
  });

  it("accounts for pantry and partial purchases while preserving a partially covered range", () => {
    const groups = buildShoppingList([batch("cake", 4, flour, parseMeasuredAmount("1/2–1", "kilogram"))], [], catalog);
    const [line] = measured(groups[0]);
    const state = setBalance(emptyShoppingState(), line.groupId, "kilogram", {
      bought: parseRational("1/3"), onHand: parseRational("1/6"),
    });
    expect(formatRemaining(getRemainingDisplay(state, line))).toBe("0–500 g");
    const finished = markPurchased(state, line, "gram");
    expect(getProgress(finished, line).outstanding).toBeUndefined();
    expect(clearPurchase(finished, line).balances[0]).toMatchObject({ onHand: parseRational("500/3") });
    expect(clearPurchase(finished, line).balances[0]).not.toHaveProperty("bought");
  });

  it("uses density only when the current aggregate supports it, without applying a balance twice", () => {
    const volume = batch("pancakes", 4, milk, parseMeasuredAmount("100", "milliliter"));
    const mass = batch("cake", 4, milk, parseMeasuredAmount("120", "gram"));
    const [merged] = measured(buildShoppingList([volume, mass], [], catalog)[0]);
    const state = setBalance(emptyShoppingState(), merged.groupId, "milliliter", { bought: parseRational("100") });
    expect(getProgress(state, merged)).toMatchObject({ approximate: true, outstanding: parseRational("120") });
    const changed = { ...milk, density: { gramsPerMilliliter: parseRational("1"), source: "changed" } };
    const split = measured(buildShoppingList([volume, batch("cake", 4, changed, mass.ingredients[0].amount)], [], catalog)[0]);
    expect(split.map((line) => getProgress(state, line).outstanding)).toEqual([undefined, parseRational("120")]);
  });

  it("shares pending quantities and keeps manual items when progress is explicitly reset", () => {
    const manualItem = { id: "manual", name: "Servilletas", amount: { kind: "unspecified" } } as const;
    let state = saveManualItem(emptyShoppingState(), manualItem);
    const groups = buildShoppingList([
      batch("cake", 4, flour, parseMeasuredAmount("1", "kilogram")),
      batch("sauce", 4, flour, { kind: "qualitative", text: "al gusto" }),
    ], state.manualItems, catalog);
    const [line, note] = groups[0].lines;
    if (line.kind !== "measured" || note.kind !== "unmeasured") throw new Error("Expected a measure and a note.");
    state = setChecked(state, note, true);
    state = setBalance(state, line.groupId, "gram", { bought: parseRational("500") });
    expect(createShoppingSnapshot(groups, state)).toBe("Lista de compras\n\n• Harina — 500 g\n• Servilletas — Sin cantidad");
    const reset = resetShoppingProgress(state);
    expect(reset.manualItems).toEqual([manualItem]);
    expect(reset.balances).toEqual([]);
    expect(isChecked(reset, note)).toBe(false);
  });
});
