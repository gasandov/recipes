# Recetario

A personal, installable web app for saving recipes, planning a weekly menu, and calculating a shopping list. The Solid 2, TypeScript, and Vite PWA stores its working copy in IndexedDB. Manual recipes, menus, shopping, and backups work without an account or a backend. Supabase provides the optional account and online features. The UI is in Mexican Spanish (`es-MX`), and code, tests, and documentation are in English. See the [implementation plan](PLAN.md) and the [post-v1 backlog](FUTURE.md).

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

#### Test setup

- `npm run build:e2e` builds into `node_modules/.cache/e2e-dist`, so it never touches `dist/` or a preview server you have running.
- `e2e/support/server.mjs` serves that build on `127.0.0.1:4317` (plus one private port per project for the update spec) with deployment-like headers: `no-cache` for `index.html` and `sw.js`, immutable caching for hashed `assets/`, and `application/manifest+json` for the manifest.
- Each test gets a fresh browser context, so IndexedDB and the service worker start empty.
- The network is never used. Requests to any host other than `127.0.0.1` are blocked, except `recetas.example`, which answers with a local fixture page so the recipe source link can be opened and asserted without leaving the machine.
- The projects are `desktop-chromium` (Desktop Chrome), `android-chromium` (Pixel 7 emulation), and `iphone-webkit` (iPhone 15 emulation on WebKit). Touch projects use `tap()` through `press()` in `e2e/support/app.ts`.
- Test files are named `*.e2e.ts` so Vitest does not collect them. Reports and traces go to `node_modules/.cache/e2e-results`.

#### Coverage

| Spec | Coverage |
| --- | --- |
| `library` | Name-only and complete recipes, photos, step reordering, categories, tags, source links, four-portion scaling, display units, deletion, accent-insensitive search, and combined filters. |
| `planning` | Phase 3 exit criteria through the UI: `500 g + 1 kg = 1.5 kg`, `2 + 2 eggs = 4`, `2–3 + 1 chiles = 3–4`, chicken cuts stay separate, cup ↔ 250 ml, a `0.8 g/ml` equivalence aggregating to about 160 g, separate amounts without an equivalence, independent and repeated batches, portion validation, zero-ingredient recipes, recipe edit and deletion after batching, clearing the menu, reload and offline. |
| `persistence` | Recipes and photos survive a reload and a new page in the same browser. After a failed IndexedDB write, the form retains its values for a retry. |
| `offline` | Reopen the shell and create or edit a recipe with a photo offline. Follow the source link after reconnecting. |
| `update` | A simulated release replaces the old cache after the app closes. Recipes, photos, the menu, and the shopping list remain available offline. |
| `accessibility` | Skip link, focus on route change, keyboard-only recipe entry, error summary links, dialog focus, no horizontal overflow at 320 px on every view, minimum tap targets, Spanish-only chrome. |
| `install-help` | Opens and checks the Spanish installation and storage help in the recipe library. |
| `future-workflows` | Reviews a text draft with an unstated yield, keeps an incoming social link for manual entry, and restores a photo, an active menu, and partial shopping progress in a separate profile. |
| `media-ocr` | Reads a known image and short video with on-device OCR in all three browsers and keeps media out of outgoing requests. |

## Optional online features

Copy `.env.example` to `.env.local` and set the project's public Supabase URL and publishable key to expose online features in the build. Put provider credentials in Supabase function secrets. The static site can still be built and used with these variables left empty.

- [Account synchronization](src/sync/README.md) uses Google identity and a private Supabase account. Local edits, deletions and the shopping list sync after reconnecting.
- [Recipe link import](supabase/functions/import-recipe/README.md) reads signed-in requests from the configured app origins and recipe sites. Instagram and Facebook links retain their sources and support pasted captions and manual entry. [Media capture](src/capture/media/README.md) reads screenshots, recipe images, and three frames from supported short clips on the device. The OCR reader files ship in `dist/ocr/` and are downloaded on first use.
- [Recipe dictation](src/capture/voice/README.md) uses local recognition where the browser supports it. The optional cloud fallback goes through the authenticated `transcribe-recipe` function after consent for that recording.

Run `deno check supabase/functions/import-recipe/index.ts supabase/functions/transcribe-recipe/index.ts` and `deno test supabase/functions/transcribe-recipe/handler_test.ts` for the function entry points and transcription unit tests. Vitest covers the link importer and its browser client.

## Static HTTPS deployment

The build is a folder of files ready for static hosting.

1. `npm ci && npm run build`, then publish the contents of `dist/`.
2. **Serve over HTTPS.** Service workers and installation require a secure context. Loopback addresses such as `localhost` are suitable for local tests.
3. **Keep one stable origin.** IndexedDB is per origin, so moving to another domain, subdomain, or scheme starts with an empty library. The app can run from a subdirectory because assets use relative URLs (`base: "./"`) and routing uses the URL hash, so no rewrite rules are needed.
4. Configure these headers where the host supports them.
   - `index.html`, `sw.js`, and `manifest.webmanifest`: `Cache-Control: no-cache` (always revalidate). A stale `sw.js` delays updates.
   - `assets/*` (hashed filenames): `Cache-Control: public, max-age=31536000, immutable`.
   - Serve `manifest.webmanifest` as `application/manifest+json` and `sw.js` as JavaScript.
