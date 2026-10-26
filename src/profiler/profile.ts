import { z } from 'zod'
import type { ColumnIssue, ColumnProfile, DataRow, DataValue, InferredType, IssueSeverity, ProfileResult } from '../types'
import { currencySignature, parseFormattedNumber } from '../cleaners/rules'

const severitySchema = z.enum(['info', 'warning', 'error'])
const issueSchema = z.object({ code: z.string(), severity: severitySchema, message: z.string(), count: z.number().int().nonnegative().optional() })
const profileSchema = z.object({
  id: z.string(), name: z.string(), inferredType: z.enum(['integer', 'float', 'boolean', 'date', 'datetime', 'text', 'categorical']),
  nullCount: z.number().int().nonnegative(), nullPercent: z.number().min(0).max(100), uniqueCount: z.number().int().nonnegative(),
  duplicateValueCount: z.number().int().nonnegative(), min: z.union([z.string(), z.number(), z.boolean(), z.null()]), max: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  mean: z.number().nullable(), median: z.number().nullable(), topValues: z.array(z.object({ value: z.union([z.string(), z.number(), z.boolean(), z.null()]), count: z.number().int().positive() })),
  mixedTypeCount: z.number().int().nonnegative(), leadingWhitespaceCount: z.number().int().nonnegative(), trailingWhitespaceCount: z.number().int().nonnegative(),
  inconsistentCasingCount: z.number().int().nonnegative(), invalidEmailCount: z.number().int().nonnegative(), invalidPhoneCount: z.number().int().nonnegative(),
  invalidDateCount: z.number().int().nonnegative(), iqrOutlierCount: z.number().int().nonnegative(), currencySymbols: z.array(z.string()).default([]), issues: z.array(issueSchema),
})
const summarySchema = z.object({ rows: z.number().int().nonnegative(), columns: z.number().int().nonnegative(), fullyDuplicateRows: z.number().int().nonnegative(), fullyEmptyRows: z.number().int().nonnegative(), fullyEmptyColumns: z.number().int().nonnegative(), nullCells: z.number().int().nonnegative(), memoryEstimateBytes: z.number().nonnegative() })
export const profileResultSchema = z.object({ summary: summarySchema, columns: z.array(profileSchema), datasetIssues: z.array(issueSchema) })

const isMissing = (value: DataValue): boolean => value === null || (typeof value === 'string' && (!value.trim() || ['n/a', 'na', '-'].includes(value.trim().toLowerCase())))
const parseDateValue = (value: string): Date | null => {
  const text = value.trim()
  if (!/^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(text) && !/^\d{4}-\d{2}-\d{2}T/.test(text)) return null
  const parsed = new Date(text)
  return Number.isNaN(parsed.valueOf()) ? null : parsed
}

function kindOf(value: DataValue): string {
  if (value === null || isMissing(value)) return 'missing'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'float'
  if (/^(true|false|yes|no)$/i.test(value.trim())) return 'boolean'
  const date = parseDateValue(value)
  if (date) return /[T ]\d{1,2}:\d{2}/.test(value) ? 'datetime' : 'date'
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return Number.isInteger(Number(value)) ? 'integer' : 'float'
  return 'text'
}

export function inferColumnType(values: DataValue[], columnName = ''): InferredType {
  const present = values.filter((value) => !isMissing(value))
  if (!present.length) return 'categorical'
  const kinds = new Set(present.map(kindOf))
  if ([...kinds].every((kind) => kind === 'integer')) return 'integer'
  if ([...kinds].every((kind) => kind === 'integer' || kind === 'float')) return 'float'
  if ([...kinds].every((kind) => kind === 'boolean')) return 'boolean'
  if ([...kinds].every((kind) => kind === 'date')) return 'date'
  if ([...kinds].every((kind) => kind === 'date' || kind === 'datetime') && kinds.has('datetime')) return 'datetime'
  const distinct = new Set(present.map(String)).size
  if (distinct <= Math.max(12, Math.ceil(present.length * 0.2)) && !/email|phone|address|description/i.test(columnName)) return 'categorical'
  return 'text'
}

const addIssue = (issues: ColumnIssue[], code: string, severity: IssueSeverity, message: string, count: number): void => {
  if (count > 0) issues.push({ code, severity, message, count })
}

