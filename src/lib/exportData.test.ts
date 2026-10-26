import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parseCsvText } from '../parsers/csv'
import { profileDataset } from '../profiler/profile'
import { executeRiskyDecision } from '../engine/riskyDecisions'
import { runSmartClean } from '../engine/smartClean'
import { globalLibraryFixture, trainFixture } from '../../tests/fixtures/smartCleanRegression'
import { createChangesCsv, createRemovedRowsForExport, getChangedCells, serializeCsv, serializeJson, serializeXlsx, verifyExport, type ExportColumn } from './exportData'
import { createStoredZip, StreamingStoredZipWriter } from './zip'
import type { DataRow } from '../types'

function readStoredZip(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()
  const end = bytes.length - 22
  if (view.getUint32(end, true) !== 0x06054b50) throw new Error('Missing ZIP end record.')
  const count = view.getUint16(end + 10, true)
  let cursor = view.getUint32(end + 16, true)
  const entries: Record<string, string> = {}
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error('Invalid ZIP directory entry.')
    const size = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const name = decoder.decode(bytes.slice(cursor + 46, cursor + 46 + nameLength))
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    entries[name] = decoder.decode(bytes.slice(dataStart, dataStart + size))
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

describe('cleaned data exports', () => {
  it('escapes Unicode, commas, quotes, and newlines, preserving empty string vs JSON null', () => {
    const rows: DataRow[] = [{ text: 'comma, quote " and\nline 😀 café', empty: '', missing: null }]
    const columns: ExportColumn[] = [{ source: 'text', name: 'text' }, { source: 'empty', name: 'empty' }, { source: 'missing', name: 'missing' }]
    const csv = serializeCsv(rows, columns)
    const csvRoundTrip = parseCsvText(csv).rows[0]!
    expect(csvRoundTrip.text).toBe(rows[0]!.text)
    expect(csvRoundTrip.empty).toBe('')
    expect(csvRoundTrip.missing).toBe('')
    const json = JSON.parse(serializeJson(rows, columns)) as DataRow[]
    expect(json[0]).toEqual(rows[0])
    expect(verifyExport(serializeJson(rows, columns), 'json', rows, columns).pass).toBe(true)
  })

  it('writes numeric XLSX cells and dates as Excel date cells', () => {
    const rows: DataRow[] = [{ amount: 1234.5, date: '2024-02-03' }]
    const columns: ExportColumn[] = [{ source: 'amount', name: 'amount', type: 'float' }, { source: 'date', name: 'date', type: 'date' }]
    const bytes = serializeXlsx(rows, columns)
    const book = XLSX.read(bytes, { type: 'array', cellDates: true })
    const sheet = book.Sheets[book.SheetNames[0]!]!
    expect(sheet.A2).toMatchObject({ t: 'n', v: 1234.5 })
    expect(sheet.B2?.t).toBe('d')
    expect(sheet.B2?.v).toBeInstanceOf(Date)
    expect(verifyExport(bytes, 'xlsx', rows, columns)).toMatchObject({ pass: true, mismatches: [] })
  })

  it('aligns changed cells by stable row IDs after row removal and column renaming', () => {
    const original: DataRow[] = [
      { __dc_internal_row_order: 0, 'Old Name': 'same' },
      { __dc_internal_row_order: 1, 'Old Name': 'removed' },
      { __dc_internal_row_order: 2, 'Old Name': 'before' },
    ]
    const cleaned: DataRow[] = [
      { __dc_internal_row_order: 0, new_name: 'same' },
      { __dc_internal_row_order: 2, new_name: 'after' },
    ]
    const changes = getChangedCells(original, cleaned, [{ source: 'new_name', originalSource: 'Old Name', name: 'new_name' }], {}, '__dc_internal_row_order', { new_name: 3 })
    expect(changes).toEqual([{ row_id: 3, column: 'new_name', before: 'before', after: 'after', rule: 'cleaning rule', step: 3 }])
  })

  it('writes every in-memory changed cell with its mapped rule and step into the bundle changes CSV', () => {
    const original: DataRow[] = [
      { __dc_internal_row_order: 0, OldX: 'A', y: 'B' },
      { __dc_internal_row_order: 1, OldX: 'C', y: 'D' },
      { __dc_internal_row_order: 2, OldX: 'removed', y: 'row' },
    ]
    const cleaned: DataRow[] = [
      { __dc_internal_row_order: 0, x: 'A!', y: 'B!' },
      { __dc_internal_row_order: 1, x: 'C!', y: 'D' },
    ]
    const columns: ExportColumn[] = [
      { source: 'x', originalSource: 'OldX', name: 'x' },
      { source: 'y', name: 'y' },
    ]
    const changes = parseCsvText(createChangesCsv(original, cleaned, columns, { x: 'Trim whitespace', y: 'Formatted numbers' }, '__dc_internal_row_order', { x: 2, y: 3 })).rows
    expect(changes).toEqual([
      { row_id: '1', column: 'x', before: 'A', after: 'A!', rule: 'Trim whitespace', step: '2' },
      { row_id: '1', column: 'y', before: 'B', after: 'B!', rule: 'Formatted numbers', step: '3' },
      { row_id: '2', column: 'x', before: 'C', after: 'C!', rule: 'Trim whitespace', step: '2' },
    ])
  })

  it('exports only removed rows and records the rule that removed each stable row ID', () => {
    const original: DataRow[] = [
      { __dc_internal_row_order: 0, item: 'keep' },
      { __dc_internal_row_order: 1, item: 'duplicate, with comma' },
      { __dc_internal_row_order: 2, item: 'keep too' },
    ]
    const result = createRemovedRowsForExport(original, '__dc_internal_row_order', [{ rowIds: [1], rule: 'remove-duplicates' }], ['item'])
    expect(result.rows).toHaveLength(1)
    expect(parseCsvText(serializeCsv(result.rows, result.columns)).rows).toEqual([{ row_id: '2', removal_rule: 'remove-duplicates', item: 'duplicate, with comma' }])
  })

  it('round trips the Global Library-shaped fixture after Smart Clean', () => {
    const { rows, columns } = globalLibraryFixture()
    const cleaned = runSmartClean(rows, profileDataset(rows, columns), [])
    const outputColumns = Object.keys(cleaned.rows[0] ?? {}).map((name) => ({ source: name, name, type: profileDataset(cleaned.rows, Object.keys(cleaned.rows[0] ?? {})).columns.find((column) => column.name === name)?.inferredType }))
    const csv = serializeCsv(cleaned.rows, outputColumns)
    const parsed = parseCsvText(csv)
    const cleanedProfile = profileDataset(cleaned.rows, Object.keys(cleaned.rows[0] ?? {}))
    const importedProfile = profileDataset(parsed.rows, parsed.columns)
    expect(parsed.rows).toHaveLength(219)
    expect(parsed.columns).toHaveLength(7)
    expect(parsed.columns).toContain('country')
    expect(parsed.rows[0]?.country).toBe('Country 0')
    expect(typeof parsed.rows[0]?.expenditures).toBe('string')
    expect(importedProfile.columns.some((column) => column.uniqueCount > 1)).toBe(true)
    const cleanIssues = new Map(cleanedProfile.columns.map((column) => [column.name, new Set(column.issues.map((issue) => issue.code))]))
    for (const column of importedProfile.columns) for (const issue of column.issues) expect(cleanIssues.get(column.name)?.has(issue.code)).toBe(true)
    expect(importedProfile.columns.find((column) => column.name === 'expenditures')?.inferredType).toMatch(/integer|float/)
    expect(cleaned.groups.filter((group) => group.ruleId === 'remove-empty-rows').reduce((sum, group) => sum + (group.rowsRemoved ?? 0), 0)).toBe(0)
    expect(cleaned.rows.some((row) => Object.values(row).some((value) => value === null))).toBe(true)
    const cleanedColumns = profileDataset(cleaned.rows, Object.keys(cleaned.rows[0] ?? {}), new Map(Object.entries(cleaned.stableColumnIds ?? {}))).columns
    const compareColumns: ExportColumn[] = cleanedColumns.map((column) => ({ source: column.name, originalSource: profileDataset(rows, columns).columns.find((before) => before.id === column.id)?.name, name: column.name }))
    expect(getChangedCells(rows, cleaned.rows, compareColumns).length).toBe(cleaned.changeLog.reduce((sum, entry) => sum + (entry.cellsChanged ?? 0), 0))
  })

  it('treats null-to-empty and text-to-number as changed cells', () => {
    const original: DataRow[] = [{ blank: null, amount: '12' }]
    const cleaned: DataRow[] = [{ blank: '', amount: 12 }]
    const changes = getChangedCells(original, cleaned, [{ source: 'blank', name: 'blank' }, { source: 'amount', name: 'amount' }])
    expect(changes.map(({ column }) => column)).toEqual(['blank', 'amount'])
  })

  it('round trips train.csv with 119 rows, then 102 after accepting its duplicate proposal', () => {
    const { rows, columns } = trainFixture()
    const cleaned = runSmartClean(rows, profileDataset(rows, columns), [])
    expect(cleaned.rows).toHaveLength(119)
    const duplicates = executeRiskyDecision(cleaned.rows, { kind: 'remove-duplicates', columns, options: { keys: [], keep: 'first' } }, []).rows
    expect(duplicates).toHaveLength(102)
    const exportColumns = Object.keys(duplicates[0] ?? {}).map((name) => ({ source: name, name }))
    expect(parseCsvText(serializeCsv(duplicates, exportColumns)).rows).toHaveLength(102)
  })

  it('builds a valid stored ZIP container for download-all entries', () => {
    const bytes = createStoredZip([{ name: 'cleaned.csv', data: 'a\r\n1' }, { name: 'report.md', data: '# Report' }])
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
    expect(new TextDecoder().decode(bytes)).toContain('cleaned.csv')
    expect(new TextDecoder().decode(bytes)).toContain('report.md')
  })

  it('writes a ZIP archive incrementally with valid data descriptors and directory entries', () => {
    const zip = new StreamingStoredZipWriter()
    const output: Uint8Array[] = []
    output.push(zip.beginEntry('cleaned.csv'))
    output.push(zip.write('hello '))
    output.push(zip.write('world'))
    output.push(zip.endEntry())
    output.push(zip.beginEntry('recipe.json'))
    output.push(zip.write('{"ok":true}'))
    output.push(zip.endEntry())
    output.push(zip.finish())
    const bytes = new Uint8Array(output.reduce((sum, part) => sum + part.length, 0))
    let offset = 0
    for (const part of output) { bytes.set(part, offset); offset += part.length }
    const view = new DataView(bytes.buffer)
    expect(view.getUint32(0, true)).toBe(0x04034b50)
    expect(view.getUint16(6, true)).toBe(0x0808)
    const firstHeaderLength = 30 + view.getUint16(26, true)
    expect(new TextDecoder().decode(bytes.slice(30, firstHeaderLength))).toBe('cleaned.csv')
    const descriptor = firstHeaderLength + 'hello world'.length
    expect(view.getUint32(descriptor, true)).toBe(0x08074b50)
    expect(view.getUint32(descriptor + 4, true)).toBe(0x0d4a1185)
    expect(view.getUint32(descriptor + 8, true)).toBe(11)
    expect(new TextDecoder().decode(bytes)).toContain('recipe.json')
    expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50)
    expect(readStoredZip(bytes)).toEqual({ 'cleaned.csv': 'hello world', 'recipe.json': '{"ok":true}' })
  })
})
