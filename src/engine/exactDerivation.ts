import type { DataRow, DataValue } from '../types'
import { parseFormattedNumber } from '../cleaners/rules'
import { quoteSqlIdentifier } from './riskySql'

export interface ProductDerivationCandidate { target: string; left: string; right: string }
export interface ExactDerivationSuggestion extends ProductDerivationCandidate {
  observedRows: number
  matchingRows: number
  fillableRows: number
  matchPercent: number
  samples: Array<{ before: DataValue; after: number }>
}
export interface ProductDerivationMetrics { observedRows: number; matchingRows: number; fillableRows: number }

const isMissing = (value: DataValue | undefined): boolean => value == null || typeof value === 'string' && ['', 'n/a', 'na', 'null', 'none', '-'].includes(value.trim().toLowerCase())
const numeric = (value: DataValue | undefined): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = parseFormattedNumber(value ?? null)
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null
}
const isIdentifier = (name: string): boolean => /(?:^|[ _-])(?:id|identifier|code)(?:$|[ _-])/i.test(name)

/** Limit formula search to semantically named operands; avoids quadratic scans over wide datasets. */
export function getProductDerivationCandidates(targets: readonly string[], columns: readonly string[]): ProductDerivationCandidate[] {
  const quantities = [...new Set(columns)].filter((name) => !isIdentifier(name) && /\b(?:quantity|qty|units?)\b/i.test(name)).sort()
  const prices = [...new Set(columns)].filter((name) => !isIdentifier(name) && /\b(?:unit[ _-]?)?price\b|\brate\b|\bcost\b/i.test(name)).sort()
  const candidates: ProductDerivationCandidate[] = []
  for (const target of [...new Set(targets)].sort()) {
    if (isIdentifier(target)) continue
    for (const left of quantities) for (const right of prices) {
      if (target !== left && target !== right && left !== right) candidates.push({ target, left, right })
    }
  }
  return candidates
}

/** One aggregate query checks every candidate formula without materializing row data in JavaScript. */
export function buildProductDerivationMetricsSql(candidates: readonly ProductDerivationCandidate[], source = 'dataset'): string | null {
  if (!candidates.length) return null
  const quote = quoteSqlIdentifier
  const number = (column: string, alias?: string) => `TRY_CAST(CAST(${alias ? `${alias}.` : ''}${quote(column)} AS VARCHAR) AS DOUBLE)`
  const missing = (column: string, alias?: string) => {
    const value = `CAST(${alias ? `${alias}.` : ''}${quote(column)} AS VARCHAR)`
    return `(${value} IS NULL OR TRIM(${value}) = '' OR LOWER(TRIM(${value})) IN ('n/a','na','null','none','-'))`
  }
  const metrics = candidates.flatMap((candidate, index) => {
    const target = number(candidate.target)
    const left = number(candidate.left)
    const right = number(candidate.right)
    const present = `${target} IS NOT NULL AND ${left} IS NOT NULL AND ${right} IS NOT NULL`
    const product = `(${left} * ${right})`
    const matches = `ABS(${target} - ${product}) <= GREATEST(0.01, ABS(${target}) * 0.000001)`
    return [
      `COUNT(*) FILTER (WHERE ${present}) AS observed_${index}`,
      `COUNT(*) FILTER (WHERE ${present} AND ${matches}) AS matched_${index}`,
      `COUNT(*) FILTER (WHERE ${missing(candidate.target)} AND ${left} IS NOT NULL AND ${right} IS NOT NULL) AS fillable_${index}`,
    ]
  })
  return `SELECT ${metrics.join(', ')} FROM ${quoteSqlIdentifier(source)}`
}

export function productDerivationFromMetrics(candidate: ProductDerivationCandidate, metrics: ProductDerivationMetrics): Omit<ExactDerivationSuggestion, 'samples'> | null {
  if (metrics.observedRows < 100 || metrics.fillableRows < 1 || metrics.matchingRows !== metrics.observedRows) return null
  return { ...candidate, ...metrics, matchPercent: metrics.observedRows ? metrics.matchingRows / metrics.observedRows * 100 : 0 }
}

/** In-memory detector used by small files and by tests against the DuckDB aggregate result. */
export function detectProductDerivations(rows: DataRow[], targets: readonly string[], columns: readonly string[]): ExactDerivationSuggestion[] {
  const candidates = getProductDerivationCandidates(targets, columns)
  const suggestions: ExactDerivationSuggestion[] = []
  for (const candidate of candidates) {
    let observedRows = 0
    let matchingRows = 0
    let fillableRows = 0
    const samples: ExactDerivationSuggestion['samples'] = []
    for (const row of rows) {
      const target = numeric(row[candidate.target])
      const left = numeric(row[candidate.left])
      const right = numeric(row[candidate.right])
      if (isMissing(row[candidate.target]) && left !== null && right !== null) {
        fillableRows++
        if (samples.length < 10) samples.push({ before: row[candidate.target] ?? null, after: left * right })
      }
      if (target === null || left === null || right === null) continue
      observedRows++
      if (Math.abs(target - left * right) <= Math.max(0.01, Math.abs(target) * 0.000001)) matchingRows++
    }
    const suggestion = productDerivationFromMetrics(candidate, { observedRows, matchingRows, fillableRows })
    if (suggestion) suggestions.push({ ...suggestion, samples })
  }
  return suggestions.sort((left, right) => right.observedRows - left.observedRows || left.target.localeCompare(right.target) || left.left.localeCompare(right.left) || left.right.localeCompare(right.right))
}

export function applyProductDerivation(rows: DataRow[], target: string, leftColumn: string, rightColumn: string): { rows: DataRow[]; cellsChanged: number } {
  let cellsChanged = 0
  const next = rows.map((row) => {
    if (!isMissing(row[target])) return row
    const left = numeric(row[leftColumn])
    const right = numeric(row[rightColumn])
    if (left === null || right === null) return row
    cellsChanged++
    return { ...row, [target]: left * right }
  })
  return { rows: next, cellsChanged }
}
