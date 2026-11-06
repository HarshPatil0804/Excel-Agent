import type { DataRow, DataValue, CleaningRuleKind, ColumnProfile } from '../types'

export const MISSING_TOKENS = new Set(['', 'n/a', 'na', 'null', 'none', '-'])

export function normalizeMissing(value: DataValue): DataValue {
  return typeof value === 'string' && MISSING_TOKENS.has(value.trim().toLowerCase()) ? null : value
}

export function trimWhitespace(value: DataValue): DataValue {
  return typeof value === 'string' ? value.trim() : value
}

export interface MoneyParse { numeric: DataValue; currency: string | null }

const CURRENCY_SYMBOLS: Record<string, string> = { '₹': 'INR', $: 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY' }
const CURRENCY_CODE = '(?:INR|RS|USD|EUR|GBP|JPY)'

/** Canonical currency family for a single cell, if one is clearly present. */
export function detectCurrency(value: DataValue): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  const symbol = text.match(/[₹$£€¥]/)?.[0]
  if (symbol) return CURRENCY_SYMBOLS[symbol] ?? null
  const code = text.match(new RegExp(`^\\(?\\s*(${CURRENCY_CODE})\\.?(?![A-Za-z])`, 'i'))?.[1]
    ?? text.match(new RegExp(`(?:^|[^A-Za-z])(${CURRENCY_CODE})\\.?\\s*\\)?$`, 'i'))?.[1]
  if (!code) return null
  return code.toUpperCase() === 'RS' ? 'INR' : code.toUpperCase()
}

/** Parse a number and report the currency family it was written in. */
export function parseFormattedMoney(value: DataValue): MoneyParse {
  if (typeof value !== 'string') return { numeric: value, currency: null }
  const text = value.trim()
  const currency = detectCurrency(value)
  if (!text || !/[\d]/.test(text)) return { numeric: value, currency }
  const percent = text.endsWith('%')
  const negative = /^\(.*\)$/.test(text)
  let numericText = text.replace(new RegExp(`^\\(?\\s*${CURRENCY_CODE}\\.?\\s*`, 'i'), '')
  numericText = numericText.replace(new RegExp(`\\s*${CURRENCY_CODE}\\.?\\s*\\)?$`, 'i'), '')
  numericText = numericText.replace(/[₹$£€¥%()\s]/g, '')
  // Accept European decimal commas and Indian digit grouping without interpreting
  // ordinary US thousands separators as decimals.
  if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(numericText)) numericText = numericText.replace(/\./g, '').replace(',', '.')
  else if (/^\d{1,2}(?:,\d{2})+,\d{3}(?:\.\d+)?$/.test(numericText)) numericText = numericText.replace(/,/g, '')
  else if (/^\d+,\d{1,2}$/.test(numericText)) numericText = numericText.replace(',', '.')
  else numericText = numericText.replace(/,/g, '')
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(numericText)) return { numeric: value, currency }
  const number = Number(numericText) * (negative ? -1 : 1)
  if (!Number.isFinite(number)) return { numeric: value, currency }
  return { numeric: percent ? number / 100 : number, currency }
}

export function parseFormattedNumber(value: DataValue): DataValue {
  return parseFormattedMoney(value).numeric
}

export function formattedNumberParseRate(values: readonly DataValue[]): number {
  const present = values.filter((value) => normalizeMissing(value) !== null)
  if (!present.length) return 0
  return present.filter((value) => typeof parseFormattedNumber(value) === 'number').length / present.length
}

export function currencySignature(value: DataValue): string | null {
  return detectCurrency(value)
}

export function canonicalCategoryKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
}

function categorySimilarity(left: string, right: string): number {
  const a = canonicalCategoryKey(left); const b = canonicalCategoryKey(right)
  if (!a || !b) return 0
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = current
  }
  return 1 - previous[b.length]! / Math.max(a.length, b.length)
}

export function buildCategoryMapping(rows: DataRow[], column: string): Map<string, string> {
  const counts = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const value = row[column]
    if (typeof value !== 'string' || normalizeMissing(value) === null) continue
    const key = canonicalCategoryKey(value)
    if (!key) continue
    const variants = counts.get(key) ?? new Map<string, number>()
    variants.set(value, (variants.get(value) ?? 0) + 1)
    counts.set(key, variants)
  }
  return buildCategoryMappingFromCounts([...counts.values()].flatMap((variants) => [...variants]))
}

