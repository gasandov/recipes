import type { SupabaseClient } from "@supabase/supabase-js";
import { SyncError } from "./types";
import type { Collection, PushChange, PushResult, RecordData, RemoteRow, SyncRemote } from "./types";

export const photoBucket = "recipe-photos";

type FeedRow = {
  collection: Collection;
  record_id: string;
  revision: number | string;
  created_seq: number | string;
  change_seq: number | string;
  deleted: boolean;
  data: RecordData | null;
  device_id: string | null;
  updated_at: string | null;
};

const feedColumns = "collection, record_id, revision, created_seq, change_seq, deleted, data, device_id, updated_at";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Object path of a photo. It matches the check in `sync_push`, which accepts any photo ID. */
export async function photoPath(userId: string, photoId: string): Promise<string> {
  return `${userId}/${await sha256Hex(photoId)}`;
}

type ServiceError = { message?: string; status?: number; statusCode?: string | number; code?: string };

/** Separates a missing connection or session from a rejected request. */
export function toSyncError(error: unknown): SyncError {
  if (error instanceof SyncError) return error;
  const detail = (error ?? {}) as ServiceError;
  const message = detail.message ?? String(error);
  const status = Number(detail.status ?? detail.statusCode ?? 0);
  if (typeof navigator !== "undefined" && navigator.onLine === false) return new SyncError("offline", message, { cause: error });
  if (/failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout|aborted/i.test(message)) {
    return new SyncError("offline", message, { cause: error });
  }
  if (status === 401 || status === 403 || detail.code === "PGRST301" || /jwt|not authenticated/i.test(message) || detail.code === "28000") {
    return new SyncError("auth", message, { cause: error });
  }
  // A busy or unavailable service is retried like a lost connection.
  if (status >= 500 || status === 429) return new SyncError("offline", message, { cause: error });
  return new SyncError("remote", message, { cause: error });
}

/** Talks to the `sync_records` table, the `sync_push` function and the private photo bucket. */
export function createSupabaseRemote(client: SupabaseClient, userId: string): SyncRemote {
  return {
    async pull(afterSeq, limit) {
      const { data, error } = await client.from("sync_records").select(feedColumns)
        .eq("owner_id", userId).gt("change_seq", afterSeq).order("change_seq", { ascending: true }).limit(limit)
        .overrideTypes<FeedRow[], { merge: false }>();
      if (error) throw toSyncError(error);
      return data.map((row): RemoteRow => ({
        collection: row.collection, id: row.record_id, revision: Number(row.revision),
        createdSeq: Number(row.created_seq), changeSeq: Number(row.change_seq),
        deleted: row.deleted, data: row.data, deviceId: row.device_id, updatedAt: row.updated_at,
      }));
    },

    async push(deviceId, changes: PushChange[]) {
      // The captured account is checked against the session on the server. A batch queued for one account can
      // therefore never be written after another tab signed in as someone else.
      const { data, error } = await client.rpc("sync_push", {
        p_owner_id: userId,
        p_device_id: deviceId,
        p_changes: changes.map(({ collection, id, baseRevision, deleted, data }) => ({
          collection, id, baseRevision, deleted, ...(deleted ? {} : { data }),
        })),
      });
      if (error) throw toSyncError(error);
      return (data as { collection: Collection; id: string; status: PushResult["status"]; revision?: number; current?: Record<string, unknown> }[])
        .map((result): PushResult => ({
          collection: result.collection, id: result.id, status: result.status, revision: result.revision,
          current: result.current ? {
            revision: Number(result.current.revision), createdSeq: Number(result.current.createdSeq),
            changeSeq: Number(result.current.changeSeq), deleted: Boolean(result.current.deleted),
            data: (result.current.data ?? null) as RecordData | null,
            deviceId: result.current.deviceId as string | null, updatedAt: result.current.updatedAt as string | null,
          } : undefined,
        }));
    },

    async uploadPhoto(id, bytes, mimeType) {
      const { error } = await client.storage.from(photoBucket)
        .upload(await photoPath(userId, id), new Blob([bytes], { type: mimeType }), { contentType: mimeType, upsert: false });
      // Photo IDs are never reused for other bytes, so an existing object is the same upload.
      const detail = error as (ServiceError & { error?: string }) | null;
      if (error && !(String(detail?.statusCode) === "409" || detail?.error === "Duplicate" || /already exists|duplicate/i.test(error.message))) {
        throw toSyncError(error);
      }
    },

    async downloadPhoto(id) {
      const { data, error } = await client.storage.from(photoBucket).download(await photoPath(userId, id));
      if (error) throw toSyncError(error);
      return data.arrayBuffer();
    },

    async removePhoto(id) {
      const { error } = await client.storage.from(photoBucket).remove([await photoPath(userId, id)]);
      if (error) throw toSyncError(error);
    },
  };
}
