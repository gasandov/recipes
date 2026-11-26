import { deleteDB, openDB } from "idb";
import type { DBSchema, IDBPDatabase } from "idb";
import { recordKey } from "./records";
import type { BaseRecord, SyncMetaState } from "./types";

export const syncDatabaseName = "recetario-sync";
const stateKey = "state";

/** A durable change to the metadata, applied in one transaction. */
export type MetaUpdate = {
  state?: Partial<Omit<SyncMetaState, "version" | "deviceId">>;
  setBase?: readonly BaseRecord[];
  deleteBase?: readonly string[];
};

export interface SyncMeta {
  read(): Promise<{ state: SyncMetaState; base: Map<string, BaseRecord> }>;
  update(change: MetaUpdate): Promise<void>;
  /** Forgets the account, the revisions and the conflicts. A new device ID is created on the next read. */
  clear(): Promise<void>;
}

function freshState(): SyncMetaState {
  return { version: 1, deviceId: crypto.randomUUID(), cursor: 0, initialized: false, conflicts: [] };
}

export const baseKey = (record: Pick<BaseRecord, "collection" | "id">): string => recordKey(record.collection, record.id);

/**
 * Per-record sync metadata, stored beside (not inside) the recipe database so F1 restore keeps replacing the
 * personal stores atomically. `base` holds the last revision and content this device agreed on with the server.
 * The offline queue is the difference between the local snapshot and this base, keyed by stable record ID,
 * so it survives restarts and repeated edits of one record coalesce.
 */
interface SyncDatabase extends DBSchema {
  state: { key: string; value: SyncMetaState };
  base: { key: string; value: BaseRecord };
}

export function createIndexedDbMeta(name = syncDatabaseName): SyncMeta {
  let connection: Promise<IDBPDatabase<SyncDatabase>> | undefined;

  function database() {
    connection ??= openDB<SyncDatabase>(name, 1, {
      upgrade(db) {
        db.createObjectStore("state");
        db.createObjectStore("base");
      },
      blocking() {
        void connection?.then((db) => db.close());
        connection = undefined;
      },
      terminated() {
        connection = undefined;
      },
    }).catch((error: unknown) => {
      connection = undefined;
      throw error;
    });
    return connection;
  }

  return {
    async read() {
      const db = await database();
      const tx = db.transaction(["state", "base"], "readwrite");
      let state = await tx.objectStore("state").get(stateKey);
      if (!state) {
        state = freshState();
        await tx.objectStore("state").put(state, stateKey);
      }
      const rows = await tx.objectStore("base").getAll();
      await tx.done;
      return { state, base: new Map(rows.map((row) => [baseKey(row), row])) };
    },

    async update(change) {
      const db = await database();
      const tx = db.transaction(["state", "base"], "readwrite");
      const settled = tx.done.catch(() => {});
      try {
        const states = tx.objectStore("state");
        const base = tx.objectStore("base");
        const current = (await states.get(stateKey)) ?? freshState();
        await states.put({ ...current, ...change.state }, stateKey);
        for (const key of change.deleteBase ?? []) await base.delete(key);
        for (const row of change.setBase ?? []) await base.put(row, baseKey(row));
        await tx.done;
      } catch (error) {
        try {
          tx.abort();
        } catch {
          // Already aborted.
        }
        await settled;
        throw error;
      }
    },

    async clear() {
      const open = connection;
      connection = undefined;
      try {
        (await open)?.close();
      } catch {
        // A failed open leaves nothing to close.
      }
      await deleteDB(name);
    },
  };
}

/** Volatile implementation for tests and for builds without IndexedDB. */
export function createMemoryMeta(): SyncMeta {
  let state = freshState();
  let base = new Map<string, BaseRecord>();
  return {
    async read() {
      return { state: structuredClone(state), base: new Map(base) };
    },
    async update(change) {
      state = structuredClone({ ...state, ...change.state });
      const next = new Map(base);
      for (const key of change.deleteBase ?? []) next.delete(key);
      for (const row of change.setBase ?? []) next.set(baseKey(row), structuredClone(row));
      base = next;
    },
    async clear() {
      state = freshState();
      base = new Map();
    },
  };
}
