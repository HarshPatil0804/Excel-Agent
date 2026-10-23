import type { CleaningRuleKind } from '../types'
import { quoteSqlIdentifier } from './riskySql'

export function buildLowRiskExpression(kind: Extract<CleaningRuleKind, 'trim-whitespace' | 'normalize-missing' | 'formatted-numbers' | 'fix-type-mismatches'>, name: string): string {
  const column = quoteSqlIdentifier(name)
  if (kind === 'trim-whitespace') return `REGEXP_REPLACE(CAST(${column} AS VARCHAR), '^[[:space:]]+|[[:space:]]+$', '', 'g')`
  if (kind === 'normalize-missing') return `CASE WHEN LOWER(TRIM(${column})) IN ('', 'n/a', 'na', 'null', 'none', '-') THEN NULL ELSE ${column} END`
  if (kind === 'formatted-numbers') return `CASE WHEN REGEXP_MATCHES(TRIM(${column}), '^\\(?[$£€¥]?[0-9,]+(\\.[0-9]+)?%?\\)?$') THEN CAST(CAST(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(${column}), '$', ''), '£', ''), '€', ''), ',', ''), '%', ''), '(', ''), ')', '') AS DOUBLE) * CASE WHEN LEFT(TRIM(${column}), 1) = '(' THEN -1 ELSE 1 END / CASE WHEN RIGHT(TRIM(${column}), 1) = '%' THEN 100 ELSE 1 END AS VARCHAR) ELSE ${column} END`
  return `CASE WHEN LOWER(TRIM(${column})) IN ('true', 'false') THEN LOWER(TRIM(${column})) ELSE ${column} END`
}
