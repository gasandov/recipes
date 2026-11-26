import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { Recipe, RecipeDraft } from "../contracts";
import { createBackupRepository } from "../backup";
import type { PersonalSnapshot } from "../backup";
import { createRecipeRepository } from "../data/repository";
import { createSyncEngine } from "./engine";
import { createFakeServer } from "./fake-server";
import { createMemoryMeta } from "./meta";
import { SyncError } from "./types";

const png: Uint8Array<ArrayBuffer> = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64"));
const green: Uint8Array<ArrayBuffer> = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC", "base64"));
const photo = (bytes: Uint8Array<ArrayBuffer> = png) => ({ blob: new Blob([bytes], { type: "image/png" }), width: 1, height: 1 });
const bytesOf = (value: ArrayBuffer) => [...new Uint8Array(value)];

const draft = (overrides: Partial<RecipeDraft> = {}): RecipeDraft => ({
  name: "Pan", enteredPortions: 4, ingredients: [], steps: [], categoryIds: [], tags: [], ...overrides,
});

type Server = ReturnType<typeof createFakeServer>;

/** One installation: its own recipe database and its own sync metadata. */
function device(server: Server, userId = "user-a") {
  const db = `sync-${crypto.randomUUID()}`;
  const recipes = createRecipeRepository(db);
  const backups = createBackupRepository(db);
  const meta = createMemoryMeta();
  const engine = (user = userId, options: { failPushOnce?: boolean } = {}) =>
    createSyncEngine({ local: backups, remote: server.remoteFor(user, options), meta, userId: user });
  return { recipes, backups, meta, engine };
}
type Device = ReturnType<typeof device>;

/** First sign-in without conflicts, then a full cycle. */
async function signIn(target: Device, choices: Record<string, "local" | "remote"> = {}) {
  const engine = target.engine();
  const plan = await engine.prepareFirstSync();
  await plan.apply(new Map(Object.entries(choices)));
  await engine.cycle();
  return engine;
}

const recipeNames = async (target: Device) => (await target.recipes.getLibrary()).recipes.map((recipe) => recipe.name).sort();
const find = async (target: Device, name: string): Promise<Recipe> =>
  (await target.recipes.getLibrary()).recipes.find((recipe) => recipe.name === name)!;

async function sameLibrary(left: Device, right: Device) {
  const a = await left.backups.readSnapshot();
  const b = await right.backups.readSnapshot();
  const normalize = (snapshot: PersonalSnapshot) => ({
    ...snapshot,
    recipes: [...snapshot.recipes].sort((x, y) => x.id.localeCompare(y.id)),
    categories: [...snapshot.categories].sort((x, y) => x.id.localeCompare(y.id)),
    photos: snapshot.photos.map((item) => ({ ...item, bytes: [...new Uint8Array(item.bytes)] })),
  });
  expect(normalize(b)).toEqual(normalize(a));
}

