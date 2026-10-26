import type { CleaningRuleKind } from '../types'
import type { DateOrder } from '../cleaners/dateNormalization'
import { quoteSqlIdentifier, quoteSqlString } from './riskySql'

export function buildLowRiskExpression(kind: Extract<CleaningRuleKind, 'trim-whitespace' | 'normalize-missing' | 'formatted-numbers' | 'fix-type-mismatches'>, name: string): string {
  const column = quoteSqlIdentifier(name)
  if (kind === 'trim-whitespace') return `REGEXP_REPLACE(CAST(${column} AS VARCHAR), '^[[:space:]]+|[[:space:]]+$', '', 'g')`
  if (kind === 'normalize-missing') return `CASE WHEN LOWER(TRIM(${column})) IN ('', 'n/a', 'na', 'null', 'none', '-') THEN NULL ELSE ${column} END`
  if (kind === 'formatted-numbers') {
    const text = `TRIM(CAST(${column} AS VARCHAR))`
    const stripped = `REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(${text}, '[%()]', '', 'g'), '^(INR|USD|EUR|GBP|[$£€¥₹])\\s*|\\s*(INR|USD|EUR|GBP)$', '', 'gi'), '^(INR|USD|EUR|GBP|[$£€¥₹])', '', 'gi'), '\\s', '', 'g')`
    const european = `REGEXP_FULL_MATCH(${stripped}, '[0-9]{1,3}(\\.[0-9]{3})+,[0-9]{1,2}') OR REGEXP_FULL_MATCH(${stripped}, '[0-9]+,[0-9]{1,2}')`
    const normalized = `CASE WHEN ${european} THEN REPLACE(REPLACE(${stripped}, '.', ''), ',', '.') ELSE REPLACE(${stripped}, ',', '') END`
    return `CASE WHEN REGEXP_FULL_MATCH(${normalized}, '[0-9]+(\\.[0-9]+)?') AND REGEXP_MATCHES(${text}, '.*[0-9].*') THEN CAST(TRY_CAST(${normalized} AS DOUBLE) * CASE WHEN LEFT(${text}, 1) = '(' THEN -1 ELSE 1 END / CASE WHEN RIGHT(${text}, 1) = '%' THEN 100 ELSE 1 END AS VARCHAR) ELSE ${column} END`
  }
  return `CASE WHEN LOWER(TRIM(${column})) IN ('true', 'false') THEN LOWER(TRIM(${column})) ELSE ${column} END`
}

export function buildDateNormalizationExpression(name: string, order: DateOrder): string {
  const column = quoteSqlIdentifier(name)
  const text = `TRIM(CAST(${column} AS VARCHAR))`
  const yearFirst = `TRY_STRPTIME(${text}, '%Y-%m-%d'), TRY_STRPTIME(${text}, '%Y/%m/%d'), TRY_STRPTIME(${text}, '%Y.%m.%d')`
  const dayFirst = `TRY_STRPTIME(${text}, '%d-%m-%Y'), TRY_STRPTIME(${text}, '%d/%m/%Y'), TRY_STRPTIME(${text}, '%d.%m.%Y')`
  const monthFirst = `TRY_STRPTIME(${text}, '%m-%d-%Y'), TRY_STRPTIME(${text}, '%m/%d/%Y'), TRY_STRPTIME(${text}, '%m.%d.%Y')`
  const eitherOrder = `COALESCE(${dayFirst}, ${monthFirst})`
  const supported = order === 'day-first' ? `${yearFirst}, ${dayFirst}` : order === 'month-first' ? `${yearFirst}, ${monthFirst}` : yearFirst
  const parsed = `COALESCE(${supported})`
  const dateLike = `REGEXP_FULL_MATCH(${text}, '^[0-9]{1,4}[./-][0-9]{1,2}[./-][0-9]{1,4}$')`
  const impossible = order === 'ambiguous' || order === 'mixed' || order === 'none' ? `${eitherOrder} IS NULL` : 'TRUE'
  return `CASE WHEN ${column} IS NULL OR ${text} = '' THEN ${column} WHEN ${dateLike} AND ${parsed} IS NOT NULL THEN STRFTIME(${parsed}, '%Y-%m-%d') WHEN ${dateLike} AND ${impossible} THEN NULL ELSE ${column} END`
}

export function buildMojibakeRepairExpression(name: string): string {
  const column = quoteSqlIdentifier(name)
  const pairs: Array<[string, string]> = [['Ã©', 'é'], ['Ã¨', 'è'], ['Ã¡', 'á'], ['Ã³', 'ó'], ['Ã±', 'ñ'], ['Ã¼', 'ü'], ['Ã§', 'ç'], ['â€™', '’'], ['â€œ', '“'], ['â€�', '”'], ['â€“', '–'], ['â€”', '—'], ['Â ', ' ']]
  let expression = `CAST(${column} AS VARCHAR)`
  for (const [bad, good] of pairs) expression = `REPLACE(${expression}, '${bad}', '${good}')`
  return `CASE WHEN REGEXP_MATCHES(CAST(${column} AS VARCHAR), '.*[ÃÂâ].*') THEN ${expression} ELSE ${column} END`
}

export function buildCategoryCaseExpression(name: string, mapping: ReadonlyMap<string, string>): string {
  const column = quoteSqlIdentifier(name)
  if (!mapping.size) return column
  const cases = [...mapping].map(([before, after]) => `WHEN ${quoteSqlString(before)} THEN ${quoteSqlString(after)}`).join(' ')
  return `CASE CAST(${column} AS VARCHAR) ${cases} ELSE ${column} END`
}
