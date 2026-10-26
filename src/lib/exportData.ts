import * as XLSX from 'xlsx'
import { parseCsvText } from '../parsers/csv'
import { parseJsonText } from '../parsers/json'
import type { ColumnProfile, DataRow, DataValue } from '../types'

export type ExportFormat = 'csv' | 'xlsx' | 'json'
export interface ExportColumn { source: string; name: string; originalSource?: string; type?: ColumnProfile['inferredType'] }

export function createRemovedRowsForExport(originalRows: DataRow[], rowOrderKey: string | undefined, removals: Array<{ rowIds: number[]; rule: string }>, originalColumns: string[]): { rows: DataRow[]; columns: ExportColumn[] } {
  const ruleById = new Map<number, string>()
  removals.forEach(({ rowIds, rule }) => rowIds.forEach((id) => ruleById.set(id, rule)))
  const rowIdSource = uniqueExportKey('__dc_export_row_id', originalColumns)
  const ruleSource = uniqueExportKey('__dc_export_removal_rule', [...originalColumns, rowIdSource])
  const rowIdHeader = uniqueExportHeader('row_id', originalColumns)
  const ruleHeader = uniqueExportHeader('removal_rule', [...originalColumns, rowIdHeader])
  const rows = originalRows.flatMap((row, index) => {
    const id = typeof rowOrderKey === 'string' && typeof row[rowOrderKey] === 'number' ? row[rowOrderKey] as number : index
    const rule = ruleById.get(id)
    return rule === undefined ? [] : [{ ...row, [rowIdSource]: id + 1, [ruleSource]: rule }]
  })
  return { rows, columns: [{ source: rowIdSource, name: rowIdHeader }, { source: ruleSource, name: ruleHeader }, ...originalColumns.map((name) => ({ source: name, name }))] }
}

function uniqueExportKey(base: string, columns: string[]): string {
  let key = base
  let suffix = 2
  while (columns.includes(key)) key = `${base}_${suffix++}`
  return key
}

function uniqueExportHeader(base: string, columns: string[]): string {
  let name = base
  let suffix = 2
  while (columns.includes(name)) name = `${base}_removed_${suffix++}`
  return name
}

const safeValue = (value: unknown): DataValue => {
  if (value == null || value === 'null' || value === 'undefined' || value === 'None' || value === 'NaN') return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : String(value)
}

export function csvEscape(value: unknown): string {
  const safe = safeValue(value)
  if (safe === null) return ''
  const text = String(safe)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function formatExportValue(value: unknown, type?: ColumnProfile['inferredType']): DataValue {
  const safe = safeValue(value)
  if ((type === 'date' || type === 'datetime') && typeof safe === 'string') {
    const date = new Date(safe)
    if (!Number.isNaN(date.getTime())) return type === 'date' ? date.toISOString().slice(0, 10) : date.toISOString()
  }
  return safe
}

export function serializeCsv(rows: DataRow[], columns: ExportColumn[], bom = false): string {
  const lines = [columns.map((column) => csvEscape(column.name)).join(',')]
  for (const row of rows) lines.push(columns.map((column) => csvEscape(formatExportValue(row[column.source], column.type))).join(','))
  return `${bom ? '\uFEFF' : ''}${lines.join('\r\n')}`
}

export function serializeJson(rows: DataRow[], columns: ExportColumn[]): string {
  return JSON.stringify(rows.map((row) => Object.fromEntries(columns.map((column) => [column.name, formatExportValue(row[column.source], column.type)]))), null, 2)
}

export function serializeJsonLines(rows: DataRow[], columns: ExportColumn[]): string {
  return rows.map((row) => JSON.stringify(Object.fromEntries(columns.map((column) => [column.name, safeValue(row[column.source])])))).join('\n') + (rows.length ? '\n' : '')
}

export function serializeXlsx(rows: DataRow[], columns: ExportColumn[]): ArrayBuffer {
  const sheet = XLSX.utils.aoa_to_sheet([columns.map((column) => column.name)])
  rows.forEach((row, rowIndex) => columns.forEach((column, columnIndex) => {
    const value = formatExportValue(row[column.source], column.type)
    if (value === null || value === '') return
    const cellAddress = XLSX.utils.encode_cell({ r: rowIndex + 1, c: columnIndex })
    if ((column.type === 'date' || column.type === 'datetime') && typeof value === 'string') {
      const date = new Date(value)
      if (!Number.isNaN(date.getTime())) {
        sheet[cellAddress] = { t: 'd', v: date, z: column.type === 'date' ? 'yyyy-mm-dd' : 'yyyy-mm-dd hh:mm:ss' }
        return
      }
    }
    sheet[cellAddress] = { t: typeof value === 'number' ? 'n' : typeof value === 'boolean' ? 'b' : 's', v: value, ...(typeof value === 'number' ? { z: column.type === 'integer' ? '0' : '0.##########' } : {}) }
  }))
  sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: Math.max(columns.length - 1, 0) } })
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Cleaned data')
  return XLSX.write(book, { type: 'array', bookType: 'xlsx', cellDates: true }) as ArrayBuffer
}

export interface ExportVerification { pass: boolean; mismatches: string[]; rows: number; columns: number }

