import { BackupError, planMerge } from "../backup";
import type { MergeChoice, MergeConflict, PersonalSnapshot } from "../backup";
import type { Category } from "../contracts";
import { sharedIngredientCatalog } from "../data/catalog";
import type { SharedIngredientCatalog } from "../data/catalog";
import { initialCategories } from "../data/seed";
import {
  assembleSnapshot, buildShopping, canonicalJson, makeRecord, planSnapshot, recordKey, recordName, snapshotRecords,
} from "./records";
import type { DesiredRecord, SyncRecord, SyncSnapshot } from "./records";
import { baseKey } from "./meta";
import type { SyncMeta } from "./meta";
import { SyncError } from "./types";
import type {
  BaseRecord, Collection, ConflictView, PushChange, PushResult, RecordData, RemoteRow, StoredConflict,
  SyncNotice, SyncRemote,
} from "./types";

/** The local personal library. `backupRepository` from F1 implements it. */
export interface LocalLibrary {
  prepareRestore(): Promise<{
    local: PersonalSnapshot;
    validate(snapshot: PersonalSnapshot): PersonalSnapshot;
    commit(snapshot: PersonalSnapshot): Promise<void>;
  }>;
  commitSnapshot(snapshot: PersonalSnapshot): Promise<void>;
}

export type EngineDeps = {
  local: LocalLibrary;
  remote: SyncRemote;
  meta: SyncMeta;
  userId: string;
  catalog?: SharedIngredientCatalog;
  seedCategories?: readonly Category[];
  pageSize?: number;
  maxPasses?: number;
};

export type ChoiceSide = "local" | "remote";

export type PendingSummary = {
  /** Records this device changed that the account does not have yet. */
  changes: number;
  /** Records waiting for the person to choose a version. */
  conflicts: number;
};

export type CycleReport = {
  pushed: number;
  /** Records written to this device from the account. */
  applied: number;
  conflicts: number;
  /** Changes the service refused. They stay queued. */
  rejected: number;
  notices: SyncNotice[];
  /** False when the passes ran out before the device and the account agreed. */
  settled: boolean;
  /** True when the local library was rewritten and the interface has to reload. */
  localChanged: boolean;
};

export type FirstSyncPlan = {
  conflicts: ConflictView[];
  /** Names of ingredients and categories from both sides, for describing the records. */
  names: ReadonlyMap<string, string>;
  localCount: number;
  accountCount: number;
  notices: SyncNotice[];
  /** Writes the merged library and the sync metadata. Every conflict needs a choice. */
  apply(choices: ReadonlyMap<string, ChoiceSide>): Promise<void>;
};

const unordered = Number.MAX_SAFE_INTEGER;
const noDeleteTombstone: readonly Collection[] = ["shared_ingredients"];
const quietCollections: readonly Collection[] = ["photos", "shared_ingredients"];
const f1Collections: Record<string, Collection> = {
  recipes: "recipes", categories: "categories", ingredients: "ingredients",
  ingredientOverrides: "ingredient_overrides", photos: "photos", menu: "menu",
};

/** The record content of a snapshot row. Photo bytes are not part of a record. */
function rowData(row: object): RecordData {
  const { bytes: _bytes, ...rest } = row as Record<string, unknown>;
  return JSON.parse(JSON.stringify(rest)) as RecordData;
}

const parsePhotoKey = (key: string) => ({ id: (JSON.parse(key) as [string, string])[1] });

const asRow = (conflict: StoredConflict): RemoteRow => ({
  collection: conflict.collection, id: conflict.id, deleted: false, ...conflict.remote,
});

export const baseFromRow = (row: RemoteRow, held?: boolean): BaseRecord => ({
  collection: row.collection, id: row.id, revision: row.revision, deleted: row.deleted,
  json: row.deleted || !row.data ? null : canonicalJson(row.data), order: row.createdSeq,
  ...(held === undefined ? {} : { held }),
});

/** How a local record differs from the revision this device last agreed on. */
function localChange(local: SyncRecord | undefined, base: BaseRecord | undefined, collection: Collection): "upsert" | "delete" | undefined {
  const baseJson = base && !base.deleted ? base.json ?? undefined : undefined;
  if (local?.json === baseJson) return undefined;
  if (!local) {
    if (noDeleteTombstone.includes(collection)) return undefined;
    // A photo this device never held is not its to delete. Another device may still be about to reference it.
    if (collection === "photos" && !base?.held) return undefined;
    return "delete";
  }
  return "upsert";
}

