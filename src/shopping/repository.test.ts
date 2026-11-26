import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { parseMeasuredAmount, parseRational } from "../domain";
import { createShoppingRepository, decodeShoppingState } from "./repository";
import { emptyShoppingState, saveManualItem, setBalance } from "./workflow";
import type { ManualItem } from "./workflow";

const item: ManualItem = { id: "tea", name: "Té", amount: parseMeasuredAmount("2–3", "piece") };

describe("shopping repository", () => {
  it("starts empty, notifies after committing, and reloads stored exact quantities", async () => {
    const name = `shopping-test-${crypto.randomUUID()}`;
    const repository = createShoppingRepository(name);
    expect(await repository.read()).toEqual(emptyShoppingState());
    const onChange = vi.fn();
    const unsubscribe = repository.subscribe(onChange);
    const saved = setBalance(saveManualItem(emptyShoppingState(), item), '["manual","tea"]', "piece", {
      bought: parseRational("1/3"),
    });
    await repository.write(saved);
    expect(onChange).toHaveBeenCalledTimes(1);
    const reopened = createShoppingRepository(name);
    expect(await reopened.read()).toEqual(saved);
    unsubscribe();
    await repository.update((current) => ({ ...current, balances: [] }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((await reopened.read()).balances).toEqual([]);
  });

  it("serializes independent updates through separate repository instances", async () => {
    const name = `shopping-test-${crypto.randomUUID()}`;
    const first = createShoppingRepository(name);
    const second = createShoppingRepository(name);
    await Promise.all([
      first.update((current) => saveManualItem(current, item)),
      second.update((current) => saveManualItem(current, { ...item, id: "milk", name: "Leche" })),
    ]);
    expect((await first.read()).manualItems.map(({ id }) => id).sort()).toEqual(["milk", "tea"]);
  });

  it("notifies each listener once when a different instance commits", async () => {
    const name = `shopping-test-${crypto.randomUUID()}`;
    const first = createShoppingRepository(name, true);
    const second = createShoppingRepository(name, true);
    const local = vi.fn();
    const remote = vi.fn();
    const stopLocal = first.subscribe(local);
    const stopRemote = second.subscribe(remote);
    try {
      await first.update((current) => saveManualItem(current, item));
      await vi.waitFor(() => expect(remote).toHaveBeenCalledTimes(1));
      expect(local).toHaveBeenCalledTimes(1);
      expect((await second.read()).manualItems).toEqual([item]);
    } finally {
      stopLocal();
      stopRemote();
    }
  });

  it("rejects unsupported or invalid data and preserves the last commit on a failed update", async () => {
    expect(() => decodeShoppingState({ version: 2 })).toThrow();
    const repo = createShoppingRepository(`shopping-test-${crypto.randomUUID()}`);
    const saved = saveManualItem(emptyShoppingState(), item);
    await repo.write(saved);
    await expect(repo.update((current) => ({
      ...current, manualItems: [item, item],
    }))).rejects.toThrow("Invalid manual item.");
    expect(await repo.read()).toEqual(saved);
  });
});
