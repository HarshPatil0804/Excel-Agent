# Architecture notes

The application is a static SPA. CSV, TSV, XLSX, XLS, and JSON files are parsed locally in a dedicated Web Worker. Files under 50 MB and workbooks are profiled in that worker; large delimited files stream into DuckDB-WASM in adaptive batches and are profiled with SQL aggregates. Do not add a service that receives user data.

The upload phase keeps the original file and parsed rows unchanged. The UI renders profile summaries and a virtualized preview of up to 1,000 rows.

## Large-file change history

`dataset_original` is immutable. Smart Clean creates one materialized cleaned base table, and the worker represents each subsequent risky decision as a DuckDB view over the prior version. The active `dataset` view is a pointer to the selected version. Undo and redo move that pointer through the operation chain; reset points it at `dataset_original`. This keeps history metadata proportional to the number of operations and avoids copying a 1M-row table for every step. Views can recompute their SQL when read, so long review operations remain worker-only and may take longer on large or wide datasets.
