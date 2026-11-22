# Recetario

A personal, installable web app for saving recipes, planning a weekly menu, and calculating a shopping list. It is a client-only PWA built with Solid 2, TypeScript, and Vite. All data lives in the browser's IndexedDB; there is no server, account, or sync. The app UI is in Mexican Spanish (`es-MX`); code, tests, and documentation are in English. See [PLAN.md](PLAN.md) for scope and [FUTURE.md](FUTURE.md) for post-v1 work.

## Technical setup

Requires Node `^22.13.0 || ^24.0.0 || >=26.0.0` and npm.

```sh
npm ci                  # install exact locked versions
npm run dev             # development server (the service worker is not registered in dev)
npm run build           # production build into dist/
npm run preview         # serve dist/ locally
npm run typecheck       # tsc for the app
npm run lint            # eslint
npm test                # unit and IndexedDB tests (Vitest, fake-indexeddb)
```

### Browser tests (Playwright)

The end-to-end suite exercises the **production build**, because the service worker is only registered there.

```sh
npm run test:e2e:install   # once per machine: downloads Playwright's Chromium and WebKit
npm run test:e2e           # builds, serves, and runs every project
npm run typecheck:e2e      # type-check the tests
npx playwright test e2e/planning.e2e.ts --project=iphone-webkit   # a single spec or project
```

How it works:

- `npm run build:e2e` builds into `node_modules/.cache/e2e-dist`, so it never touches `dist/` or a preview server you have running.
- `e2e/support/server.mjs` serves that build on `127.0.0.1:4317` (plus one private port per project for the update spec) with deployment-like headers: `no-cache` for `index.html` and `sw.js`, immutable caching for hashed `assets/`, and `application/manifest+json` for the manifest.
- Each test gets a fresh browser context, so IndexedDB and the service worker start empty.
- The network is never used. Requests to any host other than `127.0.0.1` are blocked, except `recetas.example`, which answers with a local fixture page so the recipe source link can be opened and asserted without leaving the machine.
- Projects: `desktop-chromium` (Desktop Chrome), `android-chromium` (Pixel 7 emulation), and `iphone-webkit` (iPhone 15 emulation on WebKit). Touch projects use `tap()` instead of `click()` (see `press()` in `e2e/support/app.ts`); WebKit's iPhone emulation has hit-test problems with synthetic mouse clicks.
- Test files are named `*.e2e.ts` so Vitest does not collect them. Reports and traces go to `node_modules/.cache/e2e-results`.

What the specs cover:

| Spec | Coverage |
| --- | --- |
| `library` | Name-only recipe; full recipe with photo, steps, categories, tags, source link, and four-portion scaling; step reordering; display-unit change; URL validation; delete with confirmation; search (case and accent insensitive) and combined filters, including an ingredient filter matching its cuts. |
| `planning` | Phase 3 exit criteria through the UI: `500 g + 1 kg = 1.5 kg`, `2 + 2 eggs = 4`, `2–3 + 1 chiles = 3–4`, chicken cuts stay separate, cup ↔ 250 ml, a `0.8 g/ml` equivalence aggregating to about 160 g, separate amounts without an equivalence, independent and repeated batches, portion validation, zero-ingredient recipes, recipe edit and deletion after batching, clearing the menu, reload and offline. Skipped automatically only if `#/menu` does not exist in the build. |
| `persistence` | Reload and a new page in the same browser keep recipes and photos; a failed IndexedDB write keeps the form and can be retried. |
| `offline` | After the first load: shell reopens offline; create and edit a recipe with a photo offline; the source link opens after reconnecting. |
| `update` | A new release (simulated by a different `sw.js` revision) waits for the app to close, then replaces the old cache; recipes, photos, the menu, and the shopping list are intact and still work offline. |
| `accessibility` | Skip link, focus on route change, keyboard-only recipe entry, error summary links, dialog focus, no horizontal overflow at 320 px on every view, minimum tap targets, Spanish-only chrome. |
| `install-help` | Opens and checks the Spanish installation and storage help in the recipe library. |

## Static HTTPS deployment

The build is a folder of static files; any static host works.

1. `npm ci && npm run build`, then publish the contents of `dist/`.
2. **Serve over HTTPS.** Service workers and installation require a secure context. Loopback addresses such as `localhost` are suitable for local tests.
3. **Keep one stable origin.** IndexedDB is per origin, so moving to another domain, subdomain, or scheme starts with an empty library. The app can run from a subdirectory because assets use relative URLs (`base: "./"`) and routing uses the URL hash, so no rewrite rules are needed.
4. Recommended headers:
   - `index.html`, `sw.js`, and `manifest.webmanifest`: `Cache-Control: no-cache` (always revalidate). A stale `sw.js` delays updates.
   - `assets/*` (hashed filenames): `Cache-Control: public, max-age=31536000, immutable`.
   - `manifest.webmanifest`: `Content-Type: application/manifest+json`; `sw.js`: a JavaScript content type.
