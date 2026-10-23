# DataCleaner

DataCleaner is a browser-only workspace for preparing CSV, Excel, and JSON data. The product is designed so user data stays on the user's device: processing will run in the browser, with in-memory or IndexedDB state and no backend or data telemetry.

## Current phase: Smart Clean and scale support

The app provides local file parsing and profiling plus a deterministic Smart Clean flow. Low-risk rules run across all applicable columns in a worker, protected columns are skipped, and higher-risk rules are shown as proposals. Large CSV/TSV files use local DuckDB-WASM; recipes are stored in IndexedDB and can be exported or imported as JSON.

## Run locally

```sh
npm install
npm run dev
```

Open `/docs/components` for the component preview. Select or drop a CSV, TSV, XLSX, XLS, or JSON file to parse, profile, and review Smart Clean locally. The production bundle is generated with `npm run build`.

## Stack

Vite, React, strict TypeScript, Tailwind CSS, Zustand, DuckDB-WASM, PapaParse, SheetJS, ECharts, Zod, Vitest, Testing Library, ESLint, and Prettier.

## Phase roadmap

1. **Setup:** static app shell, design system, component preview, types, stores, CI, and deployment config.
2. **Import, parsing, and profiling:** local CSV/XLSX/JSON parsing, large delimited files through DuckDB-WASM, column profiling, and data preview.
3. **Smart Clean (current):** scoped deterministic rules, global protected columns, grouped change review, worker progress, and local JSON recipes.
4. **Review and export:** full before/after dashboard, data export, change log, and undo/redo.
5. **Optional suggestions:** AI may suggest rules later; the user remains in control and application stays deterministic.

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