export function verifyExport(bytes: string | ArrayBuffer, format: ExportFormat, expectedRows: DataRow[], columns: ExportColumn[]): ExportVerification {
  let actualRows: DataRow[] = []
  let actualColumns: string[] = []
  try {
    if (format === 'csv') {
      const parsed = parseCsvText(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes))
      actualRows = parsed.rows; actualColumns = parsed.columns
    } else if (format === 'json') {
      const parsed = parseJsonText(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes))
      actualRows = parsed.rows; actualColumns = parsed.columns
    } else {
      const book = XLSX.read(bytes, { type: typeof bytes === 'string' ? 'string' : 'array', cellDates: true, raw: true })
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[book.SheetNames[0]!]!, { header: 1, raw: true, defval: null })
      actualColumns = (matrix[0] ?? []).map(String)
      actualRows = matrix.slice(1).map((values) => Object.fromEntries(actualColumns.map((name, index) => [name, safeValue(values[index])])) as DataRow)
    }
  } catch (error) {
    return { pass: false, mismatches: [`Could not re-parse generated file: ${error instanceof Error ? error.message : String(error)}`], rows: 0, columns: 0 }
  }
  const mismatches: string[] = []
  const expectedNames = columns.map((column) => column.name)
  if (actualRows.length !== expectedRows.length) mismatches.push(`Row count: expected ${expectedRows.length}, got ${actualRows.length}.`)
  if (JSON.stringify(actualColumns) !== JSON.stringify(expectedNames)) mismatches.push(`Column names differ: expected ${expectedNames.join(', ')}, got ${actualColumns.join(', ')}.`)
  const sampleIndices = [...new Set([0, Math.floor(expectedRows.length / 2), expectedRows.length - 1])].filter((index) => index >= 0)
  for (const rowIndex of sampleIndices) for (const column of columns) {
    const expected = safeValue(expectedRows[rowIndex]?.[column.source])
    const actual = safeValue(actualRows[rowIndex]?.[column.name])
    const comparable = (value: DataValue) => column.type === 'date' || column.type === 'datetime'
      ? typeof value === 'string' ? value.slice(0, column.type === 'date' ? 10 : 19).replace(' ', 'T') : String(value ?? '')
      : value
    if (format === 'json' ? expected !== actual : String(comparable(expected) ?? '') !== String(comparable(actual) ?? '')) {
      mismatches.push(`Row ${rowIndex + 1}, “${column.name}”: expected ${String(expected)}, got ${String(actual)}.`)
      if (mismatches.length >= 20) break
    }
  }
  for (const column of columns) {
    const isNullCell = (value: unknown) => safeValue(value) === null || (format !== 'json' && safeValue(value) === '')
    const expectedNulls = expectedRows.filter((row) => isNullCell(row[column.source])).length
    const actualNulls = actualRows.filter((row) => isNullCell(row[column.name])).length
    if (expectedNulls !== actualNulls) mismatches.push(`Null count for “${column.name}”: expected ${expectedNulls}, got ${actualNulls}.`)
  }
  return { pass: mismatches.length === 0, mismatches, rows: actualRows.length, columns: actualColumns.length }
}

export interface ChangedCell { row_id: number; column: string; before: DataValue; after: DataValue; rule: string; step: number }
export function getChangedCells(original: DataRow[], cleaned: DataRow[], columns: ExportColumn[], ruleByColumn: Record<string, string> = {}, rowOrderKey?: string, stepByColumn: Record<string, number> = {}): ChangedCell[] {
  const result: ChangedCell[] = []
  const originalId = (row: DataRow, index: number): number => typeof rowOrderKey === 'string' && typeof row[rowOrderKey] === 'number' ? row[rowOrderKey] as number : index
  const cleanedById = new Map(cleaned.map((row, index) => [originalId(row, index), row]))
  for (let index = 0; index < original.length; index += 1) {
    const beforeRow = original[index]!
    const afterRow = cleanedById.get(originalId(beforeRow, index))
    if (!afterRow) continue // Removed rows are reported separately from cell edits.
    for (const column of columns) {
      const before = safeValue(beforeRow[column.originalSource ?? column.source])
      const after = safeValue(afterRow[column.source])
      const beforeRaw = beforeRow[column.originalSource ?? column.source]
      const afterRaw = afterRow[column.source]
      if (!Object.is(beforeRaw, afterRaw)) result.push({ row_id: originalId(beforeRow, index) + 1, column: column.name, before, after, rule: ruleByColumn[column.source] ?? 'cleaning rule', step: stepByColumn[column.source] ?? 1 })
    }
  }
  return result
}

export function serializeChangesCsv(changes: ChangedCell[]): string {
  return serializeCsv(changes.map((change) => ({ row_id: change.row_id, column: change.column, before: change.before, after: change.after, rule: change.rule, step: change.step })), [
    { source: 'row_id', name: 'row_id' }, { source: 'column', name: 'column' }, { source: 'before', name: 'before' }, { source: 'after', name: 'after' }, { source: 'rule', name: 'rule' }, { source: 'step', name: 'step' },
  ])
}

export function createChangesCsv(original: DataRow[], cleaned: DataRow[], columns: ExportColumn[], ruleByColumn: Record<string, string> = {}, rowOrderKey?: string, stepByColumn: Record<string, number> = {}): string {
  return serializeChangesCsv(getChangedCells(original, cleaned, columns, ruleByColumn, rowOrderKey, stepByColumn))
}