function numericQuartiles(values: number[]): { low: number; high: number } | null {
  if (values.length < 4) return null
  const sorted = [...values].sort((a, b) => a - b)
  const quantile = (fraction: number): number => {
    const position = (sorted.length - 1) * fraction
    const lower = Math.floor(position)
    const upper = Math.ceil(position)
    return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
  }
  const q1 = quantile(0.25)
  const q3 = quantile(0.75)
  const spread = q3 - q1
  return { low: q1 - 1.5 * spread, high: q3 + 1.5 * spread }
}

export function profileColumn(name: string, values: DataValue[], id = `column:${name}`): ColumnProfile {
  const counts = new Map<string, { value: DataValue; count: number }>()
  const present: DataValue[] = []
  let leadingWhitespaceCount = 0
  let trailingWhitespaceCount = 0
  let invalidEmailCount = 0
  let invalidPhoneCount = 0
  let invalidDateCount = 0
  const distinctSpellings = new Map<string, Set<string>>()
  const currencies = new Set<string>()
  const candidateDateColumn = /date|time|dob|birth|joined|created|updated/i.test(name)
  const candidateQuantityColumn = /quantity|qty/i.test(name)
  const candidateProfitColumn = /profit/i.test(name)
  const candidatePhoneColumn = /phone|mobile|tel/i.test(name)
  const candidateEmailColumn = /email|e-mail/i.test(name)

  for (const value of values) {
    if (isMissing(value)) continue
    present.push(value)
    const key = `${typeof value}:${String(value)}`
    const existing = counts.get(key)
    if (existing) existing.count += 1
    else counts.set(key, { value, count: 1 })
    if (typeof value === 'string') {
      const currency = currencySignature(value)
      if (currency) currencies.add(currency)
      if (/^\s/.test(value)) leadingWhitespaceCount += 1
      if (/\s$/.test(value)) trailingWhitespaceCount += 1
      const trimmed = value.trim()
      const spellings = distinctSpellings.get(trimmed.toLocaleLowerCase()) ?? new Set<string>()
      spellings.add(trimmed)
      distinctSpellings.set(trimmed.toLocaleLowerCase(), spellings)
      if ((candidateEmailColumn || trimmed.includes('@')) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) invalidEmailCount += 1
      if (candidatePhoneColumn && /[\d+() .-]/.test(trimmed) && (trimmed.replace(/\D/g, '').length < 7 || trimmed.replace(/\D/g, '').length > 15)) invalidPhoneCount += 1
      if (candidateDateColumn && !parseDateValue(trimmed)) invalidDateCount += 1
    }
  }

  const type = inferColumnType(values, name)
  const numericValues = present.map((value) => Number(value)).filter(Number.isFinite)
  const quartiles = numericQuartiles(numericValues)
  const iqrOutlierCount = quartiles ? numericValues.filter((value) => value < quartiles.low || value > quartiles.high).length : 0
  const domainNumbers = present.map((value) => parseFormattedNumber(value)).filter((value): value is number => typeof value === 'number')
  const negativeQuantityCount = candidateQuantityColumn ? domainNumbers.filter((value) => value < 0).length : 0
  const negativeProfitCount = candidateProfitColumn ? domainNumbers.filter((value) => value < 0).length : 0
  const today = new Date(); today.setHours(23, 59, 59, 999)
  const futureDateCount = candidateDateColumn ? present.filter((value) => typeof value === 'string' && (parseDateValue(value)?.getTime() ?? 0) > today.getTime()).length : 0
  const typeFamilies = new Set(present.map((value) => {
    const kind = kindOf(value)
    return kind === 'integer' || kind === 'float' ? 'number' : kind
  }))
  const mixedTypeCount = typeFamilies.size > 1 ? present.length : 0
  const sortedValues = [...present].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }))
  const numericSorted = [...numericValues].sort((a, b) => a - b)
  const middle = Math.floor(numericSorted.length / 2)
  const median = numericSorted.length ? numericSorted.length % 2 ? numericSorted[middle]! : (numericSorted[middle - 1]! + numericSorted[middle]!) / 2 : null
  const nullCount = values.length - present.length
  const duplicateValueCount = [...counts.values()].reduce((sum, item) => sum + Math.max(item.count - 1, 0), 0)
  const identifierColumn = /(?:^|[ _-])(?:id|identifier|code)(?:$|[ _-])/i.test(name) && present.length > 1 && counts.size / present.length >= 0.8
  const casingGroups = [...distinctSpellings.values()].filter((spellings) => spellings.size > 1)
  const inconsistentCasingCount = casingGroups.reduce((sum, spellings) => sum + spellings.size, 0)
  const issues: ColumnIssue[] = []
  addIssue(issues, 'missing-values', nullCount > values.length * 0.25 ? 'warning' : 'info', 'Missing or empty values found.', nullCount)
  addIssue(issues, 'mixed-types', 'warning', 'Values use mixed data types.', mixedTypeCount)
  addIssue(issues, 'leading-whitespace', 'warning', 'Values contain leading whitespace.', leadingWhitespaceCount)
  addIssue(issues, 'trailing-whitespace', 'warning', 'Values contain trailing whitespace.', trailingWhitespaceCount)
  addIssue(issues, 'inconsistent-casing', 'warning', 'Values use inconsistent casing.', inconsistentCasingCount)
  addIssue(issues, 'invalid-email', 'error', 'Values do not look like valid email addresses.', invalidEmailCount)
  addIssue(issues, 'invalid-phone', 'warning', 'Phone values should contain 7 to 15 digits.', invalidPhoneCount)
  addIssue(issues, 'invalid-date', 'error', 'Date values could not be parsed consistently.', invalidDateCount)
  addIssue(issues, 'iqr-outliers', 'info', 'Numeric values outside the 1.5× IQR range.', iqrOutlierCount)
  addIssue(issues, 'mixed-currency', 'warning', `Values contain multiple currency families: ${[...currencies].sort().join(', ')}.`, currencies.size > 1 ? currencies.size : 0)
  addIssue(issues, 'negative-quantity', 'warning', 'Negative quantities require review.', negativeQuantityCount)
  addIssue(issues, 'negative-profit', 'warning', 'Negative profit values require review.', negativeProfitCount)
  addIssue(issues, 'future-date', 'warning', 'Dates later than today require review.', futureDateCount)
  addIssue(issues, 'identifier-column', 'info', 'This high-uniqueness ID/code column is excluded from automatic imputation.', identifierColumn ? present.length : 0)

  return {
    id, name, inferredType: type, nullCount, nullPercent: values.length ? (nullCount / values.length) * 100 : 0,
    uniqueCount: counts.size, duplicateValueCount, min: numericValues.length === present.length && present.length ? numericValues.reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY) : sortedValues[0] ?? null,
    max: numericValues.length === present.length && present.length ? numericValues.reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY) : sortedValues.at(-1) ?? null,
    mean: numericValues.length ? numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length : null,
    median, topValues: [...counts.values()].sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value))).slice(0, 5),
    mixedTypeCount, leadingWhitespaceCount, trailingWhitespaceCount, inconsistentCasingCount, invalidEmailCount, invalidPhoneCount, invalidDateCount, iqrOutlierCount, currencySymbols: [...currencies].sort(), issues,
  }
}

