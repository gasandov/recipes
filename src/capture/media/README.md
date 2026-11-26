# Media capture (F4)

Reads recipe text from images **on the device**. `MediaOcrPanel` (`src/ui/components/MediaOcrPanel.tsx`, shown inside
`LinkCapture`) turns the text into a `CapturedRecipe` through the same parser as pasted captions, then calls `onDraft`.
The editor, four-portion confirmation and explicit save stay the parent's.

## What is read, and from where

| Source | Allowed | Notes |
| --- | --- | --- |
| Image the user picks (screenshot, saved photo) | Yes, always | Never leaves the device. This is the route for Instagram and Facebook: the user captures their own screen. |
| Image listed by a public web page (`extraction.media`, `kind: "image"`) | Only after the user presses the button, only if the host allows it | Plain CORS `GET` from the browser: no cookies, no referrer, no cache. The host sees the user's IP, and the panel says so. |
| Meta hosts (`instagram.com`, `facebook.com`, `fb.watch`, `cdninstagram.com`, `fbcdn.net`, …) | Never fetched | `policy.ts`; same rule as `link/providers.ts`. Checked again after redirects. |
| Hosts without CORS headers | Reported as blocked | The browser's protection is **not** circumvented: no `no-cors`, no proxy through `import-recipe`, no frame, no canvas taint workaround. The message sends the user to the file picker. |
| MP4 or WebM clip chosen by the user | Yes, up to 24 MiB and two minutes | Samples three frames on-device. |
| MP4 or WebM video listed by a public web page | Only when selected and its host grants CORS | Direct HTTPS GET, without credentials or redirects. |
| Audio in a supported clip | When optional cloud transcription is configured and the user approves the clip | Browser extracts mono 16 kHz WAV. Only the audio is sent to the authenticated transcription function. |

## Privacy and bounds

- No image, frame, text or model request goes to a third party. Every engine path (`workerPath`, `corePath`, `langPath`,
  loader) is passed explicitly and resolves to this app's origin (`VITE_OCR_ASSET_BASE` is ignored if it points elsewhere).
  tesseract.js defaults point at jsDelivr and are never used.
- Image bytes are a `Blob` in memory only: nothing is written to storage, logged or retained. Decoded bitmaps are closed.
  The worker is terminated after each run. tesseract.js caches the **language model** (not images or text) in the browser's
  IndexedDB (`keyval-store`); clearing site data removes it.
- Limits (`limits.ts`): 4 images per run, 8 MB each, 40 megapixels decoded, longest side scaled down to 2,200 px, 15 s to
  download one image, 90 s to start the engine (first model download), 45 s to read one image. Reading cannot be interrupted
  inside tesseract.js, so a timeout or cancel calls `worker.terminate()`; the next read starts a fresh worker.
- Every failure maps to an es-MX message (`messages.ts`) and leaves the manual editor available with the source link.
- OCR output is always labeled as automatic recognition in the draft notices, and a mean confidence below 80 % adds a
  warning. Missing quantities stay pending exactly as with any other source.

## Engine files (not bundled, not precached)

tesseract.js 7.0.0 (Apache-2.0) and `@tesseract.js-data/spa` 1.0.0 (MIT, `spa.traineddata` "best, int8") are
devDependencies used only to *copy* files. `npm run ocr:assets` (run automatically by `predev`, `prebuild` and
`prebuild:e2e`) writes them to `public/ocr/` (git-ignored; `eslint` ignores it). Vite copies `public/` to whatever `outDir` is used,
so `build:e2e` works. The service worker precache lists only emitted bundle files plus the explicit list in `vite.config.ts`,
so `ocr/` is **not** precached: the install stays at the app shell. Verified in a production build: 8 precache entries, 373 KB raw / 127 KB gzip, none under `ocr/`.

| File | On disk | Gzip | Loaded |
| --- | --- | --- | --- |
| `tesseract.esm.min.js` | 63 KB | 11 KB | first read |
| `worker.min.js` | 111 KB | 34 KB | first read |
| `core/tesseract-core-{relaxedsimd-,simd-,}lstm.wasm.js` | 3.9 MB each (3 shipped) | 1.46 MB | only the one the browser supports |
| `lang/spa.traineddata.gz` | 2.1 MB | (already compressed) | first read, then cached in IndexedDB |

First read downloads about 5.9 MB uncompressed (measured in Playwright against the plain test server), about 3.6 MB if the host
compresses. `public/ocr/` takes 13 MB on disk in `dist/` because all three core variants are copied. Licenses of tesseract.js and its core are copied next to them
(`LICENSE-*`; `@tesseract.js-data/spa` ships none: its package metadata says MIT, and the model is Google's tessdata_best, Apache-2.0 upstream, so keep that attribution) and `manifest.json` records sizes and SHA-256 for each file.

Offline: the model is cached by the browser, but the core and worker rely on the HTTP cache. If they are evicted the read fails with
`engine-unavailable` and the user keeps the file picker, the paste box and the manual editor.

## Verification

- `ocr.sample.test.ts`: real tesseract.js (Node) on `fixtures/recipe-es.png`, a synthetic image with known text (generated by
  `fixtures/make-fixture.mjs`, expected lines in `recipe-es.expected.json`). Asserts every line was read, confidence above 0.8, the draft has the four
  known ingredients with `500 g` parsed and two steps, a blank image yields no text, and a 1 ms timeout terminates the worker and a new read succeeds.
  It reads the model straight from `@tesseract.js-data/spa` and caches nothing, so it runs after a plain `npm ci` (or with
  `RECETARIO_OCR_MODULES` pointing to another `node_modules`); it is skipped, with a console warning, only if those packages are missing.
- `e2e/media-ocr.e2e.ts`: the production build in Chromium (desktop and Pixel 7) and WebKit (iPhone 15). Picks the PNG, waits for the review editor, checks the
  steps and four ingredients, asserts no engine request happens before the pick, that every request stays on the app's origin (the harness aborts any other host), and logs the bytes transferred.
- The same spec checks the synthetic MP4. It overlays the same known image in each sampled frame and contains a sine tone, so the test can detect repeated ingredients and unexpected uploads without storing anyone's voice.
- `service.test.ts`, `fetch-image.test.ts`, `policy.test.ts`: limits, Meta refusal, CORS failure, redirect re-check, timeout, cancellation, engine start failure.

## Limitations (honest)

- Video OCR only sees the sampled frames. Rapidly changing captions or a line between frames may be missed. Unsupported codecs, blocked public media and longer clips fall back to screenshots or manual entry.
- The video transcription UI shares the optional F3 cloud configuration. The app can combine OCR and an approved transcript with a pasted caption before review.
- Page images are offered only when the page opened but had no readable recipe (`no-recipe-data`). A usable partial draft opens the editor directly.
- Many recipe CDNs send no CORS headers; those images fall back to the file picker.
- Accuracy was measured only on a clean synthetic image. Photos of cookbooks, stylized or handwritten text, and low contrast will read worse; the notices ask for review.
- Spanish model only. Quantities are the most likely errors (`1/2` as `l/2`, `O` for `0`), which is why the draft always requires review.
