import type { DataRow, DataValue } from '../types'

const flattenOneLevel = (input: unknown): DataRow => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { value: input == null ? null : String(input) }
  const output: DataRow = {}
  for (const [key, value] of Object.entries(input)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value)) output[`${key}.${nestedKey}`] = normalize(nestedValue)
    } else output[key] = normalize(value)
  }
  return output
}

const normalize = (value: unknown): DataValue => {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return JSON.stringify(value)
}

export interface JsonParseResult { rows: DataRow[]; columns: string[]; note: string }

export function parseJsonText(text: string): JsonParseResult {
  let parsed: unknown
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')) }
  catch { throw new Error('This JSON file is invalid or incomplete.') }
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : []
  if (!list.length || list.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) throw new Error('JSON must contain an object or an array of objects.')
  const rows = list.map(flattenOneLevel)
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  if (!columns.length) throw new Error('The JSON objects do not contain any fields.')
  for (const row of rows) for (const column of columns) row[column] ??= null
  return { rows, columns, note: 'Nested objects are flattened one level; deeper values are kept as JSON text.' }
}
