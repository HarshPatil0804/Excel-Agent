import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as XLSX from 'xlsx'
import { decodeTextBuffer, parseCsvText } from './csv'
import { parseJsonText } from './json'
import { inspectWorksheet, parseWorksheet } from './xlsx'
import { generateCsvRows, takeFullBatches } from './batching'
import { profileColumn, profileDataset, profileResultSchema, inferColumnType } from '../profiler/profile'
import messyCsv from '../../tests/fixtures/messy-profile.csv?raw'
import nestedJson from '../../tests/fixtures/messy-nested.json?raw'
import tinyCsv from '../../tests/fixtures/tiny-kb.csv?raw'

describe('CSV and JSON parsing', () => {
  it('auto-detects semicolon and tab delimiters and preserves quoted newlines', () => {
    const semicolon = parseCsvText('name;note\nAda;"first line\nsecond line"')
    const tab = parseCsvText('name\tamount\nAda\t12')
    expect(semicolon.delimiter).toBe(';')
    expect(semicolon.rows[0]?.note).toBe('first line\nsecond line')
    expect(tab.delimiter).toBe('\t')
    expect(tab.rows[0]?.amount).toBe('12')
  })

  it('reports ragged rows and handles a BOM', () => {
    const parsed = parseCsvText('\uFEFFname,age\nAda,37\nGrace')
    expect(parsed.columns).toEqual(['name', 'age'])
    expect(parsed.rows[1]?.age).toBeNull()
    expect(parsed.raggedRows).toBe(1)
  })

  it('detects UTF-8, UTF-16, and Latin-1 buffers', () => {
    const utf8 = new TextEncoder().encode('name\nAndré').buffer
    const utf16 = Uint8Array.from([0xff, 0xfe, 0x6e, 0x00, 0x61, 0x00, 0x6d, 0x00, 0x65, 0x00]).buffer
    const latin1 = Uint8Array.from([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x41, 0x6e, 0x64, 0x72, 0xe9]).buffer
    expect(decodeTextBuffer(utf8).encoding).toBe('utf-8')
    expect(decodeTextBuffer(utf16).encoding).toBe('utf-16le')
    expect(decodeTextBuffer(latin1).text).toContain('André')
    expect(decodeTextBuffer(latin1).encoding).toBe('latin-1')
  })

  it('reads the local UTF-16 and Latin-1 fixtures and parses the Excel fixture', () => {
    const fixtureBuffer = (name: string): ArrayBuffer => {
      const bytes = readFileSync(resolve(process.cwd(), 'tests', 'fixtures', name))
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    }
    const utf16 = decodeTextBuffer(fixtureBuffer('utf16.csv'))
    const latin1 = decodeTextBuffer(fixtureBuffer('latin1.csv'))
    expect(utf16.encoding).toBe('utf-16le')
    expect(utf16.text).toContain('André')
    expect(latin1.encoding).toBe('latin-1')
    expect(latin1.text).toContain('Montréal')
    const workbook = XLSX.read(readFileSync(resolve(process.cwd(), 'tests', 'fixtures', 'messy.xlsx')), { type: 'buffer', cellDates: true })
    const sheet = workbook.Sheets[workbook.SheetNames[0]!]!
    const inspection = inspectWorksheet(sheet)
    const parsed = parseWorksheet(sheet, inspection.headerRow)
    expect(parsed.columns).toEqual(['name', 'age', 'email'])
    expect(parsed.rows).toHaveLength(3)
  })

  it('preserves true numeric cells and records coordinates of Excel date cells', () => {
    const workbook = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([['Order_Date', 'Revenue'], [null, 50000]])
    sheet.A2 = { t: 'd', v: new Date('2026-03-04T00:00:00.000Z'), z: 'dd/mm/yyyy' }
    XLSX.utils.book_append_sheet(workbook, sheet, 'Raw_Data')
    const parsed = parseWorksheet(sheet, 1)
    expect(parsed.rows[0]?.Order_Date).toBe('2026-03-04T00:00:00.000Z')
    expect(parsed.rows[0]?.Revenue).toBe(50000)
    expect(parsed.excelDateRows).toEqual({ Order_Date: [0], Revenue: [] })
  })

  it('flattens one level of nested objects and marks missing tokens', () => {
    const parsed = parseJsonText(nestedJson)
    expect(parsed.columns).toContain('contact.email')
    expect(parsed.rows[0]?.['contact.city']).toBe('London')
    expect(parsed.note).toMatch(/flattened one level/)
    const csv = parseCsvText(messyCsv)
    expect(csv.raggedRows).toBe(1)
    const profile = profileDataset(csv.rows, csv.columns)
    expect(profile.columns.find((column) => column.name === 'joined_on')?.invalidDateCount).toBe(1)
  })

  it('rejects empty, corrupt, or non-object JSON input with a clear error', () => {
    expect(() => parseCsvText('')).toThrow(/empty/i)
    expect(() => parseCsvText('name,note\nAda,"unfinished')).toThrow(/quoted field/i)
    expect(() => parseJsonText('{bad json')).toThrow(/invalid/i)
    expect(() => parseJsonText('[1,2]')).toThrow(/array of objects/i)
    expect(parseCsvText(tinyCsv).rows).toHaveLength(100)
  })
})

