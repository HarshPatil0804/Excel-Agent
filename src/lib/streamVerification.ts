import type { DataRow } from '../types'
import { normalizeDuckDbJsonValue } from '../engine/duckdbExport'

export interface VerifyColumn { source: string; name: string }

const comparable = (value: unknown): string => {
  if (value == null || value === 'null' || value === 'undefined' || value === 'None' || value === 'NaN') return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' && !Number.isFinite(value)) return ''
  return String(value)
}

export function compareCsvExportPage(actualRows: Array<Record<string, unknown>>, expectedRows: DataRow[], columns: VerifyColumn[], rowOffset: number): string[] {
  const mismatches: string[] = []
  if (actualRows.length !== expectedRows.length) return [`Parsed row page has ${actualRows.length} rows; DuckDB expected ${expectedRows.length}.`]
  for (let index = 0; index < actualRows.length; index += 1) {
    for (const column of columns) {
      const actual = comparable(actualRows[index]?.[column.name])
      const expected = comparable(expectedRows[index]?.[column.source])
      if (actual !== expected) {
        mismatches.push(`Row ${rowOffset + index + 1}, “${column.name}”: expected ${expected || 'empty'}, got ${actual || 'empty'}.`)
        if (mismatches.length >= 20) return mismatches
      }
    }
  }
  return mismatches
}

export function compareJsonlExportPage(actualRows: Array<Record<string, unknown>>, expectedRows: DataRow[], columns: Array<VerifyColumn & { type?: import('../types').InferredType }>, rowOffset: number): string[] {
  const mismatches: string[] = []
  if (actualRows.length !== expectedRows.length) return [`Parsed row page has ${actualRows.length} rows; DuckDB expected ${expectedRows.length}.`]
  for (let index = 0; index < actualRows.length; index += 1) {
    for (const column of columns) {
      const actual = actualRows[index]?.[column.name] ?? null
      const expected = normalizeDuckDbJsonValue(expectedRows[index]?.[column.source])
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(`Row ${rowOffset + index + 1}, “${column.name}”: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`)
        if (mismatches.length >= 20) return mismatches
      }
    }
  }
  return mismatches
}

