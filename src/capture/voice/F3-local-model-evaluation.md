# F3 local multilingual model evaluation (Whisper via Transformers.js, WASM)

Status: spike only, no application code changed. Date: 2026-11-22. All installs, models, audio and scripts lived outside
the repository (see "Reproduction"). Nothing was uploaded: audio was synthetic, generated and processed locally.

## Verdict

| Candidate (`onnx-community/…`, int8) | One-time download | Verdict |
| --- | --- | --- |
| `whisper-tiny` | ~44 MB model + 14 MB runtime | **Reject.** With three of four synthetic voices it hallucinated or looped ("de 3D de 3D de 3D…", "de los primeros videos."). |
| `whisper-base` | ~80 MB model + 14 MB runtime | **Marginal.** Reads most fractions and ranges, but misses vocabulary and can turn "tres cuartos" into "3-4". Only usable behind a review step. |
| `whisper-small` | ~252 MB model + 14 MB runtime | **Accurate, not lightweight.** 90% exact amounts after the existing parser, but a quarter-gigabyte download. |

The local model is feasible as an optional, explicitly downloaded "offline dictation pack", not as part of the app shell.
`base` is the smallest size worth offering, and only with the review flow F3 already requires. `small` is the only
size that came close to a usable draft. Phone speed and memory were not measured (see "Limits").

## Setup

- Playwright 1.65.1: Chromium 159.0.8154.6 (headless) and WebKit 27.2 (Playwright build), macOS, 14-core desktop.
  This is not iOS Safari.