describe("first sign-in", () => {
  it("uploads an existing library to an empty account and is idempotent afterwards", async () => {
    const server = createFakeServer();
    const first = device(server);
    await first.recipes.saveRecipe(draft({ name: "Sopa" }), photo());
    await first.recipes.addMenuBatch((await find(first, "Sopa")).id);
    const engine = await signIn(first);

    expect(server.rows("user-a").some((row) => row.collection === "recipes" && !row.deleted)).toBe(true);
    expect(server.rows("user-a").filter((row) => row.collection === "photos")).toHaveLength(1);
    expect(server.rows("user-a").filter((row) => row.collection === "menu")).toHaveLength(1);
    expect(await engine.pending()).toEqual({ changes: 0, conflicts: 0 });
    const again = await engine.cycle();
    expect(again).toMatchObject({ pushed: 0, applied: 0, settled: true });
  });

  it("combines a different local library with the account's by stable ID", async () => {
    const server = createFakeServer();
    const one = device(server);
    await one.recipes.saveRecipe(draft({ name: "Sopa" }));
    await signIn(one);

    const two = device(server);
    await two.recipes.saveRecipe(draft({ name: "Pozole" }));
    await signIn(two);
    await (await signIn(one)).cycle();

    expect(await recipeNames(two)).toEqual(["Pozole", "Sopa"]);
    await sameLibrary(one, two);
  });

  it("reuses identical records and asks only about records that differ", async () => {
    const server = createFakeServer();
    const one = device(server);
    await one.recipes.saveRecipe(draft({ name: "Sopa" }));
    await signIn(one);
    const stored = await find(one, "Sopa");

    // The same record ID with another name exists on a device that never signed in.
    const two = device(server);
    await two.backups.commitSnapshot({ ...(await two.backups.readSnapshot()), recipes: [{ ...stored, name: "Sopa casera" }] });
    const plan = await two.engine().prepareFirstSync();
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({ collection: "recipes", local: { name: "Sopa casera" }, remote: { name: "Sopa" } });
    await expect(plan.apply(new Map())).rejects.toMatchObject({ code: "conflicts" });

    await plan.apply(new Map([[plan.conflicts[0]!.key, "local"]]));
    await two.engine().cycle();
    expect(server.data("user-a", "recipes", stored.id)).toMatchObject({ name: "Sopa casera" });
  });

  it("does not let a stale device recreate a record the account deleted", async () => {
    const server = createFakeServer();
    const one = device(server);
    await one.recipes.saveRecipe(draft({ name: "Sopa" }));
    const stale = device(server);
    await stale.backups.commitSnapshot(await one.backups.readSnapshot());
    const engine = await signIn(one);
    await one.recipes.deleteRecipe((await find(one, "Sopa")).id);
    await engine.cycle();

    const plan = await stale.engine().prepareFirstSync();
    expect(plan.notices).toContainEqual(expect.objectContaining({ code: "editDiscardedByDelete", name: "Sopa" }));
    await plan.apply(new Map());
    expect(await recipeNames(stale)).toEqual([]);
  });

  it("lets a renamed account category replace an untouched seeded one", async () => {
    const server = createFakeServer();
    const one = device(server);
    await one.recipes.saveCategory({ id: "dish-main", name: "Comidas", kind: "dish_type" });
    await signIn(one);
    const two = device(server);
    const plan = await two.engine().prepareFirstSync();
    expect(plan.conflicts).toEqual([]);
    await plan.apply(new Map());
    expect((await two.recipes.getLibrary()).categories.find((entry) => entry.id === "dish-main")?.name).toBe("Comidas");
  });
});

describe("two devices", () => {
  it("shows the same library, photos and menu after reconnecting, including offline edits and deletions", async () => {
    const server = createFakeServer();
    const a = device(server);
    const b = device(server);
    await a.recipes.saveRecipe(draft({ name: "Sopa" }), photo());
    await a.recipes.saveRecipe(draft({ name: "Pozole" }));
    await a.recipes.addMenuBatch((await find(a, "Sopa")).id);
    const engineA = await signIn(a);
    const engineB = await signIn(b);
    await sameLibrary(a, b);

    // Both go offline and edit different records.
    server.setOnline(false);
    await a.recipes.saveRecipe({ ...draft({ name: "Sopa de tortilla" }), id: (await find(a, "Sopa")).id, enteredPortions: 4 });
    await b.recipes.deleteRecipe((await find(b, "Pozole")).id);
    await b.recipes.saveRecipe(draft({ name: "Tamales" }));
    await expect(engineA.cycle()).rejects.toMatchObject({ code: "offline" });
    expect(await engineA.pending()).toEqual({ changes: 1, conflicts: 0 });
    expect((await engineB.pending()).changes).toBe(2);

    server.setOnline(true);
    await engineA.cycle();
    await engineB.cycle();
    await engineA.cycle();
    expect(await recipeNames(a)).toEqual(["Sopa de tortilla", "Tamales"]);
    await sameLibrary(a, b);
    // The frozen menu batch outlives its edited and deleted source recipes.
    expect((await b.recipes.getActiveMenu()).map((entry) => entry.name)).toEqual(["Sopa"]);
  });

  it("keeps the offline queue across a restart and sends each record once", async () => {
    const server = createFakeServer();
    const a = device(server);
    await signIn(a);
    server.setOnline(false);
    await a.recipes.saveRecipe(draft({ name: "Sopa" }));
    const { id } = await find(a, "Sopa");
    await a.recipes.saveRecipe({ ...draft({ name: "Sopa 2" }), id });
    await a.recipes.saveRecipe({ ...draft({ name: "Sopa 3" }), id });

    // A new engine over the same metadata is a restarted app.
    expect(await a.engine().pending()).toEqual({ changes: 1, conflicts: 0 });
    server.setOnline(true);
    const report = await a.engine().cycle();
    expect(report.pushed).toBe(1);
    expect(server.row("user-a", "recipes", id)).toMatchObject({ revision: 1, data: { name: "Sopa 3" } });
  });

  it("recovers when the server saved a push but the acknowledgement was lost", async () => {
    const server = createFakeServer();
    const a = device(server);
    await signIn(a);
    await a.recipes.saveRecipe(draft({ name: "Sopa" }));
    await expect(a.engine("user-a", { failPushOnce: true }).cycle()).rejects.toMatchObject({ code: "offline" });
    expect(await a.engine().pending()).toEqual({ changes: 1, conflicts: 0 });

    const report = await a.engine().cycle();
    expect(report.conflicts).toBe(0);
    expect(await a.engine().pending()).toEqual({ changes: 0, conflicts: 0 });
    const { id } = await find(a, "Sopa");
    expect(server.row("user-a", "recipes", id)?.revision).toBe(1);
  });
});