describe('column profiling', () => {
  it('infers integer, float, boolean, date, datetime, and categorical columns', () => {
    expect(inferColumnType(['1', '2'])).toBe('integer')
    expect(inferColumnType(['1.5', '2'])).toBe('float')
    expect(inferColumnType(['true', 'false'])).toBe('boolean')
    expect(inferColumnType(['2024-01-01', '2024-01-02'])).toBe('date')
    expect(inferColumnType(['2024-01-01T10:00:00Z', '2024-01-02T10:00:00Z'])).toBe('datetime')
    expect(inferColumnType(['red', 'blue', 'red'])).toBe('categorical')
  })

  it('detects missing values, duplicates, mixed types, and whitespace', () => {
    const profile = profileColumn('value', ['N/A', '-', '', null, 1, 'one', ' one '])
    expect(profile.nullCount).toBe(4)
    expect(profile.mixedTypeCount).toBeGreaterThan(0)
    expect(profile.leadingWhitespaceCount).toBe(1)
    expect(profile.trailingWhitespaceCount).toBe(1)
    expect(profile.issues.map((issue) => issue.code)).toContain('mixed-types')
    expect(profileColumn('name', ['a', 'a']).duplicateValueCount).toBe(1)
    expect(profileColumn('amount', [1, 2.5]).mixedTypeCount).toBe(0)
  })

  it('detects casing, invalid emails, phones, dates, and IQR outliers', () => {
    expect(profileColumn('city', ['Paris', 'PARIS']).inconsistentCasingCount).toBeGreaterThan(0)
    expect(profileColumn('email', ['good@example.com', 'invalid']).invalidEmailCount).toBe(1)
    expect(profileColumn('phone', ['+15551234567', '123']).invalidPhoneCount).toBe(1)
    expect(profileColumn('birth_date', ['2024-01-01', 'not-a-date']).invalidDateCount).toBe(1)
    expect(profileColumn('score', [1, 1, 1, 1, 100]).iqrOutlierCount).toBe(1)
  })

  it('returns a Zod-validated dataset summary with duplicate and empty-row counts', () => {
    const profile = profileDataset([{ id: 1, name: 'A' }, { id: 1, name: 'A' }, { id: null, name: null }])
    expect(profileResultSchema.parse(profile).summary.fullyDuplicateRows).toBe(1)
    expect(profile.summary.fullyEmptyRows).toBe(1)
    expect(profile.summary.rows).toBe(3)
  })
})

describe('large file batching', () => {
  it.each([100_000, 1_000_000])('generates and batches %s CSV rows without oversized inserts', (count) => {
    const pending: string[] = []
    let total = 0
    let largestBatch = 0
    for (const line of generateCsvRows(count)) {
      pending.push(line)
      for (const batch of takeFullBatches(pending, 50_000)) {
        total += batch.length
        largestBatch = Math.max(largestBatch, batch.length)
      }
    }
    total += pending.length
    expect(total).toBe(count + 1)
    expect(largestBatch).toBe(50_000)
    expect(pending.length).toBeLessThan(50_000)
  }, 15_000)

  it('rejects an invalid batch size', () => {
    expect(() => takeFullBatches([1, 2], 0)).toThrow(RangeError)
  })
})

