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
  const normalized = text.replace(/[,$£€¥%\s()]/g, '').replace(/,/g, '')
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return value
  const number = Number(normalized) * (negative ? -1 : 1)
  return Number.isFinite(number) ? (percent ? number / 100 : number) : value
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
    case 'fix-type-mismatches': return column.mixedTypeCount > 0
    case 'remove-duplicates': return true
    case 'fill-missing': return column.nullCount > 0
    case 'handle-outliers': return column.iqrOutlierCount > 0
    case 'standardize-categories': case 'merge-categories': return column.inconsistentCasingCount > 0
    case 'resolve-ambiguous-dates': return column.invalidDateCount > 0 || column.inferredType === 'date'
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