describe("lost acknowledgements and photos", () => {
  it("still removes a photo whose acknowledgement was lost when its recipe is deleted", async () => {
    const server = createFakeServer();
    const a = device(server);
    await signIn(a);
    await a.recipes.saveRecipe(draft({ name: "Sopa" }), photo());
    const { photoId } = await find(a, "Sopa");
    await expect(a.engine("user-a", { failPushOnce: true }).cycle()).rejects.toMatchObject({ code: "offline" });
    expect(server.row("user-a", "photos", photoId!)).toMatchObject({ deleted: false });

    await a.recipes.deleteRecipe((await find(a, "Sopa")).id);
    await a.engine().cycle();
    expect(server.row("user-a", "photos", photoId!)?.deleted).toBe(true);
    expect(server.hasPhoto("user-a", photoId!)).toBe(false);
  });
});

describe("concurrent edits", () => {
  async function pair() {
    const server = createFakeServer();
    const a = device(server);
    const b = device(server);
    await a.recipes.saveRecipe(draft({ name: "Sopa", steps: ["Hervir"] }));
    const engineA = await signIn(a);
    const engineB = await signIn(b);
    const id = (await find(a, "Sopa")).id;
    return { server, a, b, engineA, engineB, id };
  }

  it("holds both versions until the person chooses, then shares the chosen one", async () => {
    const { server, a, b, engineA, engineB, id } = await pair();
    await a.recipes.saveRecipe({ ...draft({ name: "Sopa de A", steps: ["Hervir"] }), id });
    await b.recipes.saveRecipe({ ...draft({ name: "Sopa de B", steps: ["Hervir"] }), id });
    await engineA.cycle();
    const report = await engineB.cycle();
    expect(report.conflicts).toBe(1);

    const { views } = await engineB.conflicts();
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ collection: "recipes", local: { name: "Sopa de B" }, remote: { name: "Sopa de A" } });
    // Nothing moved while the conflict is open, and it blocks a clean sign-out.
    expect(server.data("user-a", "recipes", id)).toMatchObject({ name: "Sopa de A" });
    expect(await engineB.pending()).toEqual({ changes: 0, conflicts: 1 });
    expect(await engineB.cycle()).toMatchObject({ conflicts: 1, pushed: 0 });

    await engineB.resolve(views[0]!.key, "local");
    await engineB.cycle();
    expect(server.data("user-a", "recipes", id)).toMatchObject({ name: "Sopa de B" });
    await engineA.cycle();
    expect((await find(a, "Sopa de B")).id).toBe(id);
    await sameLibrary(a, b);
  });

  it("replaces the local version when the person chooses the account's", async () => {
    const { server, a, b, engineA, engineB, id } = await pair();
    await a.recipes.saveRecipe({ ...draft({ name: "Sopa de A", steps: ["Hervir"] }), id });
    await b.recipes.saveRecipe({ ...draft({ name: "Sopa de B", steps: ["Hervir"] }), id });
    await engineA.cycle();
    await engineB.cycle();
    const [{ key }] = (await engineB.conflicts()).views;
    await engineB.resolve(key!, "remote");
    expect(await recipeNames(b)).toEqual(["Sopa de A"]);
    expect(await engineB.cycle()).toMatchObject({ pushed: 0, conflicts: 0, settled: true });
    expect(server.data("user-a", "recipes", id)).toMatchObject({ name: "Sopa de A" });
  });

  it("applies a deletion over a concurrent edit and says so", async () => {
    const { server, a, b, engineA, engineB, id } = await pair();
    await a.recipes.deleteRecipe(id);
    await engineA.cycle();
    await b.recipes.saveRecipe({ ...draft({ name: "Sopa editada", steps: ["Hervir"] }), id });

    const report = await engineB.cycle();
    expect(report.notices).toContainEqual({ code: "editDiscardedByDelete", collection: "recipes", name: "Sopa editada" });
    expect(await recipeNames(b)).toEqual([]);
    expect(server.row("user-a", "recipes", id)).toMatchObject({ deleted: true, revision: 2 });
  });

  it("accepts a deletion even though the recipe was edited elsewhere first", async () => {
    const { server, a, b, engineA, engineB, id } = await pair();
    await a.recipes.saveRecipe({ ...draft({ name: "Sopa editada", steps: ["Hervir"] }), id });
    await engineA.cycle();
    await b.recipes.deleteRecipe(id);

    await engineB.cycle();
    expect(server.row("user-a", "recipes", id)).toMatchObject({ deleted: true, data: null });
    await engineA.cycle();
    expect(await recipeNames(a)).toEqual([]);
  });

  it("never lets a stale client revive a deleted record", async () => {
    const { server, a, b, engineA, id } = await pair();
    await a.recipes.deleteRecipe(id);
    await engineA.cycle();
    const remote = server.remoteFor("user-a");
    const stale = { collection: "recipes" as const, id, deleted: false, data: { id, name: "Fantasma" } };
    for (const baseRevision of [null, 1]) {
      const [result] = await remote.push("device", [{ ...stale, baseRevision }]);
      expect(result).toMatchObject({ status: "conflict", current: { deleted: true, revision: 2 } });
    }
    // A client that already saw the tombstone may deliberately bring the ID back (for example a backup restore).
    const [restored] = await remote.push("device", [{ ...stale, baseRevision: 2 }]);
    expect(restored).toMatchObject({ status: "ok", revision: 3 });
    expect(await recipeNames(b)).toEqual(["Sopa"]);
  });

  it("removes dangling references after a concurrent category deletion and shares the repair", async () => {
    const server = createFakeServer();
    const a = device(server);
    const b = device(server);
    await a.recipes.saveCategory({ id: "cat-1", name: "Cenas", kind: "dish_type" });
    await a.recipes.saveRecipe(draft({ name: "Sopa", categoryIds: ["cat-1"] }));
    const engineA = await signIn(a);
    const engineB = await signIn(b);
    const id = (await find(a, "Sopa")).id;

    // A deletes the category (the repository also strips it from A's recipes). B, offline, files a new recipe in it.
    await a.recipes.deleteCategory("cat-1");
    await engineA.cycle();
    await b.recipes.saveRecipe(draft({ name: "Tamales", categoryIds: ["cat-1"], steps: ["Cocer"] }));
    const report = await engineB.cycle();
    expect(report).toMatchObject({ settled: true, conflicts: 0 });
    expect(report.notices).toContainEqual({ code: "repaired", note: { code: "categoryRemoved", subject: "Tamales" } });
    expect((await find(b, "Tamales")).categoryIds).toEqual([]);
    expect((await b.recipes.getLibrary()).categories.some((category) => category.id === "cat-1")).toBe(false);
    const tamales = (await find(b, "Tamales")).id;
    expect(server.data("user-a", "recipes", tamales)).toMatchObject({ categoryIds: [], steps: ["Cocer"] });
    await engineA.cycle();
    await sameLibrary(a, b);
    expect(id).toBeTruthy();
  });

  it("replaces a photo and removes the old one on every device", async () => {
    const { server, a, b, engineA, engineB, id } = await pair();
    await a.recipes.saveRecipe({ ...draft({ name: "Sopa", steps: ["Hervir"] }), id }, photo());
    await engineA.cycle();
    await engineB.cycle();
    const first = (await find(b, "Sopa")).photoId!;
    expect(first).toBeTruthy();
    await a.recipes.saveRecipe({ ...draft({ name: "Sopa", steps: ["Hervir"] }), id }, photo());
    await engineA.cycle();
    await engineB.cycle();
    expect((await find(b, "Sopa")).photoId).not.toBe(first);
    expect(server.row("user-a", "photos", first)?.deleted).toBe(true);
    expect(server.hasPhoto("user-a", first)).toBe(false);
    expect((await b.backups.readSnapshot()).photos).toHaveLength(1);
  });
});

