import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackupRepository } from "../backup";
import type { RecipeDraft } from "../contracts";
import { createRecipeRepository } from "../data/repository";
import { createAccountSync } from "./account";
import type { AuthLike } from "./account";
import { createFakeServer } from "./fake-server";
import { createMemoryMeta } from "./meta";

const draft = (name: string): RecipeDraft => ({
  name, enteredPortions: 4, ingredients: [], steps: [], categoryIds: [], tags: [],
});

function setup(userId = "user-a") {
  const server = createFakeServer();
  const db = `account-${crypto.randomUUID()}`;
  const recipes = createRecipeRepository(db);
  const backups = createBackupRepository(db);
  const meta = createMemoryMeta();
  const events: string[] = [];
  let session: { user: { id: string; email?: string } } | null = { user: { id: userId, email: "persona@example.test" } };
  const auth: AuthLike = {
    getSession: async () => ({ data: { session } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signInWithOAuth: vi.fn(async () => ({ error: null })),
    signOut: vi.fn(async () => {
      events.push("signOut");
      session = null;
      return { error: null };
    }),
  };
  const local = {
    prepareRestore: () => backups.prepareRestore(),
    commitSnapshot: async (...args: Parameters<typeof backups.commitSnapshot>) => {
      events.push("clear-local");
      return backups.commitSnapshot(...args);
    },
  };
  const applied = vi.fn();
  const account = createAccountSync({
    client: { auth }, local, meta, remoteFor: (id) => server.remoteFor(id),
  });
  account.start({ onRemoteApplied: applied });
  return { server, recipes, backups, meta, events, auth, account, applied, setSession: (next: typeof session) => { session = next; } };
}

const names = async (target: ReturnType<typeof setup>) => (await target.recipes.getLibrary()).recipes.map((recipe) => recipe.name);

afterEach(() => vi.unstubAllGlobals());

describe("account sync controller", () => {
  it("reports that sync is unavailable without a Supabase configuration", () => {
    expect(createAccountSync({}).getStatus().phase).toBe("unavailable");
  });

  it("syncs after sign-in and reports the status", async () => {
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {}, location: { hash: "" } });
    vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {}, visibilityState: "hidden" });
    const target = setup();
    await target.recipes.saveRecipe(draft("Sopa"));
    await target.account.syncNow();
    expect(target.account.getStatus()).toMatchObject({
      phase: "idle", user: { id: "user-a", email: "persona@example.test" }, pending: { changes: 0, conflicts: 0 },
    });
    expect(target.server.rows("user-a").some((row) => row.collection === "recipes")).toBe(true);
  });

  it("ends the session before clearing local data, never sends deletions, and keeps the account's copy", async () => {
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {}, location: { hash: "" } });
    vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {}, visibilityState: "hidden" });
    const target = setup();
    await target.recipes.saveRecipe(draft("Sopa"));
    await target.account.syncNow();
    const before = JSON.stringify(target.server.rows("user-a"));

    const result = await target.account.signOut();
    expect(result).toEqual({ ok: true });
    expect(target.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(target.events).toEqual(["signOut", "clear-local"]);
    expect(await names(target)).toEqual([]);
    expect(JSON.stringify(target.server.rows("user-a"))).toBe(before);
    expect(target.account.getStatus()).toMatchObject({ phase: "signed-out", user: undefined });
    expect(target.applied).toHaveBeenCalled();
  });

  it("refuses to sign out with unsynced edits unless the person explicitly discards them", async () => {
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {}, location: { hash: "" } });
    vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {}, visibilityState: "hidden" });
    const target = setup();
    await target.account.syncNow();
    target.server.setOnline(false);
    await target.recipes.saveRecipe(draft("Sin sincronizar"));

    const refused = await target.account.signOut();
    expect(refused).toMatchObject({ ok: false, reason: "pending", pending: { changes: 1 } });
    expect(target.events).toEqual([]);
    expect(await names(target)).toEqual(["Sin sincronizar"]);
    // The person can export the unsynced library first.
    expect((await target.account.exportBackup()).byteLength).toBeGreaterThan(0);

    expect(await target.account.signOut({ discardUnsynced: true })).toEqual({ ok: true });
    expect(await names(target)).toEqual([]);
    expect(target.events).toEqual(["signOut", "clear-local"]);
  });

  it("syncs pending edits during sign-out when the connection is back", async () => {
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {}, location: { hash: "" } });
    vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {}, visibilityState: "hidden" });
    const target = setup();
    await target.account.syncNow();
    await target.recipes.saveRecipe(draft("Sopa"));
    expect(await target.account.signOut()).toEqual({ ok: true });
    expect(target.server.rows("user-a").filter((row) => row.collection === "recipes" && !row.deleted)).toHaveLength(1);
  });

  it("keeps local data when the session ends on its own instead of wiping it", async () => {
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {}, location: { hash: "" } });
    vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {}, visibilityState: "hidden" });
    const target = setup();
    await target.recipes.saveRecipe(draft("Sopa"));
    await target.account.syncNow();
    target.setSession(null);
    await target.account.syncNow();
    expect(target.account.getStatus().phase).toBe("session-ended");
    expect(await names(target)).toEqual(["Sopa"]);
    expect(target.events).toEqual([]);
  });

  it("treats a missing session caused by a failed refresh as offline, not as a sign-out", async () => {
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {}, location: { hash: "" } });
    vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {}, visibilityState: "hidden" });
    const target = setup();
    await target.recipes.saveRecipe(draft("Sopa"));
    await target.account.syncNow();

    // Cold start the next day without a connection: the stored session needs a refresh that cannot happen.
    target.auth.getSession = async () => ({
      data: { session: null }, error: { name: "AuthRetryableFetchError", message: "fetch failed", status: 0 },
    });
    await target.account.syncNow();
    expect(target.account.getStatus()).toMatchObject({ phase: "offline", user: { id: "user-a" } });
    expect(await names(target)).toEqual(["Sopa"]);
    expect(target.events).toEqual([]);
    // Edits stay queued and a sign-out is refused instead of wiping them.
    await target.recipes.saveRecipe(draft("Pendiente"));
    expect(await target.account.signOut()).toMatchObject({ ok: false, reason: "pending" });
    expect(await names(target)).toContain("Pendiente");
  });

  it("tells the other tabs after the library was rewritten", async () => {
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {}, location: { hash: "" } });
    vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {}, visibilityState: "hidden" });
    const target = setup();
    await target.account.syncNow();
    const other = new BroadcastChannel("recetario-account-sync");
    const heard = new Promise<void>((resolve) => { other.onmessage = () => resolve(); });
    await target.account.signOut({ discardUnsynced: true });
    await heard;
    other.close();
    expect(target.applied).toHaveBeenCalled();
  });

  it("does not combine data from another account", async () => {
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {}, location: { hash: "" } });
    vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {}, visibilityState: "hidden" });
    const target = setup();
    await target.recipes.saveRecipe(draft("Sopa"));
    await target.account.syncNow();
    target.setSession({ user: { id: "user-b" } });
    await target.account.syncNow();
    expect(target.account.getStatus().phase).toBe("foreign");
    expect(target.server.rows("user-b")).toEqual([]);

    expect(await target.account.discardLocalData()).toBe(true);
    expect(await names(target)).toEqual([]);
    expect(target.account.getStatus().phase).toBe("idle");
  });

  it("asks Google only for identity scopes and returns to the same page", async () => {
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {}, location: { origin: "https://recetario.example", pathname: "/app/", hash: "" } });
    vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {}, visibilityState: "hidden" });
    vi.stubGlobal("sessionStorage", { setItem() {}, getItem: () => null, removeItem() {} });
    const target = setup();
    await target.account.signInWithGoogle();
    expect(target.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: "https://recetario.example/app/", scopes: "openid email profile", queryParams: { prompt: "select_account" } },
    });
  });
});
