# Architecture notes

The application is a static SPA. CSV, TSV, XLSX, XLS, and JSON files are parsed locally in a dedicated Web Worker. Files under 50 MB and workbooks are profiled in that worker; large delimited files stream into DuckDB-WASM in adaptive batches and are profiled with SQL aggregates. Do not add a service that receives user data.

The upload phase keeps the original file and parsed rows unchanged. The UI renders profile summaries and a virtualized preview of up to 1,000 rows.

In-memory rows receive a collision-checked internal row-order property in the parsing worker. It is excluded from the profile and from exports and survives row filtering and column renaming so the compare worker can match original rows after removals. DuckDB uses its immutable `__dc_order` value for the same purpose. Compare pages align columns through stable IDs and expand changed values inside DuckDB, returning at most 1,000 cells per UI request.

## Large-file change history

`dataset_original` is immutable. Smart Clean creates one materialized cleaned base table, and the worker represents each subsequent risky decision as a DuckDB view over the prior version. The active `dataset` view is a pointer to the selected version. Undo and redo move that pointer through the operation chain; reset points it at `dataset_original`. This keeps history metadata proportional to the number of operations and avoids copying a 1M-row table for every step. Views can recompute their SQL when read, so long review operations remain worker-only and may take longer on large or wide datasets.

Validated model estimates use a deterministic sample of at most 50,000 rows, then a seeded 5,000-row training subset for large-file evaluation/application. The worker predicts missing targets from ordered pages of at most 2,000 rows and writes predicted values plus uncertainty to a DuckDB temp table. A versioned view joins those estimates with the prior version; the immutable source stays unchanged. The view and estimate table remain available for history replay until the worker session ends or a new Smart Clean rebuilds the history. Estimate batches report rows processed and support cancellation before the view is applied.

## Large-file exports and ZIP bundles

DuckDB CSV/JSON Lines and ZIP bundle generation run in the local data worker. A bundle pages the cleaned dataset and changed-cell query into a ZIP store writer that emits uncompressed data chunks and retains only the small central directory. The UI requests the next worker page only after writing the previous chunk, providing backpressure for the File System Access save stream. If that API is unavailable, the UI collects Blob parts until completion and warns that this fallback uses more memory. A canceled save aborts the writable and clears buffered fallback chunks. ZIP64 is not implemented; a bundle larger than 4 GB fails with a message to download the cleaned dataset and change report separately.

For very wide datasets, the cleaned-data export batch is capped at 250,000 cells (for example, 250 rows at 1,000 columns). The changed-cell stream uses ordered row/column cursors after an exact count query, avoiding an ever-growing OFFSET during sequential archive generation.