5. GitHub Pages serves the project at [gasandov.github.io/recipes](https://gasandov.github.io/recipes/). The publishing source is the root of the `gh-pages` branch. Run type checks, lint, Vitest, and the browser suite before releasing. Publish the contents of `dist/` at the root of `gh-pages` with an empty `.nojekyll` file. Keep application source on `main`. The service worker requests fresh copies of files when it builds a new precache, so the GitHub Pages cache policy may delay when a release first appears.
6. Do not deploy a build that cannot reach every file listed in `sw.js`; the service worker precaches them all and fails to install if one is missing.

### How updates reach people

The build writes `sw.js` with a content revision and the list of files to precache. A new deployment changes the revision, so browsers install the new worker next to the old one. The worker does not call `skipWaiting()`, so the new version takes over only after every window of the app is closed and the app is opened again (with an installed app: close it fully, then reopen). Until then the old, complete version keeps working. The old cache is deleted when the new worker activates. IndexedDB data is never touched by updates; a future change to the database schema must ship its migration in the same release. The Spanish install help tells people this.

## Supported browsers

Automated tests use **Playwright 1.65.1** on macOS with Chromium (desktop viewport and Pixel 7 emulation) and WebKit (iPhone 15 emulation). An Android emulator also reopened a populated shopping list after Chrome restarted with the local server stopped.

| Target | Status |
| --- | --- |
| Chrome / Edge, desktop and Android (current) | Automated on Chromium. Real Android device check pending. |
| Safari on iOS and iPadOS (current) | Automated on WebKit emulation. Real iPhone check pending; the minimum iOS version for home-screen installation is unverified, so confirm it on the device. |
| Safari on macOS (current) | Same WebKit engine as the iPhone emulation; not tested separately. The in-app help mentions "Agregar al Dock", which needs a recent macOS; its minimum version is unverified. |
| Firefox desktop | Pending verification. |

Requirements: IndexedDB, service workers, `createImageBitmap` or `HTMLImageElement.decode`, and canvas encoding for photo resizing. Private windows may block or discard storage; the app reports a save failure instead of claiming success.

### Not verified

- Home-screen installation, restart behavior, and airplane mode on real iOS and Android devices.
- Whether iOS keeps the home-screen app's storage separate from Safari's on the target iOS version (the Spanish help warns that it may).
- Storage eviction under real memory pressure, and browsers other than those above.
- The deployed HTTPS origin: tests run against a local server with the headers described above.

## Device checklist (run on the deployed HTTPS origin)

Use a clean browser profile or device state for the first pass. Mark each item per device and record the OS and browser version.

**iPhone (Safari)**

- [ ] Open the app online, wait for it to load, and add it to the home screen as described in the in-app help.
- [ ] Create a recipe with a photo, ingredients, and steps. Close the app completely, reopen it, and confirm the recipe and photo remain.
- [ ] Turn on airplane mode. Open the app from the home screen. Create and edit a recipe, add a photo, add it to the menu, change portions, and open `Lista de compras`.
- [ ] Turn airplane mode off and open a recipe's source link; it opens in the browser.
- [ ] Check whether recipes created in Safari also appear in the home-screen app (expected: they may not).

**Android (Chrome)**

- [ ] Install from the menu (`Instalar app`), open the installed app, and repeat the creation, restart, airplane-mode, and source-link checks above.
- [ ] Rotate the device and use a narrow window; nothing should scroll sideways.

**Desktop (Chrome or Edge, and Safari)**

- [ ] Run the full workflow in a tab: create recipes, filter by cuisine plus ingredient, build a menu, scale portions, read the shopping list.
- [ ] Install the app, reopen it, and confirm the data is the same as in the tab.
- [ ] Use only the keyboard to create a recipe and add it to the menu.

**Release update (on the deployed origin)**

- [ ] With a populated library, a photo, and a menu in place, deploy a new build. Open the app, close it fully, and reopen it. Confirm the new version is running and all data is intact.
- [ ] Confirm the old version's cache is gone (DevTools > Application > Cache storage shows only the newest `recetario:` cache).

**Local storage and failure handling**

- [ ] Clear site data in the browser and confirm the app opens empty without errors.
- [ ] Open the app in a private window; saving either works or reports a clear Spanish error, never a false success.
- [ ] Read the in-app installation and storage help (Spanish) and confirm each instruction matches what the device actually shows.

## Project layout

```
src/domain/    rational arithmetic, units, aggregation, discovery (pure TypeScript)
src/data/      IndexedDB schema, repository, seeds
src/ui/        Solid views, components, and es-MX text
src/pwa/       service worker source and registration
public/        manifest and icons
e2e/           Playwright tests and the static test server
```
