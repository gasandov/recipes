// Runs against a LOCAL Supabase stack only. Skipped unless both variables are set:
//   RECETARIO_TEST_SUPABASE_URL=http://127.0.0.1:54321
//   RECETARIO_TEST_SUPABASE_KEY=<publishable key printed by `supabase status`>
// Never point these at a hosted project: the test creates throwaway accounts.
import "fake-indexeddb/auto";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createBackupRepository } from "../backup";
import type { RecipeDraft } from "../contracts";
import { createRecipeRepository } from "../data/repository";
import { createSyncEngine } from "./engine";
import { createMemoryMeta } from "./meta";
import { createSupabaseRemote, photoPath } from "./supabase-remote";

const url = process.env.RECETARIO_TEST_SUPABASE_URL;
const key = process.env.RECETARIO_TEST_SUPABASE_KEY;
const local = url !== undefined && key !== undefined && /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);

const png = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64"));
const draft = (name: string): RecipeDraft => ({ name, enteredPortions: 4, ingredients: [], steps: [], categoryIds: [], tags: [] });

async function person(): Promise<{ client: SupabaseClient; id: string }> {
  const client = createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signUp({
    email: `sync-${crypto.randomUUID()}@example.test`, password: `pw-${crypto.randomUUID()}`,
  });
  if (error || !data.session || !data.user) throw error ?? new Error("Sign-up did not return a session.");
  return { client, id: data.user.id };
}

function installation(client: SupabaseClient, userId: string) {
  const name = `integration-${crypto.randomUUID()}`;
  const recipes = createRecipeRepository(name);
  const backups = createBackupRepository(name);
  const meta = createMemoryMeta();
  const engine = createSyncEngine({ local: backups, remote: createSupabaseRemote(client, userId), meta, userId });
  return { recipes, backups, engine };
}

describe.skipIf(!local)("local Supabase: account sync", () => {
  it("keeps one person's records, revisions and photos away from another", async () => {
    const [a, b] = [await person(), await person()];
    const remoteA = createSupabaseRemote(a.client, a.id);
    const remoteB = createSupabaseRemote(b.client, b.id);
    const change = { collection: "recipes" as const, id: "r1", baseRevision: null, deleted: false, data: { id: "r1", name: "Sopa" } };

    expect((await remoteA.push("device-a", [change]))[0]).toMatchObject({ status: "ok", revision: 1 });
    expect(await remoteB.pull(0, 100)).toEqual([]);
    expect((await remoteA.pull(0, 100)).map((row) => row.id)).toEqual(["r1"]);
    // The same ID under another account is a different record.
    expect((await remoteB.push("device-b", [{ ...change, data: { id: "r1", name: "Otra" } }]))[0]).toMatchObject({ status: "ok", revision: 1 });
    expect((await remoteA.pull(0, 100))[0]!.data).toMatchObject({ name: "Sopa" });

    // Clients cannot write the table directly or push for someone else.
    const direct = await b.client.from("sync_records").insert({ collection: "recipes", record_id: "x", revision: 1, created_seq: 1, change_seq: 1, data: { id: "x" } });
    expect(direct.error).toBeTruthy();
    const update = await b.client.from("sync_records").update({ data: { id: "r1", name: "hack" } }).eq("record_id", "r1").select();
    expect(update.data ?? []).toEqual([]);
    const spoof = await b.client.rpc("sync_push", { p_owner_id: a.id, p_device_id: "d", p_changes: [change] });
    expect(spoof.error).toBeTruthy();
    const anonymous = createClient(url!, key!, { auth: { persistSession: false } });
    expect((await anonymous.from("sync_records").select("record_id")).data ?? []).toEqual([]);

    // Tombstones: a delete wins and a stale client cannot bring the record back.
    expect((await remoteA.push("device-a", [{ ...change, baseRevision: 1, deleted: true, data: undefined }]))[0]).toMatchObject({ status: "ok", revision: 2 });
    expect((await remoteA.push("device-c", [{ ...change, baseRevision: 1 }]))[0]).toMatchObject({ status: "conflict" });
    expect((await remoteA.push("device-c", [change]))[0]).toMatchObject({ status: "conflict" });
  });

  it("stores photos in a private folder per account", async () => {
    const [a, b] = [await person(), await person()];
    const remoteA = createSupabaseRemote(a.client, a.id);
    const remoteB = createSupabaseRemote(b.client, b.id);
    const record = { id: "photo-1", mimeType: "image/png", width: 1, height: 1 };
    const push = () => remoteA.push("d", [{ collection: "photos", id: "photo-1", baseRevision: null, deleted: false, data: record }]);

    expect((await push())[0]).toMatchObject({ status: "missing_blob" });
    await remoteA.uploadPhoto("photo-1", png.buffer.slice(0) as ArrayBuffer, "image/png");
    await remoteA.uploadPhoto("photo-1", png.buffer.slice(0) as ArrayBuffer, "image/png");
    expect((await push())[0]).toMatchObject({ status: "ok" });
    expect([...new Uint8Array(await remoteA.downloadPhoto("photo-1"))]).toEqual([...png]);

    await expect(remoteB.downloadPhoto("photo-1")).rejects.toBeTruthy();
    const intruder = await b.client.storage.from("recipe-photos").upload(await photoPath(a.id, "intruder"), new Blob([png], { type: "image/png" }));
    expect(intruder.error).toBeTruthy();
    const listing = await b.client.storage.from("recipe-photos").list(a.id);
    expect(listing.data ?? []).toEqual([]);
    // The bucket is private: unsigned public URLs do not serve the object.
    const publicUrl = a.client.storage.from("recipe-photos").getPublicUrl(await photoPath(a.id, "photo-1")).data.publicUrl;
    expect((await fetch(publicUrl)).ok).toBe(false);
  });

  it("shows two installations the same library, photos and deletions", async () => {
    const owner = await person();
    const one = installation(owner.client, owner.id);
    const two = installation(owner.client, owner.id);
    await one.recipes.saveRecipe(draft("Sopa"), { blob: new Blob([png], { type: "image/png" }), width: 1, height: 1 });
    const first = await one.engine.prepareFirstSync();
    await first.apply(new Map());
    await one.engine.cycle();

    const second = await two.engine.prepareFirstSync();
    await second.apply(new Map());
    await two.engine.cycle();
    const copy = await two.backups.readSnapshot();
    expect(copy.recipes.map((recipe) => recipe.name)).toEqual(["Sopa"]);
    expect(copy.photos).toHaveLength(1);
    expect([...new Uint8Array(copy.photos[0]!.bytes)]).toEqual([...png]);

    await one.recipes.deleteRecipe(copy.recipes[0]!.id);
    await one.engine.cycle();
    await two.engine.cycle();
    expect((await two.backups.readSnapshot()).recipes).toEqual([]);
    expect((await two.backups.readSnapshot()).photos).toEqual([]);
  });
});