function names(snapshots: readonly PersonalSnapshot[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const snapshot of snapshots) {
    for (const entry of [...snapshot.sharedIngredients, ...snapshot.ingredients, ...snapshot.categories]) out.set(entry.id, entry.name);
    for (const entry of snapshot.ingredientOverrides) if (entry.name) out.set(entry.id, entry.name);
  }
  return out;
}

export function createSyncEngine(deps: EngineDeps) {
  const { local, remote, meta, userId } = deps;
  const catalog = deps.catalog ?? sharedIngredientCatalog;
  const seeds = deps.seedCategories ?? initialCategories;
  const pageSize = deps.pageSize ?? 500;
  const maxPasses = deps.maxPasses ?? 6;

  function assertOwner(state: { userId?: string }) {
    if (state.userId !== undefined && state.userId !== userId) {
      throw new SyncError("foreign-account", "This device holds data from another account.");
    }
  }

  async function pullAll(cursor: number) {
    const rows = new Map<string, RemoteRow>();
    let max = cursor;
    let after = cursor;
    for (;;) {
      const page = await remote.pull(after, pageSize);
      for (const row of page) {
        rows.set(recordKey(row.collection, row.id), row);
        max = Math.max(max, row.changeSeq);
      }
      if (page.length < pageSize) break;
      after = page[page.length - 1]!.changeSeq;
    }
    return { rows, max };
  }

  type Library = Awaited<ReturnType<LocalLibrary["prepareRestore"]>>;

  function localSnapshot(library: Library): SyncSnapshot {
    return library.local as SyncSnapshot;
  }

  /** Rebuilds the whole local library from records, downloading the bytes of photos it does not have. */
  async function writeLibrary(
    library: Library, desired: Map<string, DesiredRecord>, orderOf: (key: string) => number,
  ): Promise<{ notices: SyncNotice[]; photoIds: Set<string> }> {
    const { parts, notes, photoIds } = planSnapshot(desired.values(), catalog, orderOf);
    const bytes = new Map(library.local.photos.map((photo) => [photo.id, photo.bytes]));
    for (const id of photoIds) if (!bytes.has(id)) bytes.set(id, await remote.downloadPhoto(id));
    try {
      const snapshot = assembleSnapshot(parts, catalog, library.local.catalogVersion, bytes);
      await library.commit(library.validate(snapshot));
    } catch (error) {
      if (error instanceof BackupError && error.code !== "stale") {
        throw new SyncError("invalid-data", "The merged library failed validation.", { cause: error });
      }
      throw error;
    }
    return { notices: notes.map((note) => ({ code: "repaired" as const, note })), photoIds: new Set(photoIds) };
  }

  /**
   * A recipe can arrive before or without its photo row in this pull. The photo's metadata is in the base, so the
   * recipe keeps its photo and the bytes are downloaded when the library is written.
   */
  function addBasePhotos(desired: Map<string, DesiredRecord>, base: ReadonlyMap<string, BaseRecord>) {
    for (const { collection, data } of [...desired.values()]) {
      const photoId = collection === "recipes" ? data.photoId : undefined;
      if (typeof photoId !== "string") continue;
      const key = recordKey("photos", photoId);
      const known = base.get(key);
      if (!desired.has(key) && known && !known.deleted && known.json) {
        desired.set(key, { collection: "photos", id: photoId, data: JSON.parse(known.json) as RecordData });
      }
    }
  }

  const desiredFrom = (records: ReadonlyMap<string, SyncRecord>) =>
    new Map<string, DesiredRecord>([...records].map(([key, { collection, id, data }]) => [key, { collection, id, data }]));

  async function pushChanges(changes: PushChange[]): Promise<PushResult[]> {
    // A recipe and its photo travel in the same transaction so another device never sees one without the other.
    const photoOf = new Map(changes.filter(({ collection, deleted }) => collection === "photos" && !deleted)
      .map((change) => [change.id, change]));
    const grouped = new Set<PushChange>();
    const groups: PushChange[][] = [];
    for (const change of changes) {
      if (grouped.has(change)) continue;
      const photoId = change.collection === "recipes" ? (change.data?.photoId as string | undefined) : undefined;
      const photo = photoId === undefined ? undefined : photoOf.get(photoId);
      const group = photo && !grouped.has(photo) ? [photo, change] : [change];
      for (const member of group) grouped.add(member);
      groups.push(group);
    }
    const batches: PushChange[][] = [[]];
    for (const group of groups) {
      if (batches.at(-1)!.length + group.length > 200) batches.push([]);
      batches.at(-1)!.push(...group);
    }

    const results: PushResult[] = [];
    for (const batch of batches.filter((entry) => entry.length)) {
      try {
        results.push(...await remote.push(await currentDevice(), batch));
      } catch (error) {
        if (!(error instanceof SyncError) || error.code !== "remote" || batch.length === 1) throw error;
        // One malformed record must not block the others. Send them one by one.
        for (const change of batch) {
          try {
            results.push(...await remote.push(await currentDevice(), [change]));
          } catch (single) {
            if (!(single instanceof SyncError) || single.code !== "remote") throw single;
            results.push({ collection: change.collection, id: change.id, status: "invalid" });
          }
        }
      }
    }
    return results;
  }

  async function currentDevice(): Promise<string> {
    return (await meta.read()).state.deviceId;
  }

  type PassOutcome = {
    progress: boolean;
    pushed: number;
    applied: number;
    conflicts: number;
    rejected: number;
    notices: SyncNotice[];
    localChanged: boolean;
    stale: boolean;
  };

  /** One pull, reconcile, apply and push round. */
  async function pass(): Promise<PassOutcome> {
    const { state, base } = await meta.read();
    assertOwner(state);
    const { rows, max } = await pullAll(state.cursor);
    const library = await local.prepareRestore();
    const localRecords = snapshotRecords(localSnapshot(library));
    const conflicts = new Map(state.conflicts.map((conflict) => [conflict.key, conflict]));
    const baseSets = new Map<string, BaseRecord>();
    const baseDeletes = new Set<string>();
    const adopt = new Map<string, RemoteRow>();
    const pushes = new Map<string, { collection: Collection; id: string; record?: SyncRecord; baseRevision: number | null }>();
    const notices: SyncNotice[] = [];
    const outcome: PassOutcome = {
      progress: false, pushed: 0, applied: 0, conflicts: 0, rejected: 0, notices, localChanged: false, stale: false,
    };

    // Photos are reconciled last, once every recipe conflict is known.
    const isPhoto = (key: string) => key.startsWith('["photos",');
    const keys = [...new Set([...localRecords.keys(), ...base.keys(), ...rows.keys(), ...conflicts.keys()])]
      .sort((a, b) => Number(isPhoto(a)) - Number(isPhoto(b)));
    let keptPhotos: Set<string> | undefined;
    for (const key of keys) {
      if (isPhoto(key)) {
        // While a recipe conflict is open, the photo of this device's version stays in the library and nothing is
        // sent for it. The account may have removed that photo; the person's choice decides whether it returns.
        keptPhotos ??= new Set([...conflicts.values()].flatMap(({ collection, key: recipeKey }) => {
          const photoId = collection === "recipes" ? localRecords.get(recipeKey)?.data.photoId : undefined;
          return typeof photoId === "string" ? [photoId] : [];
        }));
        const { id } = parsePhotoKey(key);
        if (keptPhotos.has(id)) {
          const row = rows.get(key);
          if (row?.deleted && row.revision > (base.get(key)?.revision ?? 0)) baseSets.set(key, baseFromRow(row, false));
          continue;
        }
      }
      const localRecord = localRecords.get(key);
      const parsed = localRecord ?? base.get(key) ?? rows.get(key) ?? conflicts.get(key)!;
      const { collection, id } = parsed;
      let remoteRow = rows.get(key);
      let known = base.get(key);
      let remoteChanged = !!remoteRow && remoteRow.revision > (known?.revision ?? 0);
      const open = conflicts.get(key);

      // A live row written by this device is a push whose acknowledgement never arrived.
      if (remoteRow && remoteChanged && !open && !remoteRow.deleted && remoteRow.deviceId === state.deviceId) {
        // A photo this device wrote was in its library, even if the recipe was deleted since.
        known = baseFromRow(remoteRow, collection === "photos" ? true : undefined);
        baseSets.set(key, known);
        remoteChanged = false;
      }

      const change = localChange(localRecord, known, collection);
      const label = recordName(localRecord?.data, id);
      const remoteJson = remoteRow?.data ? canonicalJson(remoteRow.data) : undefined;

      const takeRemote = (row: RemoteRow) => {
        baseSets.set(key, baseFromRow(row, collection === "photos" ? !!localRecord : undefined));
        if (row.deleted ? localRecord : localRecord?.json !== canonicalJson(row.data)) adopt.set(key, row);
      };
      const discard = (row: RemoteRow) => {
        if (change === "upsert" && !quietCollections.includes(collection)) {
          notices.push({ code: "editDiscardedByDelete", collection, name: label });
        }
        takeRemote(row);
      };

      if (open) {
        // Wait for the person's choice. A newer server version replaces the stored one.
        const latest = remoteRow && remoteChanged ? remoteRow : asRow(open);
        if (latest.deleted) {
          discard(latest);
          conflicts.delete(key);
        } else if (localRecord && canonicalJson(latest.data) === localRecord.json) {
          takeRemote(latest);
          conflicts.delete(key);
        } else if (!localRecord) {
          // Deleting wins over the concurrent edit.
          conflicts.delete(key);
          baseSets.set(key, baseFromRow(latest, collection === "photos" ? known?.held : undefined));
          pushes.set(key, { collection, id, baseRevision: latest.revision });
        } else if (remoteRow && remoteChanged && remoteRow.data) {
          conflicts.set(key, {
            key, collection, id,
            remote: {
              revision: remoteRow.revision, createdSeq: remoteRow.createdSeq, changeSeq: remoteRow.changeSeq,
              data: remoteRow.data, deviceId: remoteRow.deviceId, updatedAt: remoteRow.updatedAt,
            },
          });
        }
        continue;
      }

      if (!remoteChanged) {
        if (change) pushes.set(key, { collection, id, record: localRecord, baseRevision: known?.revision ?? null });
        continue;
      }
      remoteRow = remoteRow!;
      if (!change) {
        takeRemote(remoteRow);
      } else if (remoteRow.deleted) {
        discard(remoteRow);
      } else if (change === "delete") {
        // Deleting wins over the concurrent edit. The server accepts the delete from any revision.
        baseSets.set(key, baseFromRow(remoteRow, collection === "photos" ? known?.held : undefined));
        pushes.set(key, { collection, id, baseRevision: remoteRow.revision });
      } else if (remoteJson === localRecord!.json || quietCollections.includes(collection)) {
        takeRemote(remoteRow);
      } else {
        conflicts.set(key, {
          key, collection, id,
          remote: {
            revision: remoteRow.revision, createdSeq: remoteRow.createdSeq, changeSeq: remoteRow.changeSeq,
            data: remoteRow.data!, deviceId: remoteRow.deviceId, updatedAt: remoteRow.updatedAt,
          },
        });
        outcome.conflicts++;
      }
    }

    const orderOf = (key: string) => baseSets.get(key)?.order ?? base.get(key)?.order ?? unordered;
    if (adopt.size) {
      const desired = desiredFrom(localRecords);
      for (const [key, row] of adopt) {
        if (row.deleted || !row.data) desired.delete(key);
        else desired.set(key, { collection: row.collection, id: row.id, data: row.data });
      }
      addBasePhotos(desired, new Map([...base, ...baseSets]));
      try {
        const written = await writeLibrary(library, desired, orderOf);
        notices.push(...written.notices);
        // A photo that stayed in the library is now held by this device. One that repair dropped is not.
        for (const id of written.photoIds) {
          const key = recordKey("photos", id);
          const known = baseSets.get(key) ?? base.get(key);
          if (known && !known.deleted && !known.held) baseSets.set(key, { ...known, held: true });
        }
        for (const [key, record] of baseSets) {
          if (record.collection === "photos" && !record.deleted && !written.photoIds.has(record.id)) baseSets.set(key, { ...record, held: false });
        }
      } catch (error) {
        if (error instanceof BackupError && error.code === "stale") return { ...outcome, progress: true, stale: true };
        throw error;
      }
      outcome.applied = adopt.size;
      outcome.localChanged = true;
    }

    outcome.conflicts = conflicts.size;
    await meta.update({
      state: { cursor: max, conflicts: [...conflicts.values()] },
      setBase: [...baseSets.values()],
      deleteBase: [...baseDeletes],
    });
    if (adopt.size || baseSets.size) outcome.progress = true;

    // Push. Photo bytes go first so the service can verify them when the metadata arrives.
    const queued = [...pushes.entries()].filter(([key]) => !adopt.has(key));
    if (queued.length) {
      const photos = new Map(library.local.photos.map((photo) => [photo.id, photo]));
      const changes: PushChange[] = [];
      for (const [, { collection, id, record, baseRevision }] of queued) {
        if (record) {
          if (collection === "photos") {
            const photo = photos.get(id);
            if (!photo) continue;
            await remote.uploadPhoto(id, photo.bytes, photo.mimeType);
          }
          changes.push({ collection, id, baseRevision, deleted: false, data: record.data });
        } else {
          changes.push({ collection, id, baseRevision, deleted: true });
        }
      }

      const results = await pushChanges(changes);
      const acknowledged: BaseRecord[] = [];
      const forgotten: string[] = [];
      for (const result of results) {
        const key = recordKey(result.collection, result.id);
        const push = pushes.get(key);
        if (!push) continue;
        if (result.status === "ok") {
          outcome.pushed++;
          if (!push.record) {
            if (!result.revision) forgotten.push(key);
            else acknowledged.push({
              collection: push.collection, id: push.id, revision: result.revision, deleted: true, json: null,
              order: result.current?.createdSeq ?? base.get(key)?.order ?? 0,
            });
            if (push.collection === "photos") await remote.removePhoto(push.id).catch(() => {});
          } else {
            acknowledged.push({
              collection: push.collection, id: push.id, revision: result.revision!, deleted: false, json: push.record.json,
              order: result.current?.createdSeq ?? base.get(key)?.order ?? 0,
              ...(push.collection === "photos" ? { held: true } : {}),
            });
          }
        } else if (result.status === "conflict") {
          // The next pass pulls the winning version and reconciles it.
          outcome.progress = true;
        } else {
          outcome.rejected++;
        }
      }
      if (acknowledged.length || forgotten.length) {
        await meta.update({ setBase: acknowledged, deleteBase: forgotten });
      }
      if (outcome.pushed) outcome.progress = true;
    }
    return outcome;
  }

  return {
    /** Counts what this device has not shared yet. It reads local data only, so it works offline. */
    async pending(): Promise<PendingSummary> {
      const { state, base } = await meta.read();
      const library = await local.prepareRestore();
      const records = snapshotRecords(localSnapshot(library));
      const seedJson = new Set(seeds.map((seed) => recordKey("categories", seed.id) + canonicalJson(seed)));
      const conflicts = new Set(state.conflicts.map((conflict) => conflict.key));
      let changes = 0;
      for (const key of new Set([...records.keys(), ...base.keys()])) {
        const record = records.get(key);
        const { collection } = record ?? base.get(key)!;
        if (quietCollections.includes(collection) || conflicts.has(key)) continue;
        if (!state.initialized && record && seedJson.has(key + record.json)) continue;
        if (localChange(record, base.get(key), collection)) changes++;
      }
      return { changes, conflicts: conflicts.size };
    },

    /** Reconciles this device with the account until both agree, or the pass limit is reached. */
    async cycle(): Promise<CycleReport> {
      const report: CycleReport = {
        pushed: 0, applied: 0, conflicts: 0, rejected: 0, notices: [], settled: false, localChanged: false,
      };
      for (let index = 0; index < maxPasses; index++) {
        const outcome = await pass();
        report.pushed += outcome.pushed;
        report.applied += outcome.applied;
        report.conflicts = outcome.conflicts;
        report.rejected = outcome.rejected;
        report.notices.push(...outcome.notices);
        report.localChanged ||= outcome.localChanged;
        if (!outcome.progress) {
          report.settled = true;
          break;
        }
      }
      if (report.settled) await meta.update({ state: { lastSyncedAt: Date.now() } });
      return report;
    },

    /** Conflicts waiting for a choice, with the current local version of each record. */
    async conflicts(): Promise<{ views: ConflictView[]; names: ReadonlyMap<string, string> }> {
      const { state } = await meta.read();
      const library = await local.prepareRestore();
      const records = snapshotRecords(localSnapshot(library));
      return {
        names: names([library.local]),
        views: state.conflicts.map((conflict) => ({
          key: conflict.key, collection: conflict.collection,
          local: records.get(conflict.key)?.data, remote: conflict.remote.data,
          remoteDeviceId: conflict.remote.deviceId, remoteUpdatedAt: conflict.remote.updatedAt,
        })),
      };
    },

    /**
     * Keeps this device's version (and shares it) or replaces it with the account's version. Choosing the account's
     * version needs the connection, because its photo may have to be downloaded.
     */
    async resolve(key: string, side: ChoiceSide): Promise<void> {
      const { state, base } = await meta.read();
      assertOwner(state);
      const conflict = state.conflicts.find((entry) => entry.key === key);
      if (!conflict) return;
      const rest = state.conflicts.filter((entry) => entry.key !== key);
      const row = asRow(conflict);
      const baseSets: BaseRecord[] = [baseFromRow(row)];
      const library = await local.prepareRestore();
      const records = snapshotRecords(localSnapshot(library));
      const remotePhoto = row.collection === "recipes" && typeof row.data?.photoId === "string" ? row.data.photoId : undefined;
      if (side === "remote") {
        const desired = desiredFrom(records);
        desired.set(key, { collection: row.collection, id: row.id, data: row.data! });
        addBasePhotos(desired, base);
        // Every other record keeps its place. Only the replaced row takes the position the server gave it.
        const written = await writeLibrary(library, desired, (candidate) => candidate === key ? row.createdSeq : base.get(candidate)?.order ?? unordered);
        if (remotePhoto !== undefined) {
          const photo = base.get(recordKey("photos", remotePhoto));
          if (photo && !photo.deleted && written.photoIds.has(remotePhoto)) baseSets.push({ ...photo, held: true });
        }
      } else if (remotePhoto !== undefined && remotePhoto !== records.get(key)?.data.photoId) {
        // The account's version loses, and its photo belonged only to that version. Let this device remove it.
        const photo = base.get(recordKey("photos", remotePhoto));
        if (photo && !photo.deleted) baseSets.push({ ...photo, held: true });
      }
      await meta.update({ state: { conflicts: rest }, setBase: baseSets });
    },

    /**
     * Prepares the first sign-in on this device: combines local records with the account's by stable ID,
     * reuses identical records and lists what needs a choice. Applying is atomic and checks that the local
     * library did not change meanwhile.
     */
    async prepareFirstSync(): Promise<FirstSyncPlan> {
      const { state } = await meta.read();
      assertOwner(state);
      const { rows, max } = await pullAll(0);
      const library = await local.prepareRestore();
      const localRecords = snapshotRecords(localSnapshot(library));
      const notices: SyncNotice[] = [];
      const orderOf = (key: string) => rows.get(key)?.createdSeq ?? unordered;

      const localDesired = desiredFrom(localRecords);
      for (const [key, row] of rows) {
        const record = localRecords.get(key);
        if (!row.deleted || !record) continue;
        // A photo that a local recipe still uses stays until the person chooses between the recipe versions.
        if (row.collection === "photos" && [...localRecords.values()].some((entry) => entry.collection === "recipes" && entry.data.photoId === row.id)) continue;
        // A deletion wins: this device must not recreate a record the account already removed.
        localDesired.delete(key);
        if (!quietCollections.includes(row.collection)) {
          notices.push({ code: "editDiscardedByDelete", collection: row.collection, name: recordName(record.data, row.id) });
        }
      }
      // A seeded category nobody changed here must not hide a rename made in the account.
      for (const seed of seeds) {
        const key = recordKey("categories", seed.id);
        const record = localRecords.get(key);
        const row = rows.get(key);
        if (record && row && !row.deleted && row.data && record.json === makeRecord("categories", seed as unknown as RecordData).json) {
          localDesired.set(key, { collection: "categories", id: seed.id, data: row.data });
        }
      }
      const remoteDesired = new Map<string, DesiredRecord>(
        [...rows].filter(([, row]) => !row.deleted && row.data)
          .map(([key, row]) => [key, { collection: row.collection, id: row.id, data: row.data! }]),
      );

      const localBytes = new Map(library.local.photos.map((photo) => [photo.id, photo.bytes]));
      async function snapshotOf(desired: Map<string, DesiredRecord>, order: (key: string) => number) {
        const { parts, notes, photoIds } = planSnapshot(desired.values(), catalog, order);
        const bytes = new Map(localBytes);
        for (const id of photoIds) if (!bytes.has(id)) bytes.set(id, await remote.downloadPhoto(id));
        try {
          return {
            snapshot: library.validate(assembleSnapshot(parts, catalog, library.local.catalogVersion, bytes)) as SyncSnapshot,
            notes,
          };
        } catch (error) {
          if (error instanceof BackupError) throw new SyncError("invalid-data", "The data failed validation.", { cause: error });
          throw error;
        }
      }
      const mine = await snapshotOf(localDesired, () => unordered);
      const theirs = await snapshotOf(remoteDesired, orderOf);
      notices.push(...mine.notes.map((note) => ({ code: "repaired" as const, note })));

      const { shopping: _mine, ...mineLibrary } = mine.snapshot;
      const { shopping: _theirs, ...theirsLibrary } = theirs.snapshot;
      const merge = planMerge(mineLibrary, theirsLibrary);
      // Shopping was removed from both inputs, so only record collections can conflict here.
      const libraryConflicts = merge.conflicts.filter(
        (conflict): conflict is Exclude<MergeConflict, { collection: "shopping" }> => conflict.collection !== "shopping");

      // F5 shopping rows merge by their own stable keys.
      const isShopping = (collection: Collection) => collection.startsWith("shopping_");
      const shoppingMine = snapshotRecords(mine.snapshot);
      const shoppingTheirs = snapshotRecords(theirs.snapshot);
      const shoppingConflicts: ConflictView[] = [];
      for (const [key, record] of shoppingMine) {
        const other = shoppingTheirs.get(key);
        if (isShopping(record.collection) && other && other.json !== record.json) {
          shoppingConflicts.push({ key, collection: record.collection, local: record.data, remote: other.data });
        }
      }

      const conflicts: ConflictView[] = [
        ...libraryConflicts.map((conflict) => {
          const collection = f1Collections[conflict.collection]!;
          const row = rows.get(recordKey(collection, (conflict.local ?? conflict.incoming)!.id));
          return {
            key: conflict.key, collection,
            local: conflict.local ? rowData(conflict.local) : undefined,
            remote: conflict.incoming ? rowData(conflict.incoming) : undefined,
            remoteDeviceId: row?.deviceId, remoteUpdatedAt: row?.updatedAt,
          };
        }),
        ...shoppingConflicts,
      ];

      return {
        conflicts,
        names: names([mine.snapshot, theirs.snapshot]),
        localCount: [...shoppingMine.values()].filter(({ collection }) => !quietCollections.includes(collection)).length,
        accountCount: [...rows.values()].filter((row) => !row.deleted && !quietCollections.includes(row.collection)).length,
        notices,
        async apply(choices) {
          if (conflicts.some(({ key }) => !choices.has(key))) {
            throw new BackupError("conflicts", "Every changed duplicate needs a decision.");
          }
          const f1Choices = new Map<string, MergeChoice>(
            merge.conflicts.map(({ key }) => [key, choices.get(key) === "remote" ? "incoming" : "local"]),
          );
          const merged = merge.resolve(f1Choices);
          const shopping = [...new Set([...shoppingMine.keys(), ...shoppingTheirs.keys()])].flatMap((key) => {
            const mineRecord = shoppingMine.get(key);
            const theirRecord = shoppingTheirs.get(key);
            const record = !mineRecord || (theirRecord && choices.get(key) === "remote") ? theirRecord : mineRecord;
            return record && isShopping(record.collection) ? [{ collection: record.collection, id: record.id, data: record.data }] : [];
          });
          const mergedShopping = buildShopping(shopping, orderOf);
          const snapshot = library.validate({ ...merged, ...(mergedShopping ? { shopping: mergedShopping } : {}) } as PersonalSnapshot);
          await library.commit(snapshot);
          const kept = new Set(snapshot.photos.map(({ id }) => id));
          await meta.update({
            state: { userId, initialized: true, cursor: max, conflicts: [] },
            setBase: [...rows.values()].map((row) => baseFromRow(row, row.collection === "photos" ? kept.has(row.id) : undefined)),
          });
        },
      };
    },

    /** The empty library of a fresh install. Used when this device signs out. */
    async clearLocal(): Promise<void> {
      await local.commitSnapshot({
        catalogVersion: catalog.version, sharedIngredients: [], ingredients: [], ingredientOverrides: [],
        categories: [...seeds], recipes: [], photos: [], menu: [],
      });
      await meta.clear();
    },
  };
}

export { baseKey };
