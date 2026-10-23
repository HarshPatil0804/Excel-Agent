# Manual large-file verification

Generate a deterministic, messy CSV locally (the generator writes to disk and does not upload anything):

```powershell
node scripts/generate-large-csv.mjs --output .\large-test.csv --rows 500000
(Get-Item .\large-test.csv).Length / 1MB
```

The default should exceed 50 MB. If it does not on your runtime, increase `--rows` until the reported size is at least 50 MB. Start the app with `npm run dev`, open it in a current desktop browser, and select `large-test.csv`.

Check that the upload enters large-file mode, row progress advances while CSV chunks are inserted into DuckDB-WASM, and the browser remains interactive. After parsing, run Smart Clean and accept a risky proposal. Confirm the dry-run counts and samples, then apply it and check the review log and preview. Exercise Undo, Redo, and Reset to original; compare row counts and preview values with the original. Cancel a long-running decision and verify that it reports cancellation without applying a partial result.

## Verification run (2026-10-15)

Measurements were taken on this development machine with Node.js and the repository's local dependencies. The 98 MB file was generated with the command above and then streamed through PapaParse's Node stream parser. The scale test used DuckDB-WASM's Node blocking binding.

| Workload | Elapsed | Peak process RSS | Result |
| --- | ---: | ---: | --- |
| Generate 500,000-row CSV (98,151,851 bytes / 93.6 MiB) | 1.25 s | 81.2 MiB | Completed |
| PapaParse stream parse of that CSV | 1.18 s | 58.3 MiB (61,100,032 bytes) | 500,000 rows; 0 ragged rows |
| DuckDB-WASM combined 1,000-column × 100,000-row test | 39.05 s | 76.4 MiB (80,068,608 bytes) | 5 risky SQL decisions; protected column unchanged; reset points to immutable original |

The scale fixture includes messy whitespace/missing tokens, currency text, mixed dates, duplicate keys, outliers, and a protected field in its text columns; its other 994 columns are compact numeric expressions. The scale test exercises the production low-risk SQL expressions, risky SQL builder, DuckDB execution, and version-view reset path. It does not instantiate the browser parse/clean workers, run the browser profiling implementation, or replay an uploaded CSV through the full app.

The parser timing is not a browser upload/clean timing: it measures PapaParse streaming only and excludes DuckDB insertion and profiling. A real-browser test could not be automated here because the available browser interface exposes no file-chooser or page-script/PerformanceObserver API. The previous mocked-worker responsiveness test was removed; UI-thread responsiveness and progress on a real 50 MB+ browser upload remain unverified. Run the manual steps above in the target browser/device and record its device/browser, elapsed time, and memory reading before treating those as measured.