5. GitHub Pages serves the project at [gasandov.github.io/recipes](https://gasandov.github.io/recipes/). Its publishing source is **GitHub Actions**. Every push to `main` runs [.github/workflows/deploy.yml](.github/workflows/deploy.yml): application and browser-test type checks, lint, Vitest, and the Chromium/WebKit browser suite must pass before the production build is published. A failed check leaves the previous deployment live. The workflow can also be started manually from the repository's Actions tab. Keep application source on `main`; the old `gh-pages` branch is no longer used for publishing. The service worker requests fresh copies of files when it builds a new precache, so the GitHub Pages cache policy may delay when a release first appears.
6. Publish every file listed in `sw.js`. The service worker needs them all to finish installing the precache.

The workflow runs the supported browser suite on macOS 15, including the WebKit video/OCR checks, and publishes the verified artifact from a separate Linux job. It reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from GitHub repository **Actions variables**. These are public browser settings, not backend credentials. A missing setting or a key that is not a public publishable key fails the build before publishing. Google OAuth secrets, Supabase personal access tokens, and service-role keys stay out of the workflow and static build. The `github-pages` deployment environment must allow the `main` branch. Each release includes `release.json` with its source commit and workflow run URL. Database migrations and Supabase Edge Function deployments remain separate backend operations.

### How updates reach people

The build writes `sw.js` with a content revision and the list of files to precache. A new deployment changes the revision, so browsers install the new worker next to the old one. The current version serves open tabs until the user closes every tab and installed app window. The new worker removes the old asset cache when it activates. Data stays in IndexedDB across releases. Ship the corresponding migration with any future database schema change.

## Supported browsers

Automated tests use **Playwright 1.65.1** on macOS with Chromium (desktop viewport and Pixel 7 emulation) and WebKit (iPhone 15 emulation). An Android emulator also reopened a populated shopping list after Chrome restarted with the local server stopped.

On the deployed GitHub Pages origin, Chrome reported no installation errors. The HTTPS smoke test opened the installation help, saved a recipe, scaled a menu batch, and reopened its shopping list offline.

| Target | Status |
| --- | --- |
| Chrome / Edge, desktop and Android (current) | Automated on Chromium. Real Android device check pending. |
| Safari on iOS and iPadOS (current) | Automated on WebKit emulation. Home-screen installation on physical devices remains pending. |
| Safari on macOS (current) | Desktop Safari and the in-app "Agregar al Dock" instructions remain pending device verification. |
| Firefox desktop | Pending verification. |

The app uses IndexedDB and service workers. Photo resizing uses canvas encoding with `createImageBitmap` or `HTMLImageElement.decode`. If a private window blocks writes, the app reports the failure in Spanish.

### Not verified

- Home-screen installation, restart behavior, and airplane mode on real iOS and Android devices.
- Whether iOS keeps the home-screen app's storage separate from Safari's on the target iOS version (the Spanish help warns that it may).
- Storage eviction under real memory pressure, and browsers other than those above.
- The full cross-browser suite runs locally. Live deployment verification covers the Chrome smoke test above.

## Device checklist (run on the deployed HTTPS origin)

Use a clean browser profile or device state for the first pass. Mark each item per device and record the OS and browser version.

**iPhone (Safari)**

- [ ] Open the app online, wait for it to load, and add it to the home screen as described in the in-app help.
- [ ] Create a recipe with a photo, ingredients, and steps. Close the app completely, reopen it, and confirm the recipe and photo remain.
- [ ] Turn on airplane mode. Open the app from the home screen. Create and edit a recipe, add a photo, add it to the menu, change portions, and open `Lista de compras`.
- [ ] Turn airplane mode off and confirm that a recipe's source link opens in the browser.
- [ ] Check whether recipes created in Safari also appear in the home-screen app (expected: they may not).

**Android (Chrome)**

- [ ] Install from the menu (`Instalar app`), open the installed app, and repeat the creation, restart, airplane-mode, and source-link checks above.
- [ ] Rotate the device and check that the layout fits a narrow window.

**Desktop (Chrome or Edge, and Safari)**

- [ ] Run the full workflow in a tab: create recipes, filter by cuisine plus ingredient, build a menu, scale portions, read the shopping list.
- [ ] Install the app, reopen it, and confirm the data is the same as in the tab.
- [ ] Use only the keyboard to create a recipe and add it to the menu.

**Release update (on the deployed origin)**

- [ ] With a populated library, a photo, and a menu in place, deploy a new build. Open the app, close it fully, and reopen it. Confirm the new version is running and all data is intact.
- [ ] Confirm the old version's cache is gone (DevTools > Application > Cache storage shows only the newest `recetario:` cache).

**Local storage and failure handling**

- [ ] Clear site data in the browser and confirm the app opens empty without errors.
- [ ] Try saving in a private window. Confirm it succeeds or reports a clear Spanish error.
- [ ] Read the in-app installation and storage help (Spanish) and confirm each instruction matches what the device actually shows.

## Project layout

```
src/domain/    rational arithmetic, units, aggregation, discovery (pure TypeScript)
src/data/      IndexedDB schema, repository, seeds
src/backup/    portable personal ZIPs, validation, and restore
src/capture/   recipe draft sources and capture parsing
src/shopping/  purchase progress, manual articles, and sharing
src/sync/      account lifecycle, offline queue, and per-record sync
src/ui/        Solid views, components, and es-MX text
src/pwa/       service worker source and registration
supabase/      optional backend and edge functions
public/        manifest and icons
e2e/           Playwright tests and the static test server
```

## Icons

Actions use the bundled Font Awesome Free solid icons by Fonticons, Inc. (CC BY 4.0 for SVG artwork).
Spanish screen-reader labels and hover descriptions identify icon-only controls. The icons work offline.
See [Font Awesome Free licensing](https://fontawesome.com/license/free) and the distributed [license](public/icons/fontawesome-LICENSE.txt).
