import type { DataRow } from '../types'

export type DateOrder = 'day-first' | 'month-first' | 'ambiguous' | 'mixed' | 'none'
export interface DateOrderEvidence { order: DateOrder; textDateCount: number; firstPartOver12: number; secondPartOver12: number; message: string }
export interface DateNormalizationResult { rows: DataRow[]; order: DateOrderEvidence; converted: number; swapped: number; invalid: Array<{ rowIndex: number; original: string }>; ambiguous: number }

interface Parts { year: number; month: number; day: number }
const datePattern = /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})$/

function validParts({ year, month, day }: Parts): boolean {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function toIso(parts: Parts): string { return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}` }

function toParts(value: string, order: 'day-first' | 'month-first'): Parts | null {
  const match = value.trim().match(datePattern)
  if (!match) return null
  const first = Number(match[1]); const second = Number(match[2]); const third = Number(match[3])
  const parts = match[1]!.length === 4 ? { year: first, month: second, day: third }
    : order === 'day-first' ? { year: third, month: second, day: first } : { year: third, month: first, day: second }
  return validParts(parts) ? parts : null
}

function isIso(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) }

export function detectDateOrder(values: readonly unknown[]): DateOrderEvidence {
  let textDateCount = 0
  let firstPartOver12 = 0
  let secondPartOver12 = 0
  for (const raw of values) {
    if (typeof raw !== 'string' || isIso(raw)) continue
    const match = raw.trim().match(datePattern)
    if (!match || match[1]!.length === 4) continue
    textDateCount += 1
    if (Number(match[1]) > 12) firstPartOver12 += 1
    if (Number(match[2]) > 12) secondPartOver12 += 1
  }
  let order: DateOrder = 'none'
  if (firstPartOver12 > 0 && secondPartOver12 === 0) order = 'day-first'
  else if (secondPartOver12 > 0 && firstPartOver12 === 0) order = 'month-first'
  else if (firstPartOver12 > 0 && secondPartOver12 > 0) order = 'mixed'
  else if (textDateCount > 0) order = 'ambiguous'
  const message = order === 'day-first' ? `${firstPartOver12} text dates have day > 12, none have month > 12.`
    : order === 'month-first' ? `${secondPartOver12} text dates have month > 12, none have day > 12.`
      : order === 'mixed' ? `${firstPartOver12} text dates have first part > 12 and ${secondPartOver12} have second part > 12; the column has mixed date-order evidence.`
        : order === 'ambiguous' ? `${textDateCount} text dates have no day/month order evidence; choose the order before converting them.`
          : 'No slash, dot, or dash text dates were found to establish an order.'
  return { order, textDateCount, firstPartOver12, secondPartOver12, message }
}

export function normalizeDateColumn(rows: DataRow[], column: string, excelDateRows: readonly number[] = []): DateNormalizationResult {
  const evidence = detectDateOrder(rows.map((row) => row[column]))
  const excelRows = new Set(excelDateRows)
  let converted = 0
  let swappedCount = 0
  let ambiguous = 0
  const invalid: Array<{ rowIndex: number; original: string }> = []
  const nextRows = rows.map((row, rowIndex) => {
    const raw = row[column]
    if (typeof raw !== 'string' || !raw.trim()) return { ...row }
    const text = raw.trim()
    let normalized: string | null | undefined
    if (isIso(text)) {
      const match = text.match(datePattern)!
      const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
      normalized = validParts(parts) ? toIso(parts) : null
    } else {
      const match = text.match(datePattern)
      if (!match) return { ...row }
      if (match[1]!.length === 4) {
        const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
        normalized = validParts(parts) ? toIso(parts) : null
      } else if (evidence.order === 'day-first' || evidence.order === 'month-first') {
        const parts = toParts(text, evidence.order)
        normalized = parts ? toIso(parts) : null
      } else if (evidence.order === 'ambiguous') {
        const dayParts = toParts(text, 'day-first')
        const monthParts = toParts(text, 'month-first')
        if (!dayParts && !monthParts) normalized = null
        else { ambiguous += 1; return { ...row } }
      } else if (!toParts(text, 'day-first') && !toParts(text, 'month-first')) normalized = null
      else { ambiguous += 1; return { ...row } }
    }
    if (normalized === undefined || normalized === text && !(excelRows.has(rowIndex) && evidence.order === 'day-first')) return { ...row }
    if (normalized === null) invalid.push({ rowIndex, original: raw })
    else if (excelRows.has(rowIndex) && evidence.order === 'day-first') {
      const parts = normalized.split('-').map(Number)
      const month = parts[1]!; const day = parts[2]!
      if (day <= 12 && day !== month) {
        const swapped: Parts = { year: parts[0]!, month: day, day: month }
        if (validParts(swapped)) { normalized = toIso(swapped); swappedCount += 1 }
      }
    }
    if (normalized !== text && normalized !== null) converted += 1
    return { ...row, [column]: normalized }
  })
  return { rows: nextRows, order: evidence, converted, swapped: swappedCount, invalid, ambiguous }
}

export function swapDateMonthAndDay(value: string): string | null {
  const match = value.trim().match(/^\d{4}-(\d{2})-(\d{2})$/)
  if (!match) return null
  const [year] = value.trim().split('-').map(Number)
  if (match[1] === match[2]) return null
  const swapped = { year: year!, month: Number(match[2]), day: Number(match[1]) }
  return validParts(swapped) ? toIso(swapped) : null
}

export function findExcelDateSwapRows(rows: DataRow[], column: string, excelDateRows: readonly number[], evidence: DateOrderEvidence): number[] {
  if (evidence.order !== 'day-first') return []
  const result: number[] = []
  for (const rowIndex of excelDateRows) {
    const value = rows[rowIndex]?.[column]
    if (typeof value !== 'string') continue
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!match) continue
    const month = Number(match[2]); const day = Number(match[3])
    if (day <= 12 && day !== month && swapDateMonthAndDay(value)) result.push(rowIndex)
  }
  return result
}
