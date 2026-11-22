# Recipe app v1 implementation plan

## Goal

Build a personal, installable web app for saving recipes, choosing what to cook for the week, and calculating how much of each ingredient to buy. The first release is complete when the user can create recipes manually on a phone, assemble a menu, adjust portions, and use the resulting shopping list offline after the initial load.

Use English for code, identifiers, documentation, tests, commit messages, and developer diagnostics. Use Mexican Spanish (`es-MX`) for all app-provided user-facing content, including form labels, errors, accessible names, installation help, sample categories, and the manifest's display name and description. Preserve the language and spelling of user-entered content.

See [FUTURE.md](FUTURE.md) for post-v1 work.

## Product scope

| Area | V1 behavior |
| --- | --- |
| Recipe library | Create, view, edit, and delete recipes. Only the name is required. A recipe can have one optional photo, ingredients, reorderable steps, multiple categories, confirmed tags, and one optional source URL entered by pasting or typing. |
| Portions | Enter the number of portions the submitted recipe makes. Save its quantities on a four-portion basis and open the recipe at four portions. A menu entry has its own adjustable portion count. |
| Discovery | Search by recipe name and combine filters for categories, confirmed tags, and ingredients to find combinations such as Mexican dishes containing chicken. |
| Weekly menu | Keep one active list of cooking batches. Add and remove recipes and adjust portions by batch. The list persists until the user clears it to start over. Cooking and meal dates are determined by the user. |
| Shopping list | Derive a single list from every batch in the active menu. Sum compatible quantities for the same ingredient, preserve exact fractions and ranges, and surface ingredients with unmeasured or unspecified quantities. |
| PWA | Support a phone and desktop browser from one codebase. Keep recipes, photos, catalog, and menu in local browser storage. The core workflow runs offline after the app has been cached. |

## Architecture