describe("photos in recipe conflicts", () => {
  async function pair() {
    const server = createFakeServer();
    const a = device(server);
    const b = device(server);
    await a.recipes.saveRecipe(draft({ name: "Sopa" }), photo());
    const engineA = await signIn(a);
    const engineB = await signIn(b);
    const id = (await find(a, "Sopa")).id;
    const original = (await find(a, "Sopa")).photoId!;
    return { server, a, b, engineA, engineB, id, original };
  }
  const photoOf = async (target: Device) => (await target.backups.readSnapshot()).photos;

  it("keeps the account's photo when both devices replace it and the person chooses the account's version", async () => {
    const { server, a, b, engineA, engineB, id, original } = await pair();
    await a.recipes.saveRecipe({ ...draft({ name: "Sopa de A" }), id }, photo());
    await b.recipes.saveRecipe({ ...draft({ name: "Sopa de B" }), id }, photo(green));
    await engineA.cycle();
    const accountPhoto = (await find(a, "Sopa de A")).photoId!;
    expect(await engineB.cycle()).toMatchObject({ conflicts: 1 });

    // The account's photo is not tombstoned while its recipe version waits for a choice.
    expect(server.row("user-a", "photos", accountPhoto)).toMatchObject({ deleted: false });
    expect(server.hasPhoto("user-a", accountPhoto)).toBe(true);
    await engineB.cycle();
    expect(server.row("user-a", "photos", accountPhoto)).toMatchObject({ deleted: false });
    expect(server.hasPhoto("user-a", accountPhoto)).toBe(true);

    const [{ key }] = (await engineB.conflicts()).views;
    await engineB.resolve(key!, "remote");
    await engineB.cycle();
    await engineA.cycle();

    const [kept] = await photoOf(b);
    expect(await photoOf(b)).toHaveLength(1);
    expect(kept!.id).toBe(accountPhoto);
    expect(bytesOf(kept!.bytes)).toEqual([...png]);
    expect((await find(b, "Sopa de A")).photoId).toBe(accountPhoto);
    expect(server.hasPhoto("user-a", accountPhoto)).toBe(true);
    // B's own photo was held back with its recipe version and never reached the account.
    expect(server.rows("user-a").filter((row) => row.collection === "photos").map((row) => row.id).sort())
      .toEqual([original, accountPhoto].sort());
    await sameLibrary(a, b);
  });

  it("shares this device's photo and removes the account's when the person keeps the local version", async () => {
    const { server, a, b, engineA, engineB, id } = await pair();
    await a.recipes.saveRecipe({ ...draft({ name: "Sopa de A" }), id }, photo());
    await b.recipes.saveRecipe({ ...draft({ name: "Sopa de B" }), id }, photo(green));
    await engineA.cycle();
    const accountPhoto = (await find(a, "Sopa de A")).photoId!;
    await engineB.cycle();
    const [{ key }] = (await engineB.conflicts()).views;
    await engineB.resolve(key!, "local");
    await engineB.cycle();
    await engineA.cycle();

    const mine = (await find(b, "Sopa de B")).photoId!;
    expect(server.row("user-a", "photos", mine)).toMatchObject({ deleted: false });
    expect(server.row("user-a", "photos", accountPhoto)?.deleted).toBe(true);
    expect(bytesOf((await photoOf(a))[0]!.bytes)).toEqual([...green]);
    await sameLibrary(a, b);
  });

  it("keeps this device's photo while the account removed it, until the person chooses", async () => {
    const { server, a, b, engineA, engineB, id, original } = await pair();
    // A replaces the photo (the original is deleted in the account). B edits the text of the same recipe.
    await a.recipes.saveRecipe({ ...draft({ name: "Sopa" }), id }, photo(green));
    await b.recipes.saveRecipe({ ...draft({ name: "Sopa de B" }), id });
    await engineA.cycle();
    expect(server.row("user-a", "photos", original)?.deleted).toBe(true);

    expect(await engineB.cycle()).toMatchObject({ conflicts: 1, settled: true });
    expect((await photoOf(b)).map((entry) => entry.id)).toContain(original);
    expect((await find(b, "Sopa de B")).photoId).toBe(original);
    await engineB.cycle();
    // Nothing is sent for the photo while the conflict is open.
    expect(server.row("user-a", "photos", original)).toMatchObject({ deleted: true, revision: 2 });
    expect((await photoOf(b)).map((entry) => entry.id)).toContain(original);

    const [{ key }] = (await engineB.conflicts()).views;
    await engineB.resolve(key!, "local");
    await engineB.cycle();
    expect(server.row("user-a", "photos", original)).toMatchObject({ deleted: false, revision: 3 });
    expect(server.hasPhoto("user-a", original)).toBe(true);
    await engineA.cycle();
    expect((await find(a, "Sopa de B")).photoId).toBe(original);
    await sameLibrary(a, b);
  });

  it("discards the local photo when the person chooses the account's version", async () => {
    const { server, a, b, engineA, engineB, id, original } = await pair();
    await a.recipes.saveRecipe({ ...draft({ name: "Sopa" }), id }, photo(green));
    await b.recipes.saveRecipe({ ...draft({ name: "Sopa de B" }), id });
    await engineA.cycle();
    await engineB.cycle();
    const [{ key }] = (await engineB.conflicts()).views;
    await engineB.resolve(key!, "remote");
    await engineB.cycle();

    const photos = await photoOf(b);
    expect(photos.map((entry) => entry.id)).not.toContain(original);
    expect(photos).toHaveLength(1);
    expect(bytesOf(photos[0]!.bytes)).toEqual([...green]);
    expect(server.row("user-a", "photos", original)).toMatchObject({ deleted: true, revision: 2 });
    await sameLibrary(a, b);
  });

  it("never deletes a photo this device only saw as metadata", async () => {
    const { server, engineB } = await pair();
    // Another device uploaded a photo and its record, and its recipe is not in the account yet.
    const remote = server.remoteFor("user-a");
    await remote.uploadPhoto("incoming-photo", png.buffer.slice(0) as ArrayBuffer, "image/png");
    await remote.push("device-c", [{
      collection: "photos", id: "incoming-photo", baseRevision: null, deleted: false,
      data: { id: "incoming-photo", mimeType: "image/png", width: 1, height: 1 },
    }]);
    await engineB.cycle();
    await engineB.cycle();
    expect(server.row("user-a", "photos", "incoming-photo")).toMatchObject({ deleted: false, revision: 1 });
    expect(server.hasPhoto("user-a", "incoming-photo")).toBe(true);
  });
});