export function profileDataset(rows: DataRow[], names?: string[], stableIds?: ReadonlyMap<string, string>): ProfileResult {
  const columns = names ?? [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const profiles = columns.map((name, index) => profileColumn(name, rows.map((row) => row[name] ?? null), stableIds?.get(name) ?? `column:${index}`))
  const rowSignatures = new Map<string, number>()
  let fullyEmptyRows = 0
  let memoryEstimateBytes = 0
  for (const row of rows) {
    const values = columns.map((name) => row[name] ?? null)
    if (values.every(isMissing)) fullyEmptyRows += 1
    const signature = JSON.stringify(values)
    rowSignatures.set(signature, (rowSignatures.get(signature) ?? 0) + 1)
    memoryEstimateBytes += signature.length * 2
  }
  const fullyDuplicateRows = [...rowSignatures.values()].reduce((sum, count) => sum + Math.max(count - 1, 0), 0)
  const fullyEmptyColumns = profiles.filter((profile) => profile.nullCount === rows.length).length
  const nullCells = profiles.reduce((sum, profile) => sum + profile.nullCount, 0)
  const result: ProfileResult = {
    summary: { rows: rows.length, columns: columns.length, fullyDuplicateRows, fullyEmptyRows, fullyEmptyColumns, nullCells, memoryEstimateBytes },
    columns: profiles,
    datasetIssues: [
      ...(fullyDuplicateRows ? [{ code: 'duplicate-rows', severity: 'warning' as const, message: 'Fully duplicated rows found.', count: fullyDuplicateRows }] : []),
      ...(fullyEmptyRows ? [{ code: 'empty-rows', severity: 'info' as const, message: 'Fully empty rows found.', count: fullyEmptyRows }] : []),
      ...(fullyEmptyColumns ? [{ code: 'empty-columns', severity: 'info' as const, message: 'Fully empty columns found.', count: fullyEmptyColumns }] : []),
    ],
  }
  return profileResultSchema.parse(result)
}
