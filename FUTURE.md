# Recipe app backlog after v1

This file records the capabilities deferred from [PLAN.md](PLAN.md). These workstreams can be scheduled independently unless a dependency is listed. Technical artifacts stay in English. App-provided user-facing content stays in Mexican Spanish.

## F1 — Import and export personal backups

**Depends on the v1 data model.**

- Export a versioned archive containing the recipes, photos, catalog, categories, confirmed tags, and active menu. Include exact amounts and the data needed to rebuild shopping totals.
- Preview archive contents, validate the version and data before writing, and define explicit restore and merge behavior. Preserve the current library when an archive is invalid or a restore fails.
- Test recovery in a separate browser profile and migration of backups created by earlier schema versions.

**Done when** — A backup taken on one device can restore the complete library and active menu on another, including photos, exact portions, and the same shopping totals.

## F2 — Synchronize across devices

**Depends on stable IDs and versioned local storage from v1.** Use the backup format from F1 as a migration aid if available.

- Introduce a personal account, private storage for recipes and photos, and an initial upload of existing local data. Decide which settings and whether the active menu synchronize along with the library.
- Keep the core workflow available offline. Queue local changes, account for deletions, and specify how conflicts between offline edits on different devices are resolved and shown.
- Define how to add, sign out of, and recover access to a device. Protect each user's synced records and photos with ownership checks.

**Done when** — The same personal recipe library appears on two devices, both can edit offline, and reconnecting yields equivalent records without duplicate photos or silent data loss in the conflict cases covered by the policy.

## F3 — Import recipes automatically from links

**Depends on the manual editor and recipe validation from v1.** Web pages and accessible captions can ship before media extraction.

1. **Test source access.** Run a spike with representative public recipe pages and public Instagram and Facebook links. Record which sources provide readable structured recipe data, captions, images, or video and audio that can be processed. Use the results to define supported sources and error states.
2. **Extract structured data and text.** Read structured recipe markup on web pages where available, then try the visible recipe text or a readable social caption. Map the extracted data to a draft with a title, explicitly stated portions, ingredient lines, steps, and the source URL. Show which text each proposed value came from where practical.
3. **Extract from supported video and audio.** Try OCR for ingredients or steps displayed on screen, and transcribe audio when the media is accessible. Combine these results with the caption and flag disagreements for review. Decide how to process media, how long to retain it, and what to show while processing finishes or fails.
4. **Review before saving.** Leave quantities or steps pending when they are missing and ask the user to confirm the batch yield before normalizing amounts to four portions. Open the existing editor for correction and require an explicit save. When a page or media item cannot be read, open the manual editor with its source URL prefilled.
5. **Add a share entry point.** Where the platform can pass a link to the app, route links shared from Instagram, Facebook, or the browser into the same import flow. Pasting the link remains available.

**Done when** — Each supported source can produce a reviewable draft from representative public examples. The user can correct it and keep the original link. Missing information stays pending, and an inaccessible link leads to manual entry. OCR and transcription are verified separately using supported media with known content.

## F4 — Extend the shopping workflow

**Depends on the shopping aggregate from v1.**

- Let the user mark an item as purchased and decide whether to support partial purchases. If the menu changes, define how direct edits and purchased amounts carry forward. Include the case where a user buys 500 g and later increases that ingredient's requirement to 1 kg.
- Add manual items, such as groceries unrelated to a recipe, while retaining the distinction between manual contributions and quantities derived from menu batches.
- Let the user account for ingredients on hand, with compatible units, and show the remaining quantity to buy. Decide whether this is a one-time adjustment or a reusable pantry list.
- Share a shopping list with another person. Start by deciding whether a point-in-time list is sufficient. A shared editable list would also depend on the identity and sync model from F2.

**Done when** — Each added capability behaves predictably when recipes are added, removed, or rescaled, and the list makes it clear how much remains to buy.

## F5 — Publish iOS and Android apps

**Depends on the working PWA and the Phase 0 compatibility results.**

- Evaluate packaging the shared web frontend in a mobile shell. Validate offline storage, photo access, app updates, and native link sharing on physical devices before committing to the packaging approach.
- Reuse the Solid UI and TypeScript domain logic. Limit platform adapters to capabilities such as storage, installation, and incoming shared links. Provide a documented way to move an existing PWA library using backup import or sync when available.
- Prepare Spanish store assets, required disclosure and privacy information, signing, and release builds for iOS and Android. Keep the web app available.

**Done when** — The core flow passes on released web, iOS, and Android builds using the same product codebase, with native integration covered on each mobile platform.

## Previously discussed ideas to revisit if needed

- Menu history, a weekly calendar with meal slots, and assigning portions to dates.
- Multiple recipe photos, photos per step, and several source links per recipe.
- Shared editing of a recipe library or menu, distinct from sharing the shopping list.
