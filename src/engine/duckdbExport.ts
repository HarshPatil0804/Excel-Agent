import type { InferredType } from '../types'

export interface TypedExportColumn { source: string; type?: InferredType }

const id = (value: string): string => `"${value.replaceAll('"', '""')}"`

/** Cast profiled DuckDB VARCHAR cells back to JSON scalar types during chunked export. */
export function buildDuckDbJsonExportProjection(columns: TypedExportColumn[]): string {
  return columns.map(({ source, type }) => {
    const column = id(source)
    const cast = type === 'integer' ? `TRY_CAST(${column} AS DOUBLE)`
      : type === 'float' ? `TRY_CAST(${column} AS DOUBLE)`
        : type === 'boolean' ? `TRY_CAST(${column} AS BOOLEAN)`
          : type === 'date' ? `TRY_CAST(${column} AS DATE)`
            : type === 'datetime' ? `TRY_CAST(${column} AS TIMESTAMP)`
              : column
    return `${cast} AS ${column}`
  }).join(', ')
}

export function normalizeDuckDbJsonValue(value: unknown): string | number | boolean | null {
  if (value == null || value === 'null' || value === 'undefined' || value === 'None' || value === 'NaN') return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  return typeof value === 'string' || typeof value === 'boolean' ? value : String(value)
}
