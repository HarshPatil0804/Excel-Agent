# Manual large-file verification

Generate a deterministic, messy CSV locally (the generator writes to disk and does not upload anything):

```powershell
New-Item -ItemType Directory -Force tests/fixtures/generated | Out-Null
node scripts/generate-large-csv.mjs --output tests/fixtures/generated/large-test.csv --rows 500000
(Get-Item tests/fixtures/generated/large-test.csv).Length
```

The default should exceed 50 MB. If it does not on your runtime, increase `--rows` until the reported size is at least 50 MB. Start the app with `npm run dev`, open it in a current desktop browser, and select `large-test.csv`.

Check that the upload enters large-file mode, row progress advances while CSV chunks are inserted into DuckDB-WASM, and the browser remains interactive. After parsing, run Smart Clean and accept a risky proposal. Confirm the dry-run counts and samples, then apply it and check the review log and preview. Exercise Undo, Redo, and Reset to original; compare row counts and preview values with the original. Cancel a long-running decision and verify that it reports cancellation without applying a partial result.

For the export path, choose CSV or JSON Lines, then select **Download all (.zip)**. Check that the archive contains the cleaned file, `changes.csv`, `cleaning-report.md`, and `recipe.json`. Confirm that row progress advances while the app remains interactive. Cancel a second bundle during generation and verify that the save is aborted (or no Blob download starts). On browsers without `showSaveFilePicker`, check the memory warning and confirm the final Blob downloads only after the worker finishes. Bundles above 4 GB are unsupported; download their artifacts individually.

## Verification run (2026-10-15)

Measurements were taken on this development machine with Node.js and the repository's local dependencies. The 98 MB file was generated with the command above and then streamed through PapaParse's Node stream parser. The scale test used DuckDB-WASM's Node blocking binding.

| Workload | Elapsed | Peak process RSS | Result |
| --- | ---: | ---: | --- |
| Generate 500,000-row CSV (98,151,851 bytes / 93.6 MiB) | 1.25 s | 81.2 MiB | Completed |
| PapaParse stream parse of that CSV | 1.18 s | 58.3 MiB (61,100,032 bytes) | 500,000 rows; 0 ragged rows |
| DuckDB-WASM combined 1,000-column × 100,000-row clean/review/undo test (latest clean run, 2026-10-26) | 40.48 s | 77.2 MiB (80,949,248 bytes) | 5 risky SQL decisions; protected column unchanged; original restored exactly |
| DuckDB-WASM 100,000-row estimate path using validated ridge regression (latest clean run, 2026-10-26) | 1.61 s | 77.1 MiB (80,814,080 bytes) | 5,000 missing cells predicted in 2,000-row batches; 5,000-row training sample; source nulls retained |
| DuckDB-WASM 1M-row ZIP bundle stream (latest clean run, 2026-10-26) | 4.19 s | 77.2 MiB (80,916,480 bytes) | 14,778,373 archive bytes; 212 chunks; maximum chunk 75,000 bytes |
| Peak RSS across the three isolated scale processes | — | 77.2 MiB (80,949,248 bytes) | ZIP chunks were consumed/discarded like streamed writes; archive was not retained in memory |

The scale fixture includes messy whitespace/missing tokens, currency text, mixed dates, duplicate keys, outliers, and a protected field in its text columns; its other 994 columns are compact numeric expressions. `npm run test:scale` runs each scenario in an isolated Vitest process. This avoids Vitest's internal task-update timeout around the 40-second synchronous DuckDB scenario. All three scenarios passed with exit code 0 in the latest run. The scale test exercises the production low-risk SQL expressions, risky SQL builder, DuckDB execution, version-view reset path, and the same DuckDB bundle session used by the worker. The 1M-row stream test discards each emitted chunk instead of building a full ZIP in memory. It does not instantiate the browser parse/clean workers, run the browser profiling implementation, or replay an uploaded CSV through the full app.

The parser timing is not a browser upload/clean timing: it measures PapaParse streaming only and excludes DuckDB insertion and profiling. A real-browser test was attempted on 2026-10-26, but the browser could not reach the local Vite server (`ERR_CONNECTION_TIMED_OUT`); the sandbox also denied loopback socket access. Therefore the 98 MB fixture was not uploaded in a browser, and no browser memory or UI responsiveness measurement is available. The previous mocked-worker responsiveness test was removed. UI-thread responsiveness, actual ZIP file-picker writes/cancellation, and progress on a real 50 MB+ browser upload remain unverified. Run the manual steps above in the target browser/device and record its device/browser, elapsed time, and memory reading before treating those as measured.
