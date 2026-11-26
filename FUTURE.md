# Recipe app backlog after v1

This file records the capabilities deferred from [PLAN.md](PLAN.md). These workstreams can be scheduled independently unless a dependency is listed. Technical artifacts stay in English. App-provided user-facing content stays in Mexican Spanish.

## F1 — Import and export personal backups

**Depends on the v1 data model.**

- Export a versioned ZIP without a password. Include recipes, photos, personal categories, confirmed tag assignments, the active menu with its frozen ingredient snapshots and exact amounts, and F5 shopping data.
- Bundle one versioned shared ingredient catalog with stable IDs for offline use. Store shared ingredient IDs and the minimum display metadata needed to restore their references in a ZIP. Keep the master catalog outside each personal backup.
- Let each user create personal ingredients and adjust their own ingredient settings, such as a measured density. Only the app owner publishes changes to the shared catalog. Include personal ingredients and overrides in the ZIP and preserve them when migrating existing local recipes.
- Keep categories personal with optional starter suggestions. Ship predefined tag definitions with the app and back up each user's assignments.
- Preview and validate the ZIP before writing. Offer **Replace** and **Merge**. During a merge, reuse identical records by stable ID and let the user choose which version survives for each changed duplicate. Keep distinct recipes with the same name unless the user chooses to treat them as duplicates. Validate the result and apply it atomically so invalid archives and failed restores leave the current library intact.
- Test restoration in a separate browser profile with an outdated or temporarily unavailable shared catalog. Preserve ingredient names and the active menu's saved shopping totals when catalog entries change.

**Done when** — A backup taken on one device can restore the complete library and active menu on another, including photos, exact portions, and the same shopping totals.

## F2 — Synchronize across devices

**Depends on stable IDs and versioned local storage from v1.** Reuse F1's import and conflict handling for the first sign-in where applicable.

