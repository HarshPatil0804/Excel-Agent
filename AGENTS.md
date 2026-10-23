# DataCleaner project guidance

## Product constraints
- This is a static, browser-only data cleaning platform. Never add a backend, server-side processing, telemetry, analytics that transmit data, or a network call that carries user data.
- Uploaded content must remain in browser memory or IndexedDB. Future parsing and cleaning work belongs in Web Workers and DuckDB-WASM where appropriate.
- Cleaning rules must be deterministic code. Any future AI may suggest rules but must not apply them automatically.
- Current phase: local upload, parsing, profiling, deterministic cleaning, grouped review, and local recipe support are in scope.
- Validate extensions only; never reject a file by size. Large CSV/TSV processing must use worker streaming and local DuckDB-WASM batches. Do not move file processing onto the UI thread.
- Keep original rows immutable. Run parsing/profiling in workers and validate profile results with Zod.
- Every cleaning rule uses a scope model and global protected columns are never modified. Prefer worker batches and dataset-wide operations; never require per-column approval for automatic low-risk rules.
- Smart Clean automatically applies deterministic low-risk rules and only proposes risky rules for a single dataset-wide decision. AI, if added later, may suggest but never apply rules.
- Recipes are local JSON data stored in IndexedDB; never transmit them or dataset contents.

## Structure
- `src/app`: application shell, routes, layouts, providers.
- `src/components`: reusable UI and feature-specific components.
- `src/parsers`, `src/profiler`, `src/cleaners`, `src/engine`, `src/workers`: data pipeline modules.
- `src/store`: Zustand state; `src/lib`: shared utilities; `src/styles`: design tokens and global styles; `src/types`: shared types.
- `tests/fixtures`: small, non-sensitive sample files. `docs`: product and developer documentation.

## Standards
- TypeScript strict mode; keep functions small and typed. Prefer accessible semantic HTML and visible keyboard focus.
- Keep styles aligned with the CSS-variable theme and Tailwind tokens. Avoid external services and remote assets.
- Keep pure cleaning rules isolated, deterministic, and independently testable.
- Each phase must pass lint, typecheck, and tests before commit.