- `@huggingface/transformers` 4.3.2 (ONNX Runtime Web 1.31.0-dev), `device: "wasm"`, int8 encoder and merged decoder,
  `language: "spanish"`, `chunk_length_s: 30`. Bundled with Vite 8 (the app's version).
- Audio: `say -v Paulina` plus `Eddy`, `Reed` and `Flo` (es_MX), 170 wpm, converted with ffmpeg to 16 kHz mono WAV.
  Three scripted recipes (~22–28 s each) with kitchen vocabulary: medio kilo, un cuarto, tres cuartos de taza, un tercio
  de taza, taza y media, litro y medio, "de dos a tres dientes de ajo", "de quince a veinte minutos", cucharada sopera,
  chile guajillo, jitomate, epazote, queso Oaxaca, rábanos, enfrijoladas, "al gusto", "un poco". Variants: 1 s of leading and
  trailing silence, and Paulina with pink noise mixed in.
- WebGPU was not measured: headless Chromium reported "No available adapters" and no GPU was used.

## Download size

Raw sizes from the Hugging Face listing; gzip on the wire shaves only `tokenizer.json` (2.5 MB to 0.67 MB).

| Part | tiny | base | small |
| --- | --- | --- | --- |
| Encoder int8 | 10.1 MB | 23.2 MB | 92.3 MB |
| Merged decoder int8 | 30.7 MB | 53.7 MB | 156.8 MB |
| Tokenizer and configs | ~2.8 MB (0.7 MB gzip) | same | same |
| Model total | ~44 MB | ~80 MB | ~252 MB |

ONNX Runtime WASM (one is needed, not both): plain `ort-wasm-simd-threaded.wasm` 14.3 MB (3.7 MB gzip, 2.7 MB brotli);
the Transformers.js default, the "asyncify" build, is 26.9 MB (6.6 MB gzip, 4.6 MB brotli). The plain build worked
with the same speed in Chromium and WebKit. The JS bundle is 0.55 MB (162 KB gzip).

Measured with the model served locally and fetched once into the Cache API: 59.3 MB over the wire for tiny
(44 model + 14 plain wasm + JS and test clip), in both browsers.

**Transformers.js fetches model files twice by default.** With the stock `pipeline()` call, the server saw two requests for
`decoder_model_merged_int8.onnx`, `tokenizer.json` and the small configs, plus a full `encoder_model_quantized.onnx` that
the chosen dtype does not need. This happened in both browsers, with and without HTTP cache headers and with the Cache API
enabled. Playwright's client-side byte counts showed the cost: Chromium 71 MB (it appears to drop the duplicate requests),
WebKit 115 MB (it downloaded the duplicates in full), for the same tiny load with the 26.9 MB wasm. Fix: download each
file once ourselves with `fetch` and `cache.put` into the `transformers-cache` Cache API cache (keyed by the same URL the
library uses), then call `pipeline()`. With this prefetch there were no duplicates and the library loaded entirely from
the cache.

Direct from Hugging Face (`allowRemoteModels`, Chromium, fast connection): download plus initialisation took 3.8 s
(tiny), 4.1 s (base), 8.2 s (small). Traffic was only GET requests to `huggingface.co` and `us.aws.cdn.hf.co`
(signed redirects). Real mobile networks will be slower; not measured.

## Speed (about 25 s of audio)

Model served locally, so initialisation excludes network time.

| Model | Load (parse + session) | Transcription, no cross-origin isolation | With COOP/COEP (threads) |
| --- | --- | --- | --- |
| tiny | 0.4–0.6 s | 1.5–1.7 s (real-time factor 0.06–0.07) | 0.7–0.9 s (0.03–0.04) |
| base | 0.6–0.8 s | 3.1–3.4 s (0.12–0.14) | 1.3–1.4 s (0.05–0.06) |
| small | 8.2 s including download from Hugging Face | not measured | 3.8 s (~0.15) |

Chromium and WebKit were within a few percent of each other. Threads need `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, which also constrain every cross-origin resource the app loads. Single
thread is already fast on this machine, so isolation is optional here and should be treated as a mobile-only optimisation to
re-measure. `performance.memory` (Chromium only, excludes WASM memory) showed 110–270 MB for tiny/base and 460 MB for small;
treat these as lower bounds.

## Accuracy

Two measures. (1) Word error rate against the script, lower-cased, accents and punctuation removed; digits are not converted to
words, so models that write "3 cuartos" are penalised. (2) The share of non-"unspecified" ingredient amounts that equal the
amounts `parseRecipeTranscript` extracts from the original script, so it includes both transcription and parser errors.
Each recipe set is 3 recipes per voice, so treat the numbers as indicative.

| Model | Mean WER (4 voices, 24 clips incl. padded) | Exact amounts after parser |
| --- | --- | --- |
| tiny | Paulina 0.20–0.28; other voices 0.7 to >5 (loops) | 26% overall (Paulina alone 55–82%) |
| base | Paulina 0.06–0.09; others 0.19–0.30 | 55–57% |
| small | not computed (digits and `¼` skew WER) | 90% (79/88, 12 clips, unpadded) |

What the models got right: "tres cuartos de taza", "un tercio de taza", "taza y media", "litro y medio", "de dos a tres dientes",
"de 15 a 20 minutos", "medio kilo", "cucharada sopera", "al gusto" (base and small, Paulina).

What went wrong:

- Vocabulary: Oaxaca became "bajaca" or "ajaca" (base, tiny, small with 3 of 4 voices), epazote became "pasote" (base, small) or
  "episodio" (tiny), jitomate became "hitomates" or "gitomates", enfrijoladas became "en frijoladas", and taza became "tasa".
  The catalog matcher must tolerate these.
- Dropped first word: without leading silence base and tiny often lost the recipe's first word ("Tacos", "Caldo"). One second of
  silence before the speech restored "Tacos" for base. Across all clips padding helped base (WER 0.23 to 0.19 in Chromium,
  0.22 to 0.21 in WebKit) and hurt tiny, so prepend silence only if re-measured on real recordings.
- Numerals: base and small mix words and digits ("2 chiles", "ocho tortillas", "1 litro medio", "¼", "¾", "1,5 m de caldo").
  `parseRecipeTranscript` handles the `¼`/`¾` glyphs, `1,5`, `1/3` and `2 a 3`, but not digit-plus-fraction-word forms
  such as "3 cuartos de taza" (read as 3 pieces) or "1 tercio de taza" ("Tercio de taza de crema", 1 piece). Whisper
  emits exactly those, so the parser or a post-ASR step needs them.
- Dangerous misread: base wrote "tres cuartos de taza" as "3-4 de taza" (Eddy), which the parser reads as a range of 3 to 4 pieces.
- Noise: with pink noise mixed in, base was unchanged (WER 0.07 to 0.09); tiny degraded (0.21 to 0.24 in Chromium, 0.29 in WebKit).
- Steps: the right number of steps survived in only 9 of 24 base clips and 8 of 12 small clips, likely because Whisper changes
  punctuation and the parser relies on it.

## Browser behaviour

- Both Playwright browsers ran the WASM backend, produced near-identical transcripts, and
  decoded audio from `webm/opus` and `mp4/aac` (the formats MediaRecorder produces in Chromium and Safari) through
  `AudioContext.decodeAudioData`. A live microphone and `MediaRecorder` were not tested.
- The Transformers.js default loads the ORT runtime script from `cdn.jsdelivr.net`. My network allow-list blocked it and
  initialisation failed. Set `env.backends.onnx.wasm.wasmPaths = { mjs, wasm }` to same-origin files before use.
- The bundler import of Transformers.js emits the 26.9 MB asyncify wasm into the build output. The app's `appShell` plugin in
  `vite.config.ts` precaches every emitted asset, so a plain import would add that file to every user's service-worker install.
- Cache API storage worked in both browsers. The service worker only intercepts precached URLs, and only deletes caches whose
  name starts with `recetario:<scope>:`; `transformers-cache` is untouched.

## Audio stays local

Across all runs, network auditing showed zero non-GET requests and zero request bodies. Hosts were `127.0.0.1` only, plus
`huggingface.co` and `us.aws.cdn.hf.co` in the direct-download runs. Audio was read as in-memory samples; nothing referenced it
in a request. After the model was cached, a second page with every `/models/` and `/ort/` request aborted loaded the model
and transcribed in both browsers, so the feature works without network once the pack is installed.

## Limits of this evaluation

- Synthetic macOS voices, clean audio, three scripts, and the script itself used the exact vocabulary being scored. Real
  speakers, hesitations, accents, background noise and overlapping speech will be worse. Ground truth needs a few real
  recordings before any accuracy claim to users.
- Playwright WebKit on a desktop is not iOS Safari. iOS memory limits, thermal throttling, storage eviction rules and
  phone CPU speed (expect several times slower) are untested.
- No microphone capture, no WebGPU, no model quantised below int8, no other model family (for example `distil-whisper`) was tried.

## Proposed packaging (not implemented)

1. Treat it as an opt-in pack, not part of the shell. Show the size and a Wi-Fi hint, then ask. Keep the browser
   recogniser and the explicit-consent cloud path as other options.
2. Lazy-load the library from the voice screen with a dynamic `import()`. Keep ONNX Runtime files (plain wasm and its `.mjs`)
   outside the precache list, as `public/ocr/` already does, and set `wasmPaths` explicitly. Check the emitted `assets/` and
   exclude any `.wasm` Vite emits from `appShell`'s asset list.
3. Download the model with our own sequential `fetch` plus `cache.put` into `transformers-cache`, with a progress bar and
   resumable retry, then load with `allowRemoteModels = false`. This avoids the stock double download and shows real progress.
   Ask for `navigator.storage.persist()` and handle eviction by re-offering the download.
4. Host the files same-origin (or another origin we control) with `Cache-Control: immutable` and a version path, rather than relying
   on Hugging Face availability and signed redirects. Check the host's per-file size limit: the base decoder is 53.7 MB and the
   small decoder 156.8 MB.
5. Run inference in a Web Worker. Convert recordings to 16 kHz mono, limit a dictation to about 3 minutes, and keep audio and
   transcript in memory only, as the existing controller does.
6. Add a post-ASR normalisation step before `parseRecipeTranscript`: digit-plus-fraction words ("3 cuartos", "1 tercio"),
   "3-4 de taza" next to a unit, and tolerant spelling for Oaxaca, epazote, jitomate and taza. Flag any amount derived from a
   digit hyphen pair for review.
7. Pick the default size after a real-device run: `base` as the smallest size, `small` if phones handle its memory and time.
   Do not ship `tiny`.

## Reproduction

Everything is under the session scratchpad `f3-whisper-spike/`: `run.mjs` (Playwright runner and network audit),
`prefetch.mjs` (Cache API prefetch and offline check), `matrix.sh`, `score2.py` (WER), `parse_eval.mjs` (parser comparison),
`results*/` (raw JSON) and `audio/` (scripts and WAVs). None of it is in the repository.
