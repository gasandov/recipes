import { SyncError } from "./types";
import type { Collection, PushChange, PushResult, RecordData, RemoteRow, SyncRemote } from "./types";

type Stored = RemoteRow;

/**
 * In-memory server that implements the same rules as `public.sync_push` in the account sync migration.
 * Tests use it to exercise the engine deterministically. The pgTAP suite checks the SQL itself.
 */
export function createFakeServer() {
  type Account = { seq: number; rows: Map<string, Stored>; photos: Map<string, ArrayBuffer> };
  const accounts = new Map<string, Account>();
  const account = (userId: string): Account => {
    let entry = accounts.get(userId);
    if (!entry) accounts.set(userId, entry = { seq: 0, rows: new Map(), photos: new Map() });
    return entry;
  };
  const key = (collection: Collection, id: string) => JSON.stringify([collection, id]);
  const same = (left: unknown, right: unknown) => JSON.stringify(sort(left)) === JSON.stringify(sort(right));
  function sort(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => [k, sort(v)]));
    }
    return value;
  }
  const view = (row: Stored): NonNullable<PushResult["current"]> => {
    const { collection: _c, id: _i, ...rest } = row;
    return structuredClone(rest);
  };

  let online = true;
  let beforePush: (() => void) | undefined;

  function remoteFor(userId: string, options: { failPushOnce?: boolean } = {}): SyncRemote {
    let failPush = options.failPushOnce ?? false;
    const guard = () => {
      if (!online) throw new SyncError("offline", "offline");
    };
    return {
      async pull(afterSeq, limit) {
        guard();
        return [...account(userId).rows.values()].filter((row) => row.changeSeq > afterSeq)
          .sort((a, b) => a.changeSeq - b.changeSeq).slice(0, limit).map((row) => structuredClone(row));
      },

      async push(deviceId, changes: PushChange[]) {
        guard();
        beforePush?.();
        const state = account(userId);
        const results: PushResult[] = [];
        const lostAck = failPush;
        failPush = false;
        for (const change of changes) {
          const k = key(change.collection, change.id);
          const row = state.rows.get(k);
          const base = { collection: change.collection, id: change.id };
          const apply = (next: Partial<Stored>, created = false) => {
            state.seq++;
            const updated: Stored = {
              ...base, revision: (row?.revision ?? 0) + 1, createdSeq: row?.createdSeq ?? state.seq,
              changeSeq: state.seq, deleted: false, data: null, deviceId, updatedAt: new Date(0).toISOString(), ...next,
            };
            if (created) updated.revision = 1;
            state.rows.set(k, updated);
            results.push({ ...base, status: "ok", revision: updated.revision, current: view(updated) });
          };
          if (change.deleted) {
            if (!row) results.push({ ...base, status: "ok", revision: 0 });
            else if (row.deleted) results.push({ ...base, status: "ok", revision: row.revision });
            else apply({ deleted: true, data: null });
            continue;
          }
          if (!change.data || change.data.id !== change.id) {
            results.push({ ...base, status: "invalid" });
            continue;
          }
          if (change.collection === "photos" && !state.photos.has(change.id)) {
            results.push({ ...base, status: "missing_blob" });
            continue;
          }
          if (!row) {
            if (change.baseRevision !== null) results.push({ ...base, status: "conflict" });
            else apply({ data: structuredClone(change.data) }, true);
          } else if (!row.deleted && same(row.data, change.data)) {
            results.push({ ...base, status: "ok", revision: row.revision, current: view(row) });
          } else if (change.baseRevision === row.revision) {
            apply({ data: structuredClone(change.data) });
          } else {
            results.push({ ...base, status: "conflict", current: view(row) });
          }
        }
        if (lostAck) throw new SyncError("offline", "The response was lost.");
        return results;
      },

      async uploadPhoto(id, bytes) {
        guard();
        account(userId).photos.set(id, bytes.slice(0));
      },
      async downloadPhoto(id) {
        guard();
        const bytes = account(userId).photos.get(id);
        if (!bytes) throw new SyncError("remote", "Missing photo.");
        return bytes.slice(0);
      },
      async removePhoto(id) {
        account(userId).photos.delete(id);
      },
    };
  }

  return {
    remoteFor,
    setOnline(value: boolean) {
      online = value;
    },
    /** Runs before each push request reaches the server. Use it to inject another device's write. */
    onBeforePush(hook: (() => void) | undefined) {
      beforePush = hook;
    },
    rows: (userId: string) => [...account(userId).rows.values()],
    row: (userId: string, collection: Collection, id: string): Stored | undefined => account(userId).rows.get(key(collection, id)),
    data: (userId: string, collection: Collection, id: string): RecordData | null | undefined =>
      account(userId).rows.get(key(collection, id))?.data,
    hasPhoto: (userId: string, id: string) => account(userId).photos.has(id),
  };
}