export function buildCategoryMappingFromCounts(values: Iterable<readonly [string, number]>): Map<string, string> {
  const counts = new Map<string, Map<string, number>>()
  for (const [value, count] of values) {
    const key = canonicalCategoryKey(value)
    const variants = counts.get(key) ?? new Map<string, number>()
    variants.set(value, (variants.get(value) ?? 0) + count)
    counts.set(key, variants)
  }
  const mapping = new Map<string, string>()
  for (const variants of counts.values()) {
    if (variants.size < 2) continue
    const ordered = [...variants].sort(([left, leftCount], [right, rightCount]) => {
      if (leftCount !== rightCount) return rightCount - leftCount
      const leftTitle = left === left.replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase())
      const rightTitle = right === right.replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase())
      if (leftTitle !== rightTitle) return leftTitle ? -1 : 1
      return left.localeCompare(right)
    })
    const canonical = ordered[0]![0]
    for (const [variant] of variants) if (variant !== canonical) mapping.set(variant, canonical)
  }
  return mapping
}// Windows-1252 maps bytes 0x80-0x9F to these characters instead of the matching
// Latin-1 code points, so they must be mapped back before decoding as UTF-8.
const CP1252_SPECIALS: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89,
  'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95,
  '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
}
const suspiciousMojibake = (text: string): number => (text.match(/[ÃÂâð�]/g) ?? []).length

export function repairMojibake(value: DataValue): DataValue {
  if (typeof value !== 'string' || suspiciousMojibake(value) === 0) return value
  const bytes: number[] = []
  for (const character of value) {
    const special = CP1252_SPECIALS[character]
    if (special !== undefined) { bytes.push(special); continue }
    const code = character.codePointAt(0) ?? 0
    if (code > 0xff) return value
    bytes.push(code)
  }
  try {
    const repaired = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes))
    if (repaired.includes('\ufffd')) return value
    return suspiciousMojibake(repaired) < suspiciousMojibake(value) ? repaired : value
  } catch { return value }
}

export function normalizeColumnName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'column'
}

export function isEmptyValue(value: DataValue): boolean { return normalizeMissing(value) === null }

export function isRuleApplicable(kind: CleaningRuleKind, column: ColumnProfile): boolean {
  switch (kind) {
    case 'trim-whitespace': return column.leadingWhitespaceCount + column.trailingWhitespaceCount > 0
    case 'normalize-missing': return column.nullCount > 0 || column.topValues.some(({ value }) => typeof value === 'string' && MISSING_TOKENS.has(value.trim().toLowerCase()))
    case 'formatted-numbers': return column.inferredType === 'integer' || column.inferredType === 'float' || column.issues.some((issue) => issue.code.includes('mixed')) || column.topValues.some(({ value }) => typeof value === 'string' && typeof parseFormattedNumber(value) === 'number')
    // Mojibake can hide in any column whose raw text has been repaired for typing;
    // the deterministic transform is a no-op for cells without mojibake.
    case 'repair-mojibake': return true
    case 'canonicalize-categories': {
      const keys = new Set<string>()
      return column.topValues.some(({ value }) => {
        if (typeof value !== 'string' || normalizeMissing(value) === null) return false
        const key = canonicalCategoryKey(value)
        if (keys.has(key)) return true
        keys.add(key)
        return false
      })
    }
    case 'normalize-dates': return /date|time|dob|birth|joined|created|updated/i.test(column.name) || column.inferredType === 'date' || column.inferredType === 'datetime' || column.invalidDateCount > 0
    case 'fix-type-mismatches': return column.mixedTypeCount > 0
    case 'remove-duplicates': return true
    case 'fill-missing': return column.nullCount > 0
    case 'handle-outliers': return column.iqrOutlierCount > 0
    case 'resolve-validation': return column.issues.some((issue) => issue.code === 'negative-quantity' || issue.code === 'negative-profit')
    case 'standardize-categories': case 'merge-categories': return column.topValues.some(({ value: left }, index, values) => typeof left === 'string' && values.slice(index + 1).some(({ value: right }) => typeof right === 'string' && canonicalCategoryKey(left) !== canonicalCategoryKey(right) && categorySimilarity(left, right) >= 0.85))
    case 'resolve-ambiguous-dates': return false
    case 'swap-excel-date-components': return false
    case 'normalize-column-names': return normalizeColumnName(column.name) !== column.name
    case 'remove-empty-columns': return column.nullPercent >= 100
    case 'remove-empty-rows': return true
    default: return false
  }
}

export function transformValue(kind: CleaningRuleKind, value: DataValue): DataValue {
  switch (kind) {
    case 'trim-whitespace': return trimWhitespace(value)
    case 'normalize-missing': return normalizeMissing(value)
    case 'formatted-numbers': return parseFormattedNumber(value)
    case 'repair-mojibake': return repairMojibake(value)
    case 'normalize-dates': return value
    case 'fix-type-mismatches': {
      const normalized = parseFormattedNumber(value)
      return typeof normalized === 'number' ? normalized : typeof value === 'string' && /^(true|false)$/i.test(value.trim()) ? value.trim().toLowerCase() : value
    }
    default: return value
  }
}

export function transformRow(kind: CleaningRuleKind, row: DataRow, columns: ReadonlySet<string>): DataRow {
  const next: DataRow = { ...row }
  for (const column of columns) next[column] = transformValue(kind, row[column] ?? null)
  return next
}
