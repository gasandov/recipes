/** Wire and storage types shared by the sync engine, the Supabase transport and the UI. */

export const collections = [
  "recipes", "categories", "ingredients", "ingredient_overrides", "shared_ingredients",
  "menu", "photos", "shopping_items", "shopping_balances", "shopping_checked",
] as const;
export type Collection = (typeof collections)[number];

export type JsonObject = { [key: string]: unknown };

/** The data of one record, without photo bytes. Every record carries its own stable `id`. */
export type RecordData = JsonObject & { id: string };

/** A server row. `data` is null for a tombstone. */
export type RemoteRow = {
  collection: Collection;
  id: string;
  revision: number;
  /** Feed position of the first revision. Orders menu batches and manual shopping items. */
  createdSeq: number;
  /** Feed position of the latest revision. Devices pull `changeSeq > cursor`. */
  changeSeq: number;
  deleted: boolean;
  data: RecordData | null;
  deviceId?: string | null;
  updatedAt?: string | null;
};

export type PushChange = {
  collection: Collection;
  id: string;
  /** The revision this device last saw, or null for a record it has never synchronized. */
  baseRevision: number | null;
  deleted: boolean;
  data?: RecordData;
};

export type PushResult = {
  collection: Collection;
  id: string;
  status: "ok" | "conflict" | "invalid" | "missing_blob";
  revision?: number;
  /** The server row after an accepted change, or the winning row of a conflict. */
  current?: Omit<RemoteRow, "collection" | "id">;
};

/** Transport used by the engine. The Supabase implementation lives in supabase-remote.ts. */
export interface SyncRemote {
  /** Rows with `changeSeq > afterSeq`, ordered by `changeSeq`. */
  pull(afterSeq: number, limit: number): Promise<RemoteRow[]>;
  push(deviceId: string, changes: PushChange[]): Promise<PushResult[]>;
  /** Idempotent: uploading the same photo ID again succeeds. */
  uploadPhoto(id: string, bytes: ArrayBuffer, mimeType: string): Promise<void>;
  downloadPhoto(id: string): Promise<ArrayBuffer>;
  /** Best effort cleanup of an object that no live record references any longer. */
  removePhoto(id: string): Promise<void>;
}

export type SyncErrorCode =
  /** The network or the service is unreachable. Retry later. */
  | "offline"
  /** The session is missing, expired or revoked. The person has to sign in again. */
  | "auth"
  /** The service rejected the request. */
  | "remote"
  /** The merged data failed local validation. Nothing was written. */
  | "invalid-data"
  /** The device holds personal data that belongs to another account. */
  | "foreign-account";

export class SyncError extends Error {
  constructor(readonly code: SyncErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SyncError";
  }
}

/** A change the engine made to repair a cross-record reference after a merge. */
export type RepairNote = {
  code: "ingredientLineRemoved" | "categoryRemoved" | "photoDetached" | "parentCleared" | "overrideDropped";
  /** The name of the affected record. */
  subject: string;
};

export type SyncNotice =
  | { code: "editDiscardedByDelete"; collection: Collection; name: string }
  | { code: "repaired"; note: RepairNote };

/** A record both this device and another one changed since they last agreed. */
export type StoredConflict = {
  key: string;
  collection: Collection;
  id: string;
  remote: {
    revision: number;
    createdSeq: number;
    changeSeq: number;
    data: RecordData;
    deviceId?: string | null;
    updatedAt?: string | null;
  };
};

/** What this device knows about the server version of a record. This is the base of the local diff. */
export type BaseRecord = {
  collection: Collection;
  id: string;
  revision: number;
  deleted: boolean;
  /** Canonical JSON of the data at `revision`, null for a tombstone. */
  json: string | null;
  order: number;
  /**
   * Photos only: this device has had the photo in its library, so it may delete it. A photo whose metadata this
   * device only saw (for example the account's side of an open recipe conflict) is never deleted from here.
   */
  held?: boolean;
};

export type SyncMetaState = {
  version: 1;
  /** Identifies this installation in `device_id`. It changes after the local data is cleared. */
  deviceId: string;
  /** The account that owns the personal data on this device. */
  userId?: string;
  /** Profile details of that account, so the account page still has a face when the app starts offline. */
  account?: { email?: string; name?: string; avatarUrl?: string };
  cursor: number;
  initialized: boolean;
  conflicts: StoredConflict[];
  lastSyncedAt?: number;
};

/** A change to a record the person can review. `local` and `remote` are absent for a deletion. */
export type ConflictView = {
  key: string;
  collection: Collection;
  local?: RecordData;
  remote?: RecordData;
  remoteDeviceId?: string | null;
  remoteUpdatedAt?: string | null;
};
