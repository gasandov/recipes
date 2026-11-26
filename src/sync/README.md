# F2 account sync

Synchronizes one person's recetario (recipes, photos, categories, personal ingredients, shared-ingredient overrides,
the active menu and, when present in the snapshot, the F5 shopping state) across devices. The app keeps working
offline and without an account. Sync is optional and runs in the background.

## App integration

```tsx
// App shell, once. `app` is the AppState from createAppState().
import { startAccountSync } from "./sync";

onSettled(() => startAccountSync({ onRemoteApplied: () => app.reload() }));
```

`startAccountSync` returns a cleanup function. It is a no-op when `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY` are not set (`supabase` is `undefined`), and the account page then says that sync is
not available. `onRemoteApplied` runs after sync rewrote the local library (a remote change, a conflict choice, a
first sign-in merge or a sign-out). Do not call `announcePersonalDataChange()` from it: that event means "the person
edited something" and schedules another sync round.

Account page (route `account`, `#/cuenta`):

```tsx
import { AccountSync } from "./views/AccountSync";
// in View(): case "account": return <AccountSync />;
```

`AccountSync` takes an optional `controller` prop for tests. By default it uses the shared `accountSync` controller
that `startAccountSync` drives. A header badge can read `accountSync.getStatus()` / `accountSync.subscribe()`
(`phase`, `pending.changes`, `pending.conflicts`).

## Supabase setup

* Apply `supabase/migrations/20261122120000_account_sync.sql`. It creates `sync_state`, `sync_records`, the
  `sync_push` function, the private `recipe-photos` bucket with owner-only policies and adds `sync_records` to the
  `supabase_realtime` publication.
* Enable the Google provider (Authentication, Providers). Locally in `supabase/config.toml`:
  `[auth.external.google] enabled = true`, `client_id`/`secret` from `env(...)`. The client asks for
  `openid email profile` only. Add the app origin to the redirect allow list (`site_url`, `additional_redirect_urls`).
* Sessions: the browser client persists the session and refreshes it in the background (`autoRefreshToken`).
  On the Free plan refresh tokens do not expire on their own, so the session survives restarts until the person signs
  out. Time-box and inactivity limits are Pro features and are not needed.

## Protocol

Records, keyed by `(collection, stable id)`:
`recipes`, `categories`, `ingredients` (personal), `ingredient_overrides` (shared ingredient changes, keyed by catalog
id), `shared_ingredients` (catalog references, upsert-only), `menu` (frozen batches), `photos` (metadata only),
`shopping_items`, `shopping_balances`, `shopping_checked`. Shared ingredients are resolved through their catalog IDs.

Server (`sync_records`, one row per record, never removed):

* `revision` increases by one for every accepted change. `created_seq` / `change_seq` are positions in a per-account
  feed, assigned in `sync_push` under a per-account row lock, so devices that pull `change_seq > cursor` never skip a
  row that commits later.
* A deletion is a tombstone (`deleted = true`, `data = null`).
* Clients can only `select` their own rows (RLS). All writes go through `sync_push(p_owner_id, p_device_id,
  p_changes)`, a `SECURITY DEFINER` function that requires `p_owner_id = auth.uid()`, so a batch queued for one account
  is never written under another after a sign-in in a second tab.
* Per change: delete always applies (**delete wins**, from any revision). An edit applies when `baseRevision` equals the
  current revision. Resending identical data is accepted without a new revision (a lost response is safe). Anything
  else returns `conflict` with the current row. An edit of a tombstone is rejected unless `baseRevision` equals the
  tombstone's revision, meaning the device already saw the deletion. A stale device can therefore never recreate a
  deleted record, while the same device can deliberately bring an ID back (for example a backup restore, or an
  override that is toggled again).
* Photo bytes are in the private `recipe-photos` bucket under `<owner id>/<sha256 of photo id>`. A photo record is
  rejected (`missing_blob`) until its bytes exist, so no device can see metadata without bytes.

