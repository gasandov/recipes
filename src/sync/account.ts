import type { SupabaseClient } from "@supabase/supabase-js";
import { backupRepository, BackupError, encodeBackup } from "../backup";
import { onPersonalDataChange } from "../data/personal-changes";
import { supabase } from "../data/supabase-client";
import { activeShoppingRepository } from "../shopping/repository";
import { createSyncEngine } from "./engine";
import type { ChoiceSide, FirstSyncPlan, LocalLibrary, PendingSummary } from "./engine";
import { createIndexedDbMeta } from "./meta";
import type { SyncMeta } from "./meta";
import { createSupabaseRemote, toSyncError } from "./supabase-remote";
import { SyncError } from "./types";
import type { ConflictView, SyncNotice, SyncRemote } from "./types";

export type AccountPhase =
  /** Supabase is not configured for this build. The app works locally only. */
  | "unavailable"
  | "starting"
  | "signed-out"
  /** The first sign-in found records that differ between this device and the account. */
  | "review"
  /** This device holds personal data of another account. */
  | "foreign"
  | "syncing"
  | "idle"
  | "offline"
  /** The session ended while this device still holds account data. Sign in again to continue. */
  | "session-ended"
  | "error";

export type AccountUser = { id: string; email?: string; name?: string; avatarUrl?: string };

export type AccountStatus = {
  phase: AccountPhase;
  user?: AccountUser;
  pending: PendingSummary;
  lastSyncedAt?: number;
  /** Changes the service refused. They stay queued on this device. */
  rejected: number;
  review?: FirstSyncPlan;
  notices: SyncNotice[];
  errorCode?: SyncError["code"] | "unknown";
  /** True after a sign-out that could not clear the local data. */
  leftover: boolean;
};

export type SignOutResult =
  | { ok: true }
  | { ok: false; reason: "pending"; pending: PendingSummary }
  | { ok: false; reason: "failed" };

export type StartOptions = {
  /** Runs after sync rewrote the local library (a remote change, a conflict choice or a sign-out). Reload the UI here. */
  onRemoteApplied?: () => void | Promise<unknown>;
  /** Background polling while the page is visible. Realtime and the other triggers make this a safety net. */
  intervalMs?: number;
};

type SessionLike = {
  user: { id: string; email?: string; user_metadata?: Record<string, unknown> };
};

/** The parts of the Supabase auth client that account sync uses. */
export interface AuthLike {
  getSession(): Promise<{ data: { session: SessionLike | null }; error?: unknown }>;
  onAuthStateChange(callback: (event: string, session: SessionLike | null) => void): {
    data: { subscription: { unsubscribe(): void } };
  };
  signInWithOAuth(credentials: {
    provider: "google";
    options?: { redirectTo?: string; scopes?: string; queryParams?: Record<string, string> };
  }): Promise<{ error: unknown }>;
  signOut(options: { scope: "local" }): Promise<{ error: unknown }>;
}

export type AccountSyncDeps = {
  /** Undefined means sync is not configured. */
  client?: { auth: AuthLike; channel?: SupabaseClient["channel"]; removeChannel?: SupabaseClient["removeChannel"] };
  local?: LocalLibrary;
  meta?: SyncMeta;
  remoteFor?: (userId: string) => SyncRemote;
  /** Reads the snapshot for an export before sign-out. */
  exportBackup?: () => Promise<Uint8Array>;
};

const lockName = "recetario-account-sync";
const channelName = "recetario-account-sync";
const returnKey = "recetario-after-sign-in";
const googleScopes = "openid email profile";
const emptyPending: PendingSummary = { changes: 0, conflicts: 0 };

