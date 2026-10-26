# DataCleaner master prompt progress

Updated: 2026-10-26

## Phase 1 — Dates
- [x] Normalize supported date formats to ISO; detect order from column evidence and reject impossible dates to empty with a review issue.
- [x] Track Excel-typed date cells, propose one bulk swap only when text evidence makes it unambiguous, and preserve pending/undo behavior.
- [x] Add parser, detector, leap-year, decision, and in-memory/DuckDB SQL expression tests.
- [ ] Acceptance: 1,953 valid ISO dates, 24 invalid empties, range 2026-01-01 to 2026-08-20, 760 swaps, 46 equal-day unchanged.
- Last tests: `npm test` (84 passing), `npm run typecheck`, `npm run lint`, and `npm run build` passed on 2026-10-25. DuckDB SQL normalization is integrated in the large worker path.
- Blockers: ecommerce-practice.xlsx is not yet available; acceptance counts and Excel bulk-swap count cannot be confirmed.

Plan: update XLSX parsing to retain Excel-date cell coordinates and add a deterministic date normalizer. Add evidence detection and a pending risky bulk-swap action without changing ambiguous values automatically. Test pure date behavior first, then integrate profile, worker, and UI review. Run the full local checks; exact workbook numbers remain blocked until the fixture arrives.

## Phase 2 — Money and numbers
- [x] Repair common mojibake sequences only when suspicious-character count decreases; test Unicode examples.
- [x] Parse currency/number formats only when at least 90% of present cells parse; record mixed-currency families and flags.
- [x] Add deterministic edge-case, in-memory, and DuckDB SQL parity tests for supported number formats and mojibake.
- Acceptance: Revenue 1,950 numeric, 27 empty; 0 mojibake markers after repair.
- Last tests: `npm test` (84 passing), `npm run typecheck`, `npm run lint`, and `npm run build` passed on 2026-10-25.
- Blockers: exact Revenue/empty/mojibake acceptance counts require ecommerce-practice.xlsx.

Plan: extend formatted-number parsing for currency codes/symbols and regional separators, and gate coercion on a measured 90% parse rate. Profile currency families and flag mixed currencies without changing values beyond deterministic parsing. Verify identical behavior in memory and DuckDB, then check exact workbook counts when supplied.

## Phase 3 — Categories
- [x] Automatically canonicalize punctuation/case/space variants using most frequent spelling and a Title Case tie break.
- [x] Keep fuzzy merges pending, user-editable proposals with a 0.85 similarity threshold.
- [x] Test deterministic mappings and DuckDB expression parity.
- Acceptance: Category 15→5, Region 22→7 (blanks kept), Product remains 24, rows unchanged.
- Last tests: category/mapping tests and the full standard suite (84 passing), typecheck, lint, and build passed on 2026-10-25.
- Blockers: exact category counts and row invariance require ecommerce-practice.xlsx.

Plan: canonicalize only identical normalized category keys, preserving the most common spelling and a deterministic title-case tie break. Keep near matches as pending proposals so users can inspect and edit mappings. Test in-memory transformation and the DuckDB CASE-expression path, then validate exact workbook reductions.

## Phase 4 — Validation and flags
- [x] Add name/type-driven quantity, profit, ID, and future-date profile flags; flags do not mutate values.
- [x] Add bulk leave/empty/absolute decisions with dry-run and exact samples; these do not remove rows and preserve the existing safety guard.
- [x] Keep IQR outlier behavior flag-only by default.
- Acceptance: 41 negative quantities and 15 negative profits flagged; zero values changed before a decision.
- Last tests: full standard suite (84 passing), typecheck, lint, and build passed on 2026-10-25; the newer validation action tests pass focused.
- Blockers: exact issue counts require ecommerce-practice.xlsx.

Plan: add non-mutating domain checks for quantity, profit, identifiers, and future dates based on names and inferred types. Surface grouped issues and bulk decisions with exact dry-run counts and the existing safety guard. Add synthetic tests before checking ecommerce acceptance counts.