- Build a client-rendered app with Solid 2.x, TypeScript in strict mode, and Vite. Solid 2.0 reached stable on November 16, 2026. Pin compatible versions in the lockfile after a build and installability check in Phase 0. [Solid 2.0 release announcement](https://www.solidjs.com/blog/solid-2-0-the-long-hold/)
- Keep recipe normalization, rational arithmetic, conversions, ingredient matching, tag suggestions, and shopping aggregation in TypeScript modules independent of Solid, the DOM, and persistence. Keep I/O behind a small IndexedDB repository so a future mobile shell or sync layer can reuse the domain rules.
- Use IndexedDB object stores for recipes, photos, ingredients, categories, and the active menu. Version the database and use transactions for related writes. Store photo bytes and MIME type locally and reconstruct image blobs on read to support WebKit. Use stable IDs for entities referenced by the menu. Generate the shopping list from the active menu in memory.
- Serve a static build over HTTPS at a stable origin. A service worker caches the app shell and its versioned assets. User data lives in IndexedDB independently of the asset cache. Request persistent storage when supported, handle write and quota errors, and explain in Spanish that clearing site data can erase the local library. [MDN browser storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- Use a responsive layout with main views for `Recetas`, `Menú`, and `Lista de compras`. Give instructions an accessible way to move a step up or down using a keyboard or touch. Render user strings as plain text and open only validated HTTP(S) source links when the user selects them.

## Data model

| Entity | Persisted fields and invariants |
| --- | --- |
| `Recipe` | Stable ID, nonblank name, optional photo ID and source URL, ordered steps and ingredient lines, category IDs, and confirmed tag keys. Each stored quantitative ingredient amount is expressed for four portions. |
| `RecipeIngredient` | Ingredient ID and one amount variant. A measured amount is a positive rational value or a range of positive rationals, with a unit. A qualitative amount stores text such as `al gusto`. An unspecified amount stores the ingredient without a measurement. |
| `Ingredient` | Stable ID, display name, optional parent ingredient ID, optional grams-per-milliliter equivalence with provenance, and optional dietary or type metadata for tag suggestions. Each cut or preparation that should stay distinct has its own ID. |
| `Category` | Stable ID, display name, and a type of `dish_type` or `cuisine`. Users can edit categories and assign several to the same recipe. |
| `Photo` | Stable ID, processed image bytes, MIME type, and dimensions. Replace or remove photos in the same IndexedDB transaction as changes to their recipe reference. |
| `ActiveMenu` | One locally stored list of entries. Each entry has its own ID, a source recipe ID, a snapshot of the title and normalized ingredient lines, and a positive integer portion count. Snapshot lines include stable ingredient and unit identities, display names, and the equivalence used for any mass–volume conversion. Existing entries survive edits or deletion of their source recipe. |

### Portions and arithmetic

- Prefill the capture form with four portions and allow any positive integer. On save, multiply each numeric quantity or range endpoint by `4 / enteredPortions`. Leave qualitative and unspecified amounts as entered. Editing an existing recipe starts from its saved four-portion quantities.
- Initialize a menu batch at four portions. For a batch of `N` portions, derive amounts using `N / 4` from the stored snapshot, including after repeated changes. Add a recipe again to plan a second batch when needed. Each batch contributes to the list once, regardless of when its portions will be eaten.
- Parse integers, decimal quantities, simple and mixed fractions such as `1/2` or `1 1/2`, and ranges with two endpoints. Accept decimal point or comma without thousands separators. Reject zero or negative measured values, zero denominators, reversed ranges, and invalid portion counts with field-specific feedback.
- Reduce fractions using integer arithmetic. Persist numerator and denominator as decimal strings so the representation can later be serialized without losing precision. Format common quantities as integers, exact decimals, or mixed fractions, with no rounding of counted ingredients for shopping. Preserve the exact computed value when a conversion has a long display value. Identify mass–volume amounts based on an ingredient equivalence as approximate.

### Units and ingredient identity

- Start with `g`, `kg`, `ml`, `L`, `taza`, `cda`, `cdta`, mass ounces (`oz`), US fluid ounces (`fl oz EE. UU.`), pieces, and household measures such as `pizca` and `manojo`. Use separate unit IDs for mass ounces and fluid ounces. Follow Profeco's cooking convention of 250 ml per cup, 15 ml per tablespoon, and 5 ml per teaspoon. Use NIST factors for US customary units and show which ounce the user is selecting. [Profeco kitchen equivalences](https://bibliotecadelconsumidor.profeco.gob.mx/media/revistas/RC-428%20Octubre%202012.pdf) · [NIST SI conversion factors](https://www.nist.gov/pml/special-publication-811/nist-guide-si-appendix-b-conversion-factors/nist-guide-si-appendix-b9)
- Allow conversions in both directions between units of the same dimension. Enable volume ↔ mass when the selected ingredient has a specific equivalence. Seed a small reference set for common ingredients such as flour, sugar, and cooking oil, with source and preparation where relevant. Let the user enter or replace an ingredient's equivalence. When it is missing, keep the original unit available. [NIST culinary measurement guidance](https://www.nist.gov/pml/owm/metric-si/metric-kitchen/metric-kitchen-culinary-measurement-tips)
- Use catalog autocomplete with inline creation. Normalize case, spacing, and accents for lookup and duplicate suggestions. Match shopping lines by selected catalog ID. An optional parent enables a `Pollo` filter to match recipes using associated cuts, while `Pechuga de pollo` and `Milanesa de pollo` stay distinct on the shopping list.
- Offer a display-unit choice for compatible measures in recipe detail and for eligible shopping totals. Display changes leave stored amounts untouched. A pinch or bunch can scale and sum with the same measure while remaining in its original unit.

### Categorization and suggestions

- Seed editable dish types such as `Desayunos`, `Postres`, `Salsas`, `Platillos fuertes`, and `Acompañamientos`. Seed cuisine examples such as `Mexicana` and `China`. Search names without requiring accents or exact case.
- Combine the active search and different filter groups with AND. Within a group, match any of the selected options. Use distinct groups for dish type, cuisine, tags, and ingredients. For example, selecting `Mexicana` and ingredient `Pollo` returns Mexican recipes that contain chicken or one of its cataloged cuts.
- Use pre-defined tags such as `Vegana`, `Vegetariana`, `Contiene carne`, `Contiene pescado`, and `Mariscos`. Suggest tags locally from recognized ingredient metadata. Fish and shellfish are distinct signals. Only suggest dietary suitability when all ingredient lines have sufficient classification and the rule is satisfied. Display suggestions for review and support manual tagging. Filter by confirmed tags.

### Shopping list aggregation

1. Scale each snapshot ingredient quantity to the batch's current portion count. Keep each ingredient's amounts grouped under its catalog ID.
2. Sum compatible measured amounts in a common unit. Treat a single numeric value as a range with equal endpoints when summing it with a range. Combine pieces or equal household measures by unit. Normalize mass and volume separately before considering a cross-dimension total.
3. Combine mass with volume only when the affected snapshot lines have the same applicable ingredient equivalence. Otherwise present separate amounts under the same ingredient. Choose a practical output unit by default, such as grams below 1 kg and kilograms at or above 1 kg. A user-selected compatible unit overrides the default display.
4. Show qualitative or unspecified amounts alongside measured totals when both exist. Keep distinct qualitative notes and show identical notes once within an ingredient. A recipe with zero ingredients can enter the menu and is identified there as having no ingredients to contribute.
5. Recalculate after adding or removing a batch, changing its portions, or clearing the active menu. An edit to the original recipe or to its catalog records leaves existing batch amounts intact. To use the latest saved recipe, remove the batch and add it again.

## Implementation phases

### Phase 0 — Validate the foundation

**Deliverable** — A reproducible, installable Solid 2 PWA shell.

- Scaffold the client app, package lockfile, build, type-checking, linting and test commands. Confirm compatible Solid integration, routing, and service worker tooling against the production build.
- Set the document language, app manifest, navigation shell, icons, and HTTPS preview environment. Choose a stable deployment origin for release.
- Verify an IndexedDB record and test image survive a reload. Run an early offline and installation check on Safari for iOS and Chrome for Android to catch platform-specific behavior before building the full workflow.

**Exit criteria** — The production build loads on both mobile browsers, can be added to the home screen, and can reopen the shell after an initial online load. A sample record survives browser and app restarts in the tested context. [WebKit home-screen web apps](https://webkit.org/blog/13878/)

### Phase 1 — Build the domain and local storage

**Depends on Phase 0.** Deliver the versioned IndexedDB schema and tested rules for recipes, ingredients, measurements, and portions.

- Implement rational parsing, scaling, comparison, persistence and formatting. Define unit IDs, dimensions, conversion factors, and ingredient-specific equivalences.
- Implement repositories and write transactions, initial categories and tags, ingredient metadata and density seeds, and the snapshot schema. Handle errors without reporting a successful save when a write fails.
- Verify round trips through persistence, repeated portion changes, clean install, IndexedDB upgrade handling, and invalid input at the domain boundary.

**Exit criteria** — Capture `500 g` and `2 piezas` for two portions, reopen with `1 kg` and `4 piezas` at four portions, and derive the original amounts at two portions without loss. A `1½` quantity survives a storage round trip and a temporary display-unit change.

### Phase 2 — Deliver the manual recipe library

**Depends on Phase 1.** Deliver browse, view, create, edit and delete for recipes, images, ingredients, categories and tags.

- Implement the recipe form and detail views, including ingredient autocomplete and inline creation, quantity variants, ordered steps, and the optional source URL. Provide catalog editing for an ingredient's parent, classification, and equivalence. Validate the source URL without fetching it. Show previews and errors for photo attachment and replacement, and resize large supported photos locally before storing them.
- Implement category management, tag suggestions and confirmation, combined filters, loading and empty states, and Spanish form validation. Keep unsaved form edits available after a failed write.
- Verify that changing a display unit preserves the exact stored value and that the recipe remains usable with only its name present.

**Exit criteria** — Create a name-only recipe. Create a complete recipe with a photo, reorderable steps, multiple categories, tags, mixed ingredient measures, and a source URL. Reopen it after a restart, change it, and verify it appears under a combined cuisine-and-ingredient filter.

### Phase 3 — Deliver the active menu and shopping list

**Depends on Phase 2.** Deliver the full weekly planning flow.

- Add batches from the recipe library and detail view. Persist each snapshot at creation. Provide portion editing, batch removal, and an explicit clear-menu action with confirmation.
- Build shopping aggregation and responsive read-only list views, including compatible display conversion, distinct cuts, ranges, `al gusto`, and ingredients with no quantity.
- Test independent batches, repeated additions, zero-ingredient recipes, and recipe edits or deletion after a batch is created.

**Exit criteria** — On the same menu, `500 g` plus `1 kg` of the same ingredient appears as `1.5 kg`. Two recipes contributing two eggs each show four eggs. `2–3 chiles` plus one chile yields `3–4 chiles`. Chicken cuts stay separate. A cup converts to 250 ml and back. A test equivalence of `0.8 g/ml` makes 100 ml and 80 g of the same ingredient aggregate to approximately 160 g when displayed by mass. With no equivalence, both amounts remain visible separately. Doubling a batch updates purchases without altering the recipe. Editing or deleting the recipe later preserves the batch totals.

### Phase 4 — Verify, deploy, and release

**Depends on Phase 3.** Deliver the v1 PWA over HTTPS.

- Run unit tests of the domain, IndexedDB integration tests, and browser end-to-end tests for recipe creation, filtering, menu scaling, and shopping totals. Check touch and keyboard operation, narrow screens, focus and accessible feedback, and Spanish UI coverage.
- Test installation and app restart on iOS and Android, and verify the workflow on desktop. In airplane mode after the first load, create or edit a recipe, add a photo, change portions, and reopen the shopping list. Verify that an external source link can be opened when connectivity returns.
- Deploy on the chosen HTTPS origin and test a build update with existing recipes, photos and a populated menu. Record the supported browsers and deployment steps in English. Provide installation and local storage help in the Spanish UI.

**Exit criteria** — All previous exit criteria pass on the production build. The core workflow remains usable offline, updates retain existing data, and save failures are visible and recoverable. The user can plan a week's meals and use the shopping list on a phone in Spanish.