Device (`src/sync/engine.ts`):

* Local data stays in the F1 IndexedDB stores. Sync metadata is in its own database `recetario-sync`: the last
  acknowledged `{revision, content}` per record (the base), the pull cursor, the device ID, open conflicts and the
  account that owns the data.
* **The offline queue is the difference between the local snapshot and the base**, keyed by stable record ID. It
  survives restarts, coalesces repeated edits, and works without changes to the repositories.
* A round (`cycle`) pulls, reconciles each record, applies remote changes with F1's `prepareRestore().commit` (the
  compare-and-swap detects edits made meanwhile and retries), then pushes. It repeats until both sides agree.
* Per record: only remote changed, adopt it. Only local changed, push it. Both changed: remote deleted, **the delete
  wins** (the person is told); local deleted, the delete is pushed; both edited, identical content is accepted,
  different content becomes a **conflict** that is held back from both directions until the person picks a version.
  Choosing this device's version shares it, choosing the account's replaces the local one.
* After merging independent records, references can break (a category deleted on one device, a recipe added on
  another). Deterministic repairs (`records.ts`) remove or detach dangling references (categories, ingredient lines,
  photos, parent cycles, hidden shared ingredients still in use) and the repaired records are then pushed. The person
  sees a notice.
* Photos: a photo is only deleted by a device that held it. While a recipe conflict is open, the local version's photo
  stays in the library and the account version's photo is never deleted, so either choice keeps its photo.
* First sign-in (`prepareFirstSync`): pulls the whole account, drops local records the account deleted, reuses
  identical records, combines the rest by stable ID with F1's `planMerge` (shopping rows with the same keys), and
  returns the records that differ for the person to choose. Without differences it applies silently. An untouched seeded
  category yields to a rename made in the account.
* Ordering of menu batches and manual shopping items follows the server's `created_seq`, so every device shows the same
  order.

Other tabs: after every local rewrite (sync, first-sign-in merge, conflict choice, restore, sign-out) the tab posts on a
`BroadcastChannel`; the other tabs call their own `onRemoteApplied`, so none keeps showing cleared or stale data. A
`navigator.locks` lock lets one tab run a sync round at a time.

Sign-out (`accountSync.signOut`):

1. With unsynced edits it first syncs. If edits remain (offline, conflicts) it refuses and lists them, so the UI can
   offer an export (`exportBackup`, the F1 ZIP) or an explicit discard.
2. It ends only this device's session (`signOut({ scope: "local" })`), then clears the local library and the sync
   metadata. Clearing never sends deletions, and other devices and the account keep everything.
3. A missing session caused by a failed token refresh while offline is not a sign-out: the app shows the account as
   offline, keeps every edit queued and retries. A session that ends by itself (revoked, expired) keeps the local data and asks for a new sign-in. Data of a
   different account on the device is never merged: the person exports or discards it first.

## Known limits

* Photos are bound by F1's snapshot validation (`backupLimits`: 128 MB of photos, 2000 photos). A larger library fails
  every round with `invalid-data` until photos are removed, as F1 backups already do.
* Orphaned photos that no device ever held (for example after a lost upload followed by an uninstall) stay in storage.

## Tests

* `npx vitest run src/sync` deterministic engine, records and controller tests with an in-memory server
  (`fake-server.ts`) that mirrors the SQL rules and `fake-indexeddb`.
* `supabase test db --local` pgTAP: revisions, tombstones, owner isolation, direct-write denial, storage isolation.
* Two Chromium profiles connected to the local stack verified the account view, photo and menu sync, manual shopping entries, offline editing, deletion, and device-only sign-out while offline. Google OAuth still needs verification with a configured project.
* `RECETARIO_TEST_SUPABASE_URL=http://127.0.0.1:54321 RECETARIO_TEST_SUPABASE_KEY=<local publishable key>
  npx vitest run src/sync/supabase.integration.test.ts` runs the real transport against the local stack (skipped
  otherwise, refuses non-local URLs).