- Synchronize the complete personal recetario across devices, including recipes, photos, categories, tag assignments, personal ingredient data, the active menu, and F5 shopping data. Resolve shared ingredients through their catalog IDs. Use a private account scope for synced records and photos.
- Keep the existing offline workflow. Queue changes locally and synchronize them on reconnect. Propagate deletions to all devices without deleting the frozen snapshots already present in the active menu. Prevent a stale client from recreating a deleted record.
- On first sign-in, combine existing local and account data by stable ID and reuse identical records. Combine changes to different records. When two devices edit the same record concurrently, show both versions and ask the user which to keep. A deletion wins over a concurrent edit.
- Keep sessions across app restarts and refresh them in the background. Sign out of the current device and remove its local personal data. If it has pending edits, finish syncing or let the user export or explicitly discard those edits before clearing the local copy.
- Use managed Supabase Auth, Postgres, and Storage, starting with the Free plan. Sign in with Google OpenID Connect and request only identity scopes. [Supabase pricing](https://supabase.com/pricing) · [Session policy](https://supabase.com/docs/guides/auth/sessions) · [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)

**Done when** — Two devices show the same personal library and menu after reconnecting, including offline edits and deletions. Session refresh works across restarts, and signing out clears only the current device's local account data.

## F3 — Draft recipes from voice dictation

**Depends on the manual editor and recipe validation from v1.**

- Accept free-form dictation in Mexican Spanish. When the user stops, generate a structured draft in the existing editor with the name, stated portions, ingredient lines, and preparation steps in spoken order. Keep any live transcript display for development only. Require explicit review and save.
- Use the existing recipe model for exact fractions, ranges, measured quantities, notes such as `al gusto`, and ingredients with unspecified amounts. Match named ingredients to the catalog where the match is clear. Surface missing or ambiguous details for review.
- Prefer local transcription and local extraction. Test on-device browser recognition and a local multilingual model on the target PWA browsers. Measure accuracy for Mexican cooking vocabulary, fraction and range handling, initial download size, and processing time. [Web Speech specification](https://webaudio.github.io/web-speech-api/) · [Browser model inference](https://github.com/huggingface/transformers.js/blob/main/packages/transformers/docs/source/guides/webgpu.md)
- When on-device transcription is unavailable, let the user continue in the manual editor or explicitly approve cloud transcription for that recording before sending any audio. Compare retention terms and free quotas before choosing a cloud provider. Use the same draft review flow for either transcription path.
- Keep audio and transcripts in memory during the active dictation session. Discard them after extraction or cancellation. Save only the reviewed recipe. Keep raw dictation out of logs and backups.
- When the recipe yield is missing, prefill four portions in the draft and require the user to confirm or change that value before saving. Apply the same four-portion normalization used by manual entry after confirmation. Handle denied microphone permission, interrupted dictation, and processing failures so the user can continue with the information already captured.

**Done when** — A spoken recipe in Mexican Spanish produces a usable draft with ordered steps and recognizable quantities, including fractions or ranges. The user can correct uncertain information and save the recipe through the existing editor.

**Remaining verification** — Dictation with a real microphone on the target devices and cloud transcription in a configured project. The optional offline Whisper pack remains a candidate. Whisper Small matched 90% of quantities in the synthetic browser benchmark and downloaded about 252 MB of weights. Phone memory and latency still need measurement. [Local model evaluation](src/capture/voice/F3-local-model-evaluation.md)

## F4 — Import recipes automatically from links

**Depends on the manual editor and recipe validation from v1.** Web pages and accessible captions can ship before media extraction.

1. **Test source access.** Run a spike with representative public recipe pages and public Instagram and Facebook links. Record which sources provide readable structured recipe data, captions, images, or video and audio that can be processed. Use the results to define supported sources and error states.
2. **Extract structured data and text.** Read structured recipe markup on web pages where available, then try the visible recipe text or a readable social caption. Map the extracted data to a draft with a title, explicitly stated portions, ingredient lines, steps, and the source URL. Show which text each proposed value came from where practical.
3. **Extract from supported video and audio.** Try OCR for ingredients or steps displayed on screen, and transcribe audio when the media is accessible. Combine these results with the caption and flag disagreements for review. Decide how to process media, how long to retain it, and what to show while processing finishes or fails.
4. **Review before saving.** Leave quantities or steps pending when they are missing and ask the user to confirm the batch yield before normalizing amounts to four portions. Open the existing editor for correction and require an explicit save. When a page or media item cannot be read, open the manual editor with its source URL prefilled.
5. **Add a share entry point.** Where the platform can pass a link to the app, route links shared from Instagram, Facebook, or the browser into the same import flow. Pasting the link remains available.

**Done when** — Each supported source can produce a reviewable draft from representative public examples. The user can correct it and keep the original link. Missing information stays pending, and an inaccessible link leads to manual entry. OCR and transcription are verified separately using supported media with known content.

**Source limits** — Meta links use pasted captions, local screenshots or a video file selected by the user. Automatic extraction from a Meta link depends on an authorized provider interface that exposes the needed content. Public web pages on configured hosts can supply structured recipe data and media references. Direct media needs browser access, and video transcription needs the optional F3 provider and approval for each upload. [Media support](src/capture/media/README.md)

## F5 — Extend the shopping workflow

**Depends on the shopping aggregate from v1.**

- Track full and partial purchases by exact quantity. Keep those adjustments as the active menu changes. Buying 500 g before increasing a requirement to 1 kg leaves 500 g to buy.
- Add manual items as independent groceries or link them to an ingredient to combine compatible amounts. Clearing the menu retains manual items and resets purchase and on-hand progress.
- Deduct ingredients on hand using compatible units. This is an adjustment to the active shopping list. A reusable pantry remains a separate idea.
- Share a read-only snapshot of pending purchases. Use the device share sheet where available and offer a copyable list as a fallback.

**Done when** — Each added capability behaves predictably when recipes are added, removed, or rescaled, and the list makes it clear how much remains to buy.

## F6 — Publish iOS and Android apps

**Depends on the working PWA and the Phase 0 compatibility results.**

- Evaluate packaging the shared web frontend in a mobile shell. Validate offline storage, photo access, app updates, and native link sharing on physical devices before committing to the packaging approach.
- Reuse the Solid UI and TypeScript domain logic. Limit platform adapters to capabilities such as storage, installation, and incoming shared links. Provide a documented way to move an existing PWA library using backup import or sync when available.
- Prepare Spanish store assets, required disclosure and privacy information, signing, and release builds for iOS and Android. Keep the web app available.

**Done when** — The core flow passes on released web, iOS, and Android builds using the same product codebase, with native integration covered on each mobile platform.

## Previously discussed ideas to revisit if needed

- Menu history, a weekly calendar with meal slots, and assigning portions to dates.
- Multiple recipe photos, photos per step, and several source links per recipe.
- Shared editing of a recipe library or menu, distinct from sharing the shopping list.
