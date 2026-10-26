import * as XLSX from 'xlsx'
import type { DataRow, DataValue } from '../types'

export interface WorksheetPreview { row: number; values: string[] }
export interface WorksheetInspection { headerRow: number; previewRows: WorksheetPreview[] }
export interface WorksheetParseResult { rows: DataRow[]; columns: string[]; raggedRows: number; excelDateRows: Record<string, number[]> }

export function inspectWorksheet(sheet: XLSX.WorkSheet): WorksheetInspection {
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false, blankrows: true })
  const firstHeader = grid.findIndex((row) => row.some((cell) => cell !== null && cell !== undefined && String(cell).trim() !== ''))
  if (firstHeader < 0) throw new Error('No non-empty header row was found in this sheet.')
  return { headerRow: firstHeader + 1, previewRows: grid.slice(0, 100).map((row, index) => ({ row: index + 1, values: row.map((value) => value == null ? '' : String(value)) })) }
}

export function parseWorksheet(sheet: XLSX.WorkSheet, headerRow: number): WorksheetParseResult {
  const values = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true, blankrows: true })
  const headerIndex = headerRow - 1
  const header = values[headerIndex]
  if (!header || !header.some((cell) => cell !== null && String(cell).trim())) throw new Error('Pick a row with column names as the header row.')
  const columns = header.map((cell, index) => String(cell ?? '').trim() || `Column ${index + 1}`)
  const rows: DataRow[] = []
  const excelDateRows: Record<string, number[]> = Object.fromEntries(columns.map((column) => [column, []]))
  let raggedRows = 0
  for (const valuesRow of values.slice(headerIndex + 1)) {
    if (!valuesRow.some((cell) => cell !== null && cell !== undefined && String(cell).trim() !== '')) continue
    if (valuesRow.length !== columns.length) raggedRows += 1
    const row: DataRow = {}
    columns.forEach((column, index) => {
      const value = valuesRow[index]
      if (value instanceof Date) excelDateRows[column]!.push(rows.length)
      row[column] = value === undefined || value === null ? null : value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : value as DataValue
    })
    rows.push(row)
  }
  if (!rows.length) throw new Error('This worksheet has a header row but no data rows.')
  return { rows, columns, raggedRows, excelDateRows }
}