## Phase 5 — Missing choice and optional deterministic local ML
- [x] Default every missing cell to keep; group choice panel, ID/text exclusions, bulk actions, threshold guard.
- [x] Implement seeded worker predictions, held-out comparison with a median baseline, uncertainty metadata, and recommendations only when validation improves.
- [ ] Verify estimate evaluation responsiveness and wide-data behavior in a real browser; model output never mutates or fills data.
- [x] Replaced DuckDB's 1%-hash filter with a repeatable hash-ordered sample capped at 50,000 rows; DuckDB integration coverage proves a 120-row table is sampled completely and repeatably.
- [x] Test eligibility, reproducibility, non-overwrite, and >40% missing/ID exclusions; undo/reset remains covered by the existing history tests.
- [x] Strengthened numeric estimate validation to require 100 observed examples, combine three independent seeded 20% holdouts, report MAE and MAPE, and recommend only when both applicable errors improve by at least 10%.
- [x] Added deterministic ridge regression with bounded numeric/one-hot predictors; numeric recommendations compare it and weighted KNN against the median baseline and apply the selected method in memory or DuckDB batches. Tests verify seeded validation, near-exact linear recovery, and in-memory/DuckDB estimate parity.
- [x] Added a weighted KNN categorical classifier for categorical/boolean targets, one-hot-like nominal distance handling with a 20-level predictor cap, grouped most-frequent baseline comparison, three seeded validation splits, and review-visible accuracy metrics.
- [x] Added a one-click “Keep all missing” action that resolves missing-value proposals as skipped without changing dataset cells.
- [x] Added explicit in-memory acceptance for validated predictions on datasets up to 5,000 rows. Application uses the existing dry-run/confirmation/history path, never overwrites observed cells, clips numeric estimates to observed limits, rounds integer targets, records estimated-cell counts and validation metrics, and exposes estimate uncertainty in preview/report metadata.
- [x] Added DuckDB estimate application: a 5,000-row deterministic training subset is drawn from up to 50,000 sampled rows; missing-row predictions are written into a local estimate table in 2,000-row batches; an accepted versioned view preserves source immutability and uses existing DuckDB history for undo/reset. Dry run returns exact predicted-cell counts and up to 10 before/after samples. The worker re-checks validation improvement, 40% missing limit, and identifier/protected-column exclusions.
- [x] Added seeded-estimate parity coverage on numeric rows, including prediction values within 1e-10 tolerance, exact applied values, row order, source immutability, and reversible DuckDB view materialization.
- [x] Added explicit, user-selected group-median and group-mode fills with deterministic per-group aggregates in memory and correlated DuckDB SQL; parity covers numeric medians, categorical modes, and stable ties. Both remain behind dry-run confirmation.
- [x] Added a bulk “Apply to all numeric columns” target selector for missing-value decisions; it deduplicates selected names and excludes protected/identifier columns.
- [x] Added explicit pending review proposals for high-missing columns that Smart Clean leaves untouched.
- Acceptance: listed exact missing counts; ML only recommended from measured validation; >40% missing and IDs disabled.
- [x] Numeric regression accepts bounded nominal predictors; a regression test verifies category-only signal is usable and still gated by held-out error.
- Last tests: full standard suite (122 tests across 14 files), `npm run typecheck`, `npm run lint`, and `npm run build` pass on 2026-10-26. Focused parity covers KNN/ridge estimates and grouped median/mode fills. Forward fill requires explicit row-order confirmation in both engines; bulk numeric scope filters duplicate, ID, and protected columns. `npm run test:scale` isolates each scenario in its own process and passes: 1,000×100,000 clean/review/undo in 40.48 s; 100,000-row ridge estimate in 1.61 s; 1M-row bundle in 4.19 s; maximum process peak RSS 80,949,248 bytes. See `docs/manual-test.md`.
- Blockers: the new worker flow has not been exercised with a real large file in a browser; large-model runtime at 1M rows is not measured; exact fixture acceptance remains unverified; ecommerce workbook pending. Exact-derivation fills and iterative/tree model families remain incomplete.

Plan:
- Exercise the new estimate flow with a real large CSV in a browser, then continue incomplete Phase 5 choice/model families and validate workbook acceptance when the fixture arrives.
- Implement deterministic exact-derivation fills only when a deterministic relation is confirmed and the user accepts the dry run.
- Add iterative or small tree-based numeric alternatives behind validation against appropriate baselines.
- Verify browser estimate and large-file responsiveness, progress, and cancellation.
- Run fixture acceptance and standard checks; source workbook acceptance remains blocked until the workbook is available.

