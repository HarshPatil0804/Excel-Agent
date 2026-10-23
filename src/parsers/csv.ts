import Papa from 'papaparse'
import type { DataRow, DataValue } from '../types'

export interface TextEncodingResult { encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'latin-1'; text: string }
export interface CsvParseResult { rows: DataRow[]; columns: string[]; delimiter: string; raggedRows: number; encoding: TextEncodingResult['encoding'] }

export function decodeTextBuffer(buffer: ArrayBuffer): TextEncodingResult {
  const bytes = new Uint8Array(buffer)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: 'utf-16le', text: new TextDecoder('utf-16le').decode(bytes.subarray(2)) }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: 'utf-16be', text: new TextDecoder('utf-16be').decode(bytes.subarray(2)) }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { encoding: 'utf-8', text: new TextDecoder('utf-8').decode(bytes.subarray(3)) }
  try { return { encoding: 'utf-8', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) } }
  catch { return { encoding: 'latin-1', text: new TextDecoder('iso-8859-1').decode(bytes) } }
}

const normalizedValue = (value: unknown): DataValue => value === undefined || value === null ? null : String(value)
const safeHeaders = (headers: string[]): string[] => headers.map((header, index) => header.trim() || `Column ${index + 1}`)

export function parseCsvText(text: string, encoding: TextEncodingResult['encoding'] = 'utf-8'): CsvParseResult {
  const result = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), {
    header: false,
    skipEmptyLines: false,
    delimiter: '',
    delimitersToGuess: [',', '\t', ';', '|'],
  })
  if (result.errors.some((error) => error.code === 'MissingQuotes')) throw new Error('This CSV has an unfinished quoted field. Check the file and try again.')
  const records = result.data.filter((record, index) => !(index === result.data.length - 1 && record.length === 1 && record[0] === ''))
  if (!records.length || records.every((record) => record.every((field) => !field.trim()))) throw new Error('This file is empty or contains no data rows.')
  const columns = safeHeaders(records[0] ?? [])
  if (!columns.length) throw new Error('We could not find a header row in this file.')
  let raggedRows = 0
  const rows = records.slice(1).filter((record) => !(record.length === 1 && record[0] === '')).map((record) => {
    if (record.length !== columns.length) raggedRows += 1
    const row: DataRow = {}
    columns.forEach((column, index) => { row[column] = normalizedValue(record[index]) })
    return row
  })
  if (!rows.length) throw new Error('This file has a header row but no data rows.')
  return { rows, columns, delimiter: result.meta.delimiter || ',', raggedRows, encoding }
}