describe("menu order", () => {
  it("keeps every batch in place when the account's version of one batch replaces the local one", async () => {
    const server = createFakeServer();
    const a = device(server);
    const b = device(server);
    await a.recipes.saveRecipe(draft({ name: "Sopa" }));
    const recipeId = (await find(a, "Sopa")).id;
    for (let index = 0; index < 3; index++) await a.recipes.addMenuBatch(recipeId);
    const engineA = await signIn(a);
    const engineB = await signIn(b);
    const order = (await a.recipes.getActiveMenu()).map((entry) => entry.id);
    expect((await b.recipes.getActiveMenu()).map((entry) => entry.id)).toEqual(order);

    await a.recipes.setMenuBatchPortions(order[1]!, 6);
    await b.recipes.setMenuBatchPortions(order[1]!, 8);
    await engineA.cycle();
    await engineB.cycle();
    const [{ key }] = (await engineB.conflicts()).views;
    await engineB.resolve(key!, "remote");
    const menu = await b.recipes.getActiveMenu();
    expect(menu.map((entry) => entry.id)).toEqual(order);
    expect(menu[1]!.portions).toBe(6);
  });
});

describe("shopping", () => {
  it("synchronizes manual items and checked lines as separate rows", async () => {
    const server = createFakeServer();
    const a = device(server);
    const b = device(server);
    const engineA = await signIn(a);
    const engineB = await signIn(b);
    const base = await a.backups.readSnapshot();
    await a.backups.commitSnapshot({
      ...base,
      shopping: {
        version: 1,
        manualItems: [{ id: "item-1", name: "Servilletas", amount: { kind: "unspecified" } }],
        balances: [],
        checked: [{ groupId: JSON.stringify(["manual", "item-1"]), note: null }],
      },
    });
    await engineA.cycle();
    await engineB.cycle();
    expect((await b.backups.readSnapshot()).shopping?.manualItems.map((item) => item.name)).toEqual(["Servilletas"]);
    expect((await b.backups.readSnapshot()).shopping?.checked).toHaveLength(1);

    // B unchecks while A adds another item: different rows combine without a question.
    await b.backups.commitSnapshot({
      ...(await b.backups.readSnapshot()),
      shopping: { version: 1, manualItems: [{ id: "item-1", name: "Servilletas", amount: { kind: "unspecified" } }], balances: [], checked: [] },
    });
    await a.backups.commitSnapshot({
      ...(await a.backups.readSnapshot()),
      shopping: {
        version: 1,
        manualItems: [
          { id: "item-1", name: "Servilletas", amount: { kind: "unspecified" } },
          { id: "item-2", name: "Velas", amount: { kind: "unspecified" } },
        ],
        balances: [],
        checked: [{ groupId: JSON.stringify(["manual", "item-1"]), note: null }],
      },
    });
    await engineA.cycle();
    await engineB.cycle();
    await engineA.cycle();
    for (const target of [a, b]) {
      const shopping = (await target.backups.readSnapshot()).shopping;
      expect(shopping?.manualItems.map((item) => item.name)).toEqual(["Servilletas", "Velas"]);
      expect(shopping?.checked).toEqual([]);
    }
  });
});