## Phase 6 — Review and counts
- [ ] Verify exact separate counts, current summary cards, Cleaned default preview, and issue-gated proposals in the UI.
- [x] Add repeat-clean/history regression coverage: a second run reports zero changes while preserving the first run log entry.
- [ ] Add full component-level tests for summary cards, preview default/toggle, and review action states.
- [x] Extracted review metrics and added regression tests: selection counts unique columns and caps at current dataset width; pending and decide-later proposals remain unresolved until accepted or skipped.
- [x] Risky proposals are ordered by estimated affected-cell impact with stable ties in both in-memory and DuckDB review results; tested duplicate-row impact ahead of a lower-impact missing-value proposal.
- Acceptance: second run zero changes without overwriting history; exact logged cell/row/column/flag/fill counts.
- Last tests: `npm test` (107 passing across 14 files), typecheck, lint, and build passed on 2026-10-26. Focused helper tests cover distinct selection, pending/deferred decision counts, and deterministic proposal ranking; full component acceptance tests for review actions/cards remain pending.

Plan: reconcile grouped review counts with log entries and the current dataset summary, preserving pending decision states. Add repeated-clean, counter, and UI-state regression coverage. Use exact fixture numbers when available and keep synthetic checks separate from acceptance claims.

## Phase 7 — Download and compare
- [ ] Finish export defaults, full compare/diff/removed rows, changes CSV, Markdown report, worker ZIP, and re-import verification for both storage paths.
- [x] Add paged DuckDB cell-diff retrieval and stable-ID alignment, plus in-memory row-ID alignment so deletions do not create false subsequent changes.
- [x] Track removed row IDs and expose a separate removed-row CSV: in-memory files build it in an export worker; DuckDB files anti-join against the immutable original and stream pages with the earliest removal-rule label.
- [x] Cast DuckDB JSON Lines output according to profile types; serialize invalid/non-finite numeric values as JSON null rather than strings or invalid JSON.
- [x] Add a large-file “Verify download” action that re-parses the saved CSV/JSONL incrementally in the worker, comparing all cells, columns, row count, and null counts against DuckDB.
- [x] Stream DuckDB-backed “Download all” ZIP entries from the data worker with paged CSV/JSONL and changes CSV, a bounded 250,000-cell data page, backpressure, save-handle output, and cancel/abort behavior. Added a DuckDB integration test for ZIP contents and a 1,000-column batch-bound test.
- [x] Reconcile Global Library-shaped in-memory change-log cell totals with the complete cell diff; include the full changed-cell CSV in in-memory ZIPs, preserving renames, row IDs, primitive types, null/empty changes, and mapped steps.
- [x] Share one tested Markdown report builder between standalone report downloads and ZIP bundles, including ordered steps, timestamps, separate counts, up to 10 samples per step, decisions, and flagged unchanged issues.
- [ ] Verify exact export/log/diff totals across all rules and datasets; browser file cancellation, save-picker behavior, and memory limits remain unverified.
- Acceptance: CSV/XLSX/JSON or JSONL fidelity; totals reconcile; generated file round-trips.
- Added a DuckDB-backed compare query aligned by stable column ID, ordered by immutable row ID, and paged in 1,000-cell UI requests. It only returns a bounded changed-cell page to JavaScript.
- In-memory compare now carries a collision-checked parse-time row-order key and maps cleaned columns to their original names by profile ID. Removed rows are excluded from the cell-diff list instead of shifting and falsely marking subsequent rows changed. A regression test covers row removal plus rename alignment.
- Last tests: `npm test` (103 passing across 13 files), typecheck, lint, and build passed on 2026-10-26. Real DuckDB integration verifies paged diff, removed-row SQL classification/rule attribution, typed JSON scalar casts/null normalization, renamed-column matching, trim changes, and null-to-value changes. Synthetic Global Library-shaped (219×7) and train-shaped (119→102) data pass CSV/XLSX/JSON export and re-import on both engines. The Global Library-shaped log total matches its complete in-memory diff. The DuckDB ZIP-session integration test verifies all four archive entries and escaped change samples; a separate 1M-row DuckDB bundle run completed in 4.04 seconds, wrote 14,778,373 bytes, and emitted 212 chunks (75,000-byte maximum). The actual saved-file worker flow has not been run in a real browser.
- Blockers: real-browser validation of streamed downloads, verification, and cancel/abort behavior; exact export/log/diff reconciliation; and full round-trip history acceptance remain incomplete.