export function createAccountSync(deps: AccountSyncDeps = {}) {
  const client = deps.client;
  const local = deps.local ?? backupRepository;
  const meta = deps.meta ?? createIndexedDbMeta();
  const remoteFor = deps.remoteFor ?? ((userId: string) => createSupabaseRemote(client as unknown as SupabaseClient, userId));

  let status: AccountStatus = {
    phase: client ? "starting" : "unavailable", pending: emptyPending, rejected: 0, notices: [], leftover: false,
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<AccountStatus>) => {
    status = { ...status, ...patch };
    for (const listener of [...listeners]) listener();
  };

  let options: StartOptions = {};
  let paused = false;
  let running: Promise<void> | undefined;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let starts = 0;
  let stopStart: (() => void) | undefined;
  let broadcast: BroadcastChannel | undefined;
  let channelUser: string | undefined;
  let channel: ReturnType<SupabaseClient["channel"]> | undefined;

  const userOf = (session: SessionLike): AccountUser => {
    const profile = session.user.user_metadata ?? {};
    const text = (value: unknown) => typeof value === "string" && value ? value : undefined;
    return {
      id: session.user.id, email: session.user.email,
      name: text(profile.full_name) ?? text(profile.name), avatarUrl: text(profile.avatar_url) ?? text(profile.picture),
    };
  };

  function engineFor(userId: string) {
    return createSyncEngine({ local, meta, userId, remote: remoteFor(userId) });
  }

  /** Reads only local data, so it also works signed out and offline. */
  async function readPending(): Promise<PendingSummary> {
    try {
      const { state } = await meta.read();
      return await createSyncEngine({ local, meta, userId: state.userId ?? "", remote: noRemote }).pending();
    } catch {
      return status.pending;
    }
  }

  const noRemote: SyncRemote = {
    async pull() { throw new SyncError("offline", "No session."); },
    async push() { throw new SyncError("offline", "No session."); },
    async uploadPhoto() { throw new SyncError("offline", "No session."); },
    async downloadPhoto() { throw new SyncError("offline", "No session."); },
    async removePhoto() {},
  };

  async function withLock<T>(wait: boolean, task: () => Promise<T>): Promise<T | undefined> {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    if (!locks) return task();
    return locks.request(lockName, wait ? {} : { ifAvailable: true }, async (lock) => lock ? task() : undefined);
  }

  async function reloadInterface() {
    try {
      await options.onRemoteApplied?.();
    } catch (error) {
      console.error("Could not refresh the interface after sync.", error);
    }
  }

  /** The local library was rewritten. Reload this tab and tell the others, which would not notice by themselves. */
  async function applied() {
    await reloadInterface();
    try {
      broadcast?.postMessage("library-changed");
    } catch {
      // The other tabs catch up on their next sync round.
    }
  }

  function follow(userId: string | undefined) {
    if (channelUser === userId) return;
    if (channel) void client?.removeChannel?.(channel);
    channel = undefined;
    channelUser = userId;
    if (!userId || !client?.channel) return;
    try {
      channel = client.channel(`recetario-sync-${userId}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "sync_records", filter: `owner_id=eq.${userId}` },
          () => schedule(300))
        .subscribe();
    } catch (error) {
      // Realtime is an accelerator. Focus, reconnect and the interval still pick up changes.
      console.warn("Realtime sync is unavailable.", error);
    }
  }

  function schedule(delay = 1500) {
    if (!client || starts === 0) return;
    clearTimeout(timer);
    timer = setTimeout(() => void run(), delay);
  }

  function failure(error: unknown) {
    const failure = error instanceof SyncError ? error : toSyncError(error);
    failures++;
    const delay = Math.min(300_000, 5_000 * 2 ** Math.min(failures, 6));
    if (failure.code === "offline") {
      set({ phase: "offline", errorCode: "offline" });
      schedule(delay);
    } else if (failure.code === "auth") {
      // The client refreshes sessions by itself. Check again before asking the person to sign in.
      set({ phase: "error", errorCode: "auth" });
      schedule(Math.min(delay, 30_000));
    } else if (failure.code === "foreign-account") {
      set({ phase: "foreign", errorCode: "foreign-account" });
    } else {
      console.error("Sync failed.", failure);
      set({ phase: "error", errorCode: failure.code });
      schedule(delay);
    }
  }

  async function runOnce(): Promise<void> {
    if (!client || paused) return;
    const { data, error: sessionError } = await client.auth.getSession();
    const session = data.session;
    const { state } = await meta.read();
    if (!session && sessionError && isOffline(sessionError)) {
      // An expired access token cannot be refreshed without a connection. The session is still stored, so this is
      // not a sign-out: keep the account on screen and try again later.
      failures++;
      set({
        phase: "offline", errorCode: "offline", pending: await readPending(),
        user: status.user ?? (state.userId ? { id: state.userId, ...state.account } : undefined),
      });
      schedule(Math.min(300_000, 5_000 * 2 ** Math.min(failures, 6)));
      return;
    }
    if (!session) {
      follow(undefined);
      set({
        phase: state.userId ? "session-ended" : "signed-out", user: undefined, review: undefined,
        pending: await readPending(), errorCode: undefined,
      });
      return;
    }
    const user = userOf(session);
    follow(user.id);
    set({ user });
    if (state.userId === user.id && (state.account?.email !== user.email || state.account?.name !== user.name || state.account?.avatarUrl !== user.avatarUrl)) {
      await meta.update({ state: { account: { email: user.email, name: user.name, avatarUrl: user.avatarUrl } } });
    }
    if (state.userId && state.userId !== user.id) {
      set({ phase: "foreign", pending: await readPending() });
      return;
    }
    if (status.phase === "review" && status.review) return;

    const engine = engineFor(user.id);
    set({ phase: "syncing", errorCode: undefined });
    try {
      if (!state.initialized) {
        const plan = await engine.prepareFirstSync();
        if (plan.conflicts.length) {
          set({ phase: "review", review: plan, pending: await readPending() });
          return;
        }
        await plan.apply(new Map());
        await meta.update({ state: { account: { email: user.email, name: user.name, avatarUrl: user.avatarUrl } } });
        set({ notices: [...status.notices, ...plan.notices].slice(-20) });
        await applied();
      }
      const report = await engine.cycle();
      if (report.localChanged) await applied();
      failures = 0;
      set({
        phase: "idle", pending: await readPending(), rejected: report.rejected, review: undefined,
        lastSyncedAt: (await meta.read()).state.lastSyncedAt ?? status.lastSyncedAt,
        notices: [...status.notices, ...report.notices].slice(-20),
      });
      if (!report.settled) schedule(2000);
    } catch (error) {
      if (error instanceof BackupError && error.code === "stale") {
        // The library changed while syncing. Start over from the new state.
        set({ pending: await readPending() });
        schedule(500);
        return;
      }
      set({ pending: await readPending() });
      failure(error);
    }
  }

  function run(): Promise<void> {
    if (!client) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await withLock(false, runOnce);
        } while (again);
      } catch (error) {
        failure(error);
      } finally {
        running = undefined;
      }
    })();
    return running;
  }

  async function exportBytes(): Promise<Uint8Array> {
    return deps.exportBackup ? deps.exportBackup() : encodeBackup(await backupRepository.readSnapshot());
  }

  /** Clears the local library and the sync metadata under the sync lock. */
  async function clearDevice(endSession: boolean): Promise<boolean> {
    paused = true;
    try {
      const result = await withLock(true, async () => {
        if (endSession) {
          // The session ends first, so no other tab can keep syncing or download the library again.
          const { error } = await client!.auth.signOut({ scope: "local" });
          if (error) console.warn("The session could not be revoked on the server.", error);
        }
        follow(undefined);
        await createSyncEngine({ local, meta, userId: "", remote: noRemote }).clearLocal();
        return true;
      });
      return result === true;
    } catch (error) {
      console.error("Could not clear the local library.", error);
      set({ leftover: true });
      return false;
    } finally {
      paused = false;
    }
  }

  const controller = {
    getStatus: () => status,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Starts background sync. Call it once when the app mounts. Returns a function that stops it. */
    start(next: StartOptions = {}): () => void {
      options = { ...options, ...next };
      starts++;
      if (starts === 1 && client) {
        const cleanups: (() => void)[] = [];
        cleanups.push(onPersonalDataChange(() => schedule(2000)));
        if (typeof BroadcastChannel !== "undefined") {
          broadcast = new BroadcastChannel(channelName);
          broadcast.onmessage = () => {
            // Another tab rewrote the library (sync, restore or sign-out).
            void reloadInterface();
            void readPending().then((pending) => set({ pending }));
            schedule(200);
          };
          cleanups.push(() => {
            broadcast?.close();
            broadcast = undefined;
          });
        }
        try {
          cleanups.push(activeShoppingRepository.subscribe(() => schedule(2000)));
        } catch {
          // The interval picks up shopping edits from other tabs.
        }
        const wake = () => schedule(0);
        const visible = () => {
          if (document.visibilityState === "visible") schedule(0);
        };
        const lost = () => set({ phase: status.user ? "offline" : status.phase });
        window.addEventListener("online", wake);
        window.addEventListener("offline", lost);
        document.addEventListener("visibilitychange", visible);
        cleanups.push(() => {
          window.removeEventListener("online", wake);
          window.removeEventListener("offline", lost);
          document.removeEventListener("visibilitychange", visible);
        });
        const { data } = client.auth.onAuthStateChange((event, session) => {
          if ((event === "SIGNED_IN" || event === "INITIAL_SESSION") && session && consumeReturn()) window.location.hash = "#/cuenta";
          if (event !== "PASSWORD_RECOVERY") schedule(0);
        });
        cleanups.push(() => data.subscription.unsubscribe());
        const interval = setInterval(visible, next.intervalMs ?? 60_000);
        cleanups.push(() => clearInterval(interval));
        stopStart = () => {
          for (const cleanup of cleanups) cleanup();
          clearTimeout(timer);
          follow(undefined);
        };
        schedule(0);
      }
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        if (--starts === 0) {
          stopStart?.();
          stopStart = undefined;
        }
      };
    },

    /** Redirects to Google. Only the OpenID Connect identity scopes are requested. */
    async signInWithGoogle(): Promise<void> {
      if (!client) return;
      try {
        sessionStorage.setItem(returnKey, "1");
      } catch {
        // The person lands on the home page instead of the account page.
      }
      const { error } = await client.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}${window.location.pathname}`,
          scopes: googleScopes,
          queryParams: { prompt: "select_account" },
        },
      });
      if (error) {
        console.error("Google sign-in failed.", error);
        set({ phase: "error", errorCode: toSyncError(error).code });
      }
    },

    /** Runs a sync round now, for the "Sincronizar ahora" button. */
    async syncNow(): Promise<void> {
      clearTimeout(timer);
      await run();
    },

    /** Applies the person's choices for the first sign-in. */
    async completeReview(choices: ReadonlyMap<string, ChoiceSide>): Promise<void> {
      const review = status.review;
      if (!review) return;
      set({ phase: "syncing" });
      try {
        await withLock(true, () => review.apply(choices));
        set({ review: undefined, notices: [...status.notices, ...review.notices].slice(-20) });
        await applied();
        await run();
      } catch (error) {
        if (error instanceof BackupError && error.code === "stale") {
          // The library changed during the review. Build a new comparison.
          set({ review: undefined });
          await run();
          return;
        }
        set({ review: undefined });
        failure(error);
      }
    },

    async conflicts(): Promise<{ views: ConflictView[]; names: ReadonlyMap<string, string> }> {
      const { state } = await meta.read();
      return createSyncEngine({ local, meta, userId: state.userId ?? "", remote: noRemote }).conflicts();
    },

    async resolveConflict(key: string, side: ChoiceSide): Promise<void> {
      const { state } = await meta.read();
      const userId = state.userId ?? status.user?.id;
      if (!userId) throw new SyncError("auth", "Sign in to resolve this conflict.");
      await withLock(true, async () => {
        // The account's transport downloads the photo of the chosen version.
        await createSyncEngine({ local, meta, userId, remote: remoteFor(userId) }).resolve(key, side);
      });
      if (side === "remote") await applied();
      set({ pending: await readPending() });
      schedule(0);
    },

    /** Same as sync's pending count, refreshed on demand for the account page. */
    async refresh(): Promise<void> {
      set({ pending: await readPending() });
    },

    async exportBackup(): Promise<Uint8Array> {
      return exportBytes();
    },

    /**
     * Ends the session on this device only and clears its personal data. With unsynced edits it tries to sync
     * first and otherwise refuses, unless the person explicitly discards them (usually after an export).
     */
    async signOut(signOutOptions: { discardUnsynced?: boolean } = {}): Promise<SignOutResult> {
      if (!client) return { ok: false, reason: "failed" };
      if (!signOutOptions.discardUnsynced) {
        if (status.phase !== "review") {
          try {
            clearTimeout(timer);
            await run();
          } catch {
            // Offline: the pending check below decides.
          }
        }
        const pending = await readPending();
        set({ pending });
        if (pending.changes || pending.conflicts) return { ok: false, reason: "pending", pending };
      }
      if (!await clearDevice(true)) return { ok: false, reason: "failed" };
      set({
        phase: "signed-out", user: undefined, review: undefined, pending: emptyPending, rejected: 0,
        notices: [], leftover: false, errorCode: undefined, lastSyncedAt: undefined,
      });
      await applied();
      return { ok: true };
    },

    /**
     * Removes the personal data this device holds without ending the session. Used when the device still has the
     * data of another account, and to finish a sign-out that could not clear it.
     */
    async discardLocalData(): Promise<boolean> {
      if (!await clearDevice(false)) return false;
      set({ leftover: false, notices: [], pending: emptyPending, rejected: 0, review: undefined, errorCode: undefined });
      await applied();
      await run();
      return true;
    },

    dismissNotices() {
      set({ notices: [] });
    },
  };
  return controller;
}

export type AccountSyncController = ReturnType<typeof createAccountSync>;

function isOffline(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "AuthRetryableFetchError" || toSyncError(error).code === "offline"
    || (typeof navigator !== "undefined" && navigator.onLine === false);
}

function consumeReturn(): boolean {
  try {
    const pending = sessionStorage.getItem(returnKey) !== null;
    sessionStorage.removeItem(returnKey);
    return pending;
  } catch {
    return false;
  }
}

/** The app's account sync. Mount it once with `startAccountSync` and show `AccountSync` on the account page. */
export const accountSync: AccountSyncController = createAccountSync({
  client: supabase as unknown as AccountSyncDeps["client"],
});

/** Starts ongoing sync for the app lifetime. Returns a cleanup function. Does nothing when Supabase is not configured. */
export function startAccountSync(startOptions: StartOptions = {}): () => void {
  return accountSync.start(startOptions);
}