describe("account boundaries", () => {
  it("keeps accounts apart on the server", async () => {
    const server = createFakeServer();
    const a = device(server, "user-a");
    const b = device(server, "user-b");
    await a.recipes.saveRecipe(draft({ name: "Privada" }));
    await signIn(a);
    const plan = await b.engine("user-b").prepareFirstSync();
    expect(plan.accountCount).toBe(0);
    await plan.apply(new Map());
    expect(await recipeNames(b)).toEqual([]);
    expect(server.rows("user-b").length).toBe(0);
  });

  it("refuses to sync metadata that belongs to another account", async () => {
    const server = createFakeServer();
    const a = device(server);
    await signIn(a);
    await expect(a.engine("user-b").cycle()).rejects.toMatchObject({ code: "foreign-account" });
    await expect(a.engine("user-b").prepareFirstSync()).rejects.toBeInstanceOf(SyncError);
  });

  it("clears local data without sending deletions and starts over as a new device", async () => {
    const server = createFakeServer();
    const a = device(server);
    await a.recipes.saveRecipe(draft({ name: "Sopa" }));
    const engine = await signIn(a);
    const before = JSON.stringify(server.rows("user-a"));
    const { state: previous } = await a.meta.read();

    await engine.clearLocal();
    expect(await recipeNames(a)).toEqual([]);
    expect(JSON.stringify(server.rows("user-a"))).toBe(before);
    const { state, base } = await a.meta.read();
    expect(state).toMatchObject({ initialized: false, cursor: 0, conflicts: [] });
    expect(state.deviceId).not.toBe(previous.deviceId);
    expect(base.size).toBe(0);

    // Signing in again restores the account's library.
    await signIn(a);
    expect(await recipeNames(a)).toEqual(["Sopa"]);
  });

  it("counts a never-synced local library as unsynced, so a sign-out is not silent data loss", async () => {
    const server = createFakeServer();
    const a = device(server);
    expect((await a.engine().pending()).changes).toBe(0);
    await a.recipes.saveRecipe(draft({ name: "Sopa" }));
    expect((await a.engine().pending()).changes).toBe(1);
  });
});