Plan: audit the existing Phase 5 export work against every requested format, fidelity rule, compare view, and report artifact. Complete missing large-data and DuckDB paths in workers with cancellation and verification. Add round-trip, reconciliation, and memory/cancel tests before phase commit.

## Phase 8 — End-to-end regression
- [ ] Run each source fixture through reset, clean, documented decisions, CSV/XLSX export, re-import, profile, undo-all, and exact restore on both engines. Synthetic Global Library/train-shaped CSV/XLSX/JSON export and re-import are now covered on both engines; complete history/round-trip UI flow is not covered.
- [x] Add stable generated wide-data coverage without checking generated large files into fixtures; the separate scale run passed.
- Acceptance: ecommerce, Global Library, and train exact counts and parity.
- Last tests: `npm run test:scale` passed on 2026-10-26 for the generated 1,000-column × 100,000-row DuckDB clean/review/undo path (40.48 seconds), 100,000-row ridge estimate path (1.61 seconds), and generated 1M-row DuckDB ZIP bundle stream (4.19 seconds). The largest per-process RSS was 80,949,248 bytes. It accepted 5 risky decisions, preserved a protected column, restored the immutable original exactly, estimated 5,000 missing cells with a validated ridge model, and streamed 14,778,373 bytes in 212 chunks (75,000-byte maximum). Neither scenario exercises browser UI rendering, the picker, or browser memory behavior.
- Blockers: ecommerce workbook pending; full export/compare/round-trip sequence depends on Phase 7. The repository does not contain the Global Library workbook; only generated Global Library-shaped and train-shaped tests are available.

Plan: use the real ecommerce workbook plus Global Library and train fixtures for documented decision flows. Compare reset, clean, export/re-import, profile, undo, and exact original restoration across in-memory and DuckDB paths. Generate large fixtures deterministically without checking them into source control, then run the complete required checks.

## Commits
- No master-prompt phase commits yet. Existing workspace contains uncommitted Phase 7 work from the prior request; preserve it and isolate phase commits after each phase passes.

## Current verification summary
- Standard checks: `npm run lint`, `npm run typecheck`, `npm test` (14 files, 122 tests), and `npm run build` all pass as of 2026-10-26. `git diff --check` passes (Git reports existing LF-to-CRLF normalization warnings only).
- Scale check: latest `npm run test:scale` passed in isolated processes for the generated 1,000-column × 100,000-row DuckDB scenario (40.48 seconds), 100,000-row validated ridge estimate scenario (1.61 seconds), and generated 1M-row DuckDB bundle stream (4.19 seconds). Maximum process peak RSS was 80,949,248 bytes. It verified 5 risky decisions, protected-column invariance, exact original restore, 5,000 ridge estimates with source nulls retained and view nulls filled, a 14,778,373-byte ZIP stream, 212 emitted chunks, and a 75,000-byte maximum chunk. It did not cover real-browser rendering, file-picker writes, or browser memory use.
- Verified synthetic acceptance: Global Library-shaped Smart Clean preserves 219 rows and 7 columns; formatted-number conversion count 854, trim count 1, missing normalization count 29, renamed columns 7, rows removed 0. Train-shaped data preserves 119 rows until duplicate acceptance, then yields 102. These are generated regression fixtures, not the absent source workbooks.
- Verified: DuckDB ZIP-session output contains the cleaned CSV, complete changed-cell CSV, report, and recipe in an integration test; 1M rows stream to 212 bounded chunks without retaining the assembled archive, and wide-data pages are capped at 250,000 cells. This tests the session and archive bytes, not browser file-picker behavior.
- Not verified: ecommerce-practice.xlsx acceptance values; exact Global Library/train source workbook runs; new DuckDB model-estimate worker flow in a real browser or under 1M-row load; real-browser large-file download, verification, or cancel/abort; exact export/log/diff reconciliation; full export/re-import/undo flow across both engines; actual 50 MB+ browser behavior. The local generated ecommerce workbook is still not present; the latest user reply says they will attach it, but no workbook has appeared in `tests/fixtures`.
- No phase is marked passed and no master-prompt phase commit has been made because the source-workbook and full acceptance checks are incomplete. Existing changes remain uncommitted.
