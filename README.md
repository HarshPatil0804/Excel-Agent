# DataCleaner

DataCleaner is a browser-only workspace for preparing CSV, Excel, and JSON data. The product is designed so user data stays on the user's device: processing will run in the browser, with in-memory or IndexedDB state and no backend or data telemetry.

## Current phase: Smart Clean, local estimates, and export

The app provides local file parsing and profiling plus deterministic Smart Clean, review, optional local estimates, and export flows. Low-risk rules run across all applicable columns in a worker, protected columns are skipped, and higher-risk rules are shown as proposals. Large CSV/TSV files use local DuckDB-WASM; recipes are stored in IndexedDB and can be exported or imported as JSON.

## Run locally

```sh
npm install
npm run dev
```

Open `/docs/components` for the component preview. Select or drop a CSV, TSV, XLSX, XLS, or JSON file to parse, profile, and review Smart Clean locally. Use the Download and What changed panels for local export and comparison. The production bundle is generated with `npm run build`.

## Stack

Vite, React, strict TypeScript, Tailwind CSS, Zustand, DuckDB-WASM, PapaParse, SheetJS, ECharts, Zod, Vitest, Testing Library, ESLint, and Prettier.

## Missing values and optional estimates

Missing values are kept by default because an empty cell can carry real meaning. The review groups missing-value issues and offers a bulk “Keep all missing” choice; fill actions require an explicit user decision, and columns above the configured missing-rate threshold are deferred. Identifier and free-text columns are excluded from imputation.

The user may choose simple median, mean, mode, constant, or forward-fill strategies, or choose median/mode within a grouping column. Grouped fills use deterministic per-group aggregates in both the in-memory and DuckDB paths. Every fill remains behind a dry run and explicit confirmation. Forward-fill currently follows row order; use it only when the file is already ordered as intended.

The optional estimate evaluator uses seeded local worker models and compares three seeded 20% holdouts against simple baselines. Numeric targets compare weighted KNN and ridge regression with the median baseline, reporting MAE and MAPE (MAPE is unavailable when held-out actuals are all zero). The best model is recommended only when both applicable errors improve by at least 10%. Numeric models accept bounded nominal predictors as well as numeric predictors. Categorical targets use a weighted KNN classifier and compare accuracy with a grouped most-frequent baseline; recommendation requires a 10 percentage-point improvement. Estimates are labeled as estimates, shown with uncertainty, and never applied until the user previews and confirms them. In-memory application is limited to datasets up to 5,000 rows. DuckDB-backed application uses a reproducible 5,000-row training sample drawn from up to 50,000 rows, predicts missing cells in 2,000-row worker batches, and applies accepted predictions through a versioned view. It reports dry-run counts and samples, never overwrites observed values, clips numeric estimates to observed limits, rounds integer targets, preserves non-negative targets, and supports undo/reset. Real-browser large-file performance and cancellation remain unverified. Exact-derivation fills and iterative/tree model families remain incomplete.

## Phase roadmap

1. **Setup:** static app shell, design system, component preview, types, stores, CI, and deployment config.
2. **Import, parsing, and profiling:** local CSV/XLSX/JSON parsing, large delimited files through DuckDB-WASM, column profiling, and data preview.
3. **Smart Clean:** scoped deterministic rules, global protected columns, grouped change review, worker progress, and local JSON recipes.
4. **Review and export (in progress):** before/after review, data export, change log, and undo/redo. DuckDB compare/verify and full end-to-end fixture acceptance remain incomplete.
5. **Optional suggestions:** external AI is out of scope for this browser-only deterministic implementation; any future suggestion feature must not apply changes automatically.

## Privacy requirements

No backend, server calls, analytics that send data, or remote assets. All user data stays in browser memory or IndexedDB. See [AGENTS.md](./AGENTS.md) for contributor requirements.

## Import and cleaning behavior

- Files are validated by extension only; there is no file-size rejection. CSV/TSV files under 50 MB parse in a dedicated worker. Files at or above 50 MB stream into the bundled local DuckDB-WASM worker with adaptive row batches (up to 50,000 rows).
- XLS/XLSX is not streamable and is parsed in the worker as a whole workbook. Large workbooks show a memory warning. Files above 500 MB show a non-blocking device-memory warning.
- The uploaded dataset remains immutable. Small-file clean results use a copied row array; large-file rules operate on a DuckDB copy. Data remains in browser memory or the local worker until start over or the tab closes. Recipes live in IndexedDB.
- Smart Clean applies trim whitespace, missing-value normalization, formatted-number conversion, column-name normalization, empty-row/column removal, and obvious type fixes. Risky rules remain unapplied proposals.
- The preview shows at most 1,000 rows and virtualizes rows and columns. Profile rows are also virtualized. Device memory remains the practical limit for very wide or very large files.
- Tests cover 1,000-column planning and protected-column immutability, 100k/1M-row batching, responsive worker UI behavior, and recipe matching for renamed/missing columns. The combined 1,000-column-by-100k-row fixture is not checked into the repository because it expands to 100 million cells; large-browser stress testing remains device-dependent.

Run the full verification suite with `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
