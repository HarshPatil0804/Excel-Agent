import type { DataRow, DataValue, CleaningRuleKind, ColumnProfile } from '../types'

export const MISSING_TOKENS = new Set(['', 'n/a', 'na', 'null', 'none', '-'])

export function normalizeMissing(value: DataValue): DataValue {
  return typeof value === 'string' && MISSING_TOKENS.has(value.trim().toLowerCase()) ? null : value
}

export function trimWhitespace(value: DataValue): DataValue {
  return typeof value === 'string' ? value.trim() : value
}

export function parseFormattedNumber(value: DataValue): DataValue {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text || !/[\d]/.test(text)) return value
  const percent = text.endsWith('%')
  const negative = /^\(.*\)$/.test(text)
  let numericText = text.replace(/^(?:INR|USD|EUR|GBP)\s*/i, '').replace(/\s*(?:INR|USD|EUR|GBP)$/i, '')
  numericText = numericText.replace(/[₹$£€¥%\s()]/g, '')
  // Accept European decimal commas and Indian digit grouping without interpreting
  // ordinary US thousands separators as decimals.
  if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(numericText)) numericText = numericText.replace(/\./g, '').replace(',', '.')
  else if (/^\d{1,2}(?:,\d{2})+,\d{3}(?:\.\d+)?$/.test(numericText)) numericText = numericText.replace(/,/g, '')
  else if (/^\d+,\d{1,2}$/.test(numericText)) numericText = numericText.replace(',', '.')
  else numericText = numericText.replace(/,/g, '')
  const normalized = numericText
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return value
  const number = Number(normalized) * (negative ? -1 : 1)
  return Number.isFinite(number) ? (percent ? number / 100 : number) : value
}

export function formattedNumberParseRate(values: readonly DataValue[]): number {
  const present = values.filter((value) => normalizeMissing(value) !== null)
  if (!present.length) return 0
  return present.filter((value) => typeof parseFormattedNumber(value) === 'number').length / present.length
}

export function currencySignature(value: DataValue): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  const code = text.match(/(?:^|\s)(INR|USD|EUR|GBP)(?:$|\s)/i)?.[1]
  const symbol = text.match(/[₹$£€¥]/)?.[0]
  const signature = code?.toUpperCase() ?? (symbol ? ({ '₹': 'INR', '$': 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY' } as Record<string, string>)[symbol] : null)
  return signature ?? null
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
}

export function repairMojibake(value: DataValue): DataValue {
  if (typeof value !== 'string' || !/[ÃÂâð�]/.test(value)) return value
  const knownRepairs: Array<[string, string]> = [['â€™', '’'], ['â€œ', '“'], ['â€�', '”'], ['â€“', '–'], ['â€”', '—'], ['â€¦', '…'], ['Â ', ' '], ['Â£', '£'], ['Â€', '€']]
  let known = value
  for (const [bad, good] of knownRepairs) known = known.replaceAll(bad, good)
  if (known !== value) return known
  try {
    const bytes = Uint8Array.from(Array.from(value, (character) => character.charCodeAt(0) & 0xff))
    const repaired = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const suspicious = (text: string) => (text.match(/[ÃÂâð�]/g) ?? []).length
    return suspicious(repaired) < suspicious(value) ? repaired : value
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
    case 'repair-mojibake': return column.topValues.some(({ value }) => typeof value === 'string' && repairMojibake(value) !== value)
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
