import { unitIds } from "../contracts";
import { activeMenuKey, databaseName, recipeDatabaseConnection, writeTransaction } from "../data/database";
import { announcePersonalDataChange } from "../data/personal-changes";
import { normalizeAmount, units } from "../domain/measurements";
import { normalizeRational } from "../domain/rational";
import { emptyShoppingState } from "./workflow";
import type { ShoppingState } from "./workflow";

/** Subscription invalidates a previous read after a local write or a browser storage change. */
export interface ShoppingRepository {
  read(): Promise<ShoppingState>;
  write(state: ShoppingState): Promise<void>;
  update(change: (state: ShoppingState) => ShoppingState): Promise<void>;
  subscribe(listener: () => void): () => void;
}

/** Validates a persisted document before making it available to the UI or an importer. */
export function decodeShoppingState(value: unknown): ShoppingState {
  const document = value as Partial<ShoppingState> | null;
  if (document?.version !== 1 || !Array.isArray(document.manualItems)
    || !Array.isArray(document.balances) || !Array.isArray(document.checked)) {
    throw new TypeError("Invalid shopping data.");
  }

  const itemIds = new Set<string>();
  const balanceKeys = new Set<string>();
  const checkedKeys = new Set<string>();
  const manualItems = document.manualItems.map((item) => {
    if (!item || typeof item.id !== "string" || !item.id || itemIds.has(item.id)
      || typeof item.name !== "string" || !item.name.trim()
      || (item.ingredientId !== undefined && typeof item.ingredientId !== "string")) {
      throw new TypeError("Invalid manual item.");
    }
    itemIds.add(item.id);
    const { id, name, ingredientId } = item;
    return { id, name, ingredientId, amount: normalizeAmount(item.amount) };
  });
  const balances = document.balances.map((item) => {
    if (!item || typeof item.groupId !== "string" || !unitIds.includes(item.unit)
      || (item.bought === undefined && item.onHand === undefined)) {
      throw new TypeError("Invalid shopping balance.");
    }
    const { groupId, unit, bought, onHand } = item;
    const key = JSON.stringify([groupId, units[unit].dimension]);
    if (balanceKeys.has(key)) throw new TypeError("Duplicate shopping balance.");
    balanceKeys.add(key);
    return {
      groupId, unit,
      bought: bought === undefined ? undefined : normalizeRational(bought),
      onHand: onHand === undefined ? undefined : normalizeRational(onHand),
    };
  });
  const checked = document.checked.map((item) => {
    if (!item || typeof item.groupId !== "string" || (item.note !== null && typeof item.note !== "string")) {
      throw new TypeError("Invalid checked shopping line.");
    }
    const { groupId, note } = item;
    const key = JSON.stringify([groupId, note]);
    if (checkedKeys.has(key)) throw new TypeError("Duplicate checked shopping line.");
    checkedKeys.add(key);
    return { groupId, note };
  });
  return { version: 1, manualItems, balances, checked };
}

function shoppingStorage(name: string, syncAcrossTabs: boolean) {
  const changes = new EventTarget();
  const database = recipeDatabaseConnection(name);
  let channel: BroadcastChannel | undefined;
  let subscriberCount = 0;

  const openChannel = () => syncAcrossTabs && typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel(`${name}:shopping`) : undefined;

  const readState = (record: ShoppingState | undefined) =>
    record === undefined ? emptyShoppingState() : decodeShoppingState(record);

  function publish() {
    changes.dispatchEvent(new Event("change"));
    const sender = channel ?? openChannel();
    sender?.postMessage("updated");
    if (!channel) sender?.close();
  }

  function changed() {
    if (name === databaseName) announcePersonalDataChange();
    publish();
  }

  const repository: ShoppingRepository = {
    async read() {
      return readState(await (await database()).get("shopping", activeMenuKey));
    },
    async write(state) {
      await (await database()).put("shopping", decodeShoppingState(state), activeMenuKey);
      changed();
    },
    async update(change) {
      await writeTransaction(await database(), ["shopping"], async (transaction) => {
        const store = transaction.objectStore("shopping");
        const current = readState(await store.get(activeMenuKey));
        await store.put(decodeShoppingState(change(current)), activeMenuKey);
      });
      changed();
    },
    subscribe(listener) {
      const notify = () => listener();
      changes.addEventListener("change", notify);
      if (subscriberCount++ === 0) {
        channel = openChannel();
        if (channel) channel.onmessage = () => changes.dispatchEvent(new Event("change"));
      }
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        changes.removeEventListener("change", notify);
        if (--subscriberCount === 0) {
          channel?.close();
          channel = undefined;
        }
      };
    },
  };
  return { repository, publish };
}

export function createShoppingRepository(name: string, syncAcrossTabs = false): ShoppingRepository {
  return shoppingStorage(name, syncAcrossTabs).repository;
}

const active = shoppingStorage(databaseName, true);
export const activeShoppingRepository = active.repository;
export const refreshActiveShopping = active.publish;
