declare module '@duckdb/duckdb-wasm/dist/duckdb-node-blocking' {
  export interface DuckDBResultRow { toJSON(): Record<string, unknown> }
  export interface DuckDBResult { toArray(): DuckDBResultRow[] }
  export interface DuckDBConnection {
    query(sql: string): DuckDBResult
    close(): void
  }
  export interface DuckDBDatabase {
    instantiate(): Promise<unknown>
    open(config: Record<string, unknown>): void
    connect(): DuckDBConnection
    reset(): void
  }
  export class VoidLogger {}
  export const NODE_RUNTIME: unknown
  export function createDuckDB(bundles: { mvp: { mainModule: string; mainWorker: string } }, logger: VoidLogger, runtime: unknown): Promise<DuckDBDatabase>
}
