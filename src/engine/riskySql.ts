import type { RiskyDecision } from '../types'

export const quoteSqlIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`
export const quoteSqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`
const isMissing = (column: string): string => `(${column} IS NULL OR TRIM(CAST(${column} AS VARCHAR)) = '' OR LOWER(TRIM(CAST(${column} AS VARCHAR))) IN ('n/a','na','null','none','-'))`

/** Builds a SELECT over the current DuckDB relation. __dc_order is retained for stable first/last and replay ordering. */
export function buildRiskySelect(decision: RiskyDecision, columns: string[], protectedColumns: string[], source = 'dataset'): string {
  const selected = decision.columns.filter((name) => columns.includes(name) && !protectedColumns.includes(name))
  const refs = columns.map(quoteSqlIdentifier)
  const action = typeof decision.options.action === 'string' ? decision.options.action : 'flag'
  let projection = refs.map((column) => `${column}`).join(', ')
  let where = ''
  if (decision.kind === 'remove-duplicates') {
    const requested = Array.isArray(decision.options.keys) ? decision.options.keys as string[] : []
    const keys = (requested.length ? requested : columns).filter((name) => columns.includes(name))
    const keysSql = keys.length ? keys.map(quoteSqlIdentifier).join(', ') : refs.join(', ')
    const direction = decision.options.keep === 'last' ? 'DESC' : 'ASC'
    return `SELECT ${refs.join(', ')}, __dc_order FROM (SELECT ${refs.join(', ')}, __dc_order, ROW_NUMBER() OVER (PARTITION BY ${keysSql} ORDER BY __dc_order ${direction}) AS __dc_rank FROM ${source}) WHERE __dc_rank = 1 ORDER BY __dc_order`
  }
  if (decision.kind === 'fill-missing') {
    const strategy = typeof decision.options.strategy === 'string' ? decision.options.strategy : 'mode'
    if (strategy === 'drop-rows') {
      const predicate = selected.map((name) => isMissing(quoteSqlIdentifier(name))).join(' OR ')
      where = predicate ? ` WHERE NOT (${predicate})` : ''
    } else {
      projection = refs.map((column) => {
        if (!selected.includes(column.slice(1, -1).replaceAll('""', '"'))) return column
        if (strategy === 'leave-null') return column
        const replacement = strategy === 'constant' ? quoteSqlString(String(decision.options.value ?? ''))
          : strategy === 'forward-fill' ? `LAST_VALUE(NULLIF(CASE WHEN ${isMissing(column)} THEN NULL ELSE CAST(${column} AS VARCHAR) END, '') IGNORE NULLS) OVER (ORDER BY __dc_order ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`
            : strategy === 'mode' ? `(SELECT CAST(${column} AS VARCHAR) FROM ${source} WHERE NOT ${isMissing(column)} GROUP BY ${column} ORDER BY COUNT(*) DESC, CAST(${column} AS VARCHAR) ASC LIMIT 1)`
              : strategy === 'mean' ? `(SELECT CAST(AVG(TRY_CAST(${column} AS DOUBLE)) AS VARCHAR) FROM ${source} WHERE TRY_CAST(${column} AS DOUBLE) IS NOT NULL)`
                : `(SELECT CAST(MEDIAN(TRY_CAST(${column} AS DOUBLE)) AS VARCHAR) FROM ${source} WHERE TRY_CAST(${column} AS DOUBLE) IS NOT NULL)`
        return `CASE WHEN ${isMissing(column)} THEN COALESCE(${replacement}, CAST(${column} AS VARCHAR)) ELSE CAST(${column} AS VARCHAR) END AS ${column}`
      }).join(', ')
      if (decision.options.addWasMissingIndicator === true) {
        const occupied = new Set(columns)
        const indicators = selected.map((name) => {
          const base = `${name}__was_missing`
          let indicator = base; let suffix = 2
          while (occupied.has(indicator)) indicator = `${base}_${suffix++}`
          occupied.add(indicator)
          const ref = quoteSqlIdentifier(name)
          return `CASE WHEN ${isMissing(ref)} THEN TRUE ELSE FALSE END AS ${quoteSqlIdentifier(indicator)}`
        })
        if (indicators.length) projection = `${projection}, ${indicators.join(', ')}`
      }
    }
  } else if (decision.kind === 'handle-outliers') {
    if (action === 'remove') {
      if (selected.length) {
        const bounds = selected.flatMap((name, index) => {
          const c = quoteSqlIdentifier(name)
          const q1 = `QUANTILE_CONT(TRY_CAST(${c} AS DOUBLE), .25)`
          const q3 = `QUANTILE_CONT(TRY_CAST(${c} AS DOUBLE), .75)`
          return [`${q1} - 1.5 * (${q3} - ${q1}) AS low_${index}`, `${q3} + 1.5 * (${q3} - ${q1}) AS high_${index}`]
        })
        const predicates = selected.map((name, index) => { const c = quoteSqlIdentifier(name); return `(TRY_CAST(${c} AS DOUBLE) < bounds.low_${index} OR TRY_CAST(${c} AS DOUBLE) > bounds.high_${index})` })
        return `WITH bounds AS (SELECT ${bounds.join(', ')} FROM ${source}) SELECT ${refs.join(', ')}, __dc_order FROM ${source} CROSS JOIN bounds WHERE NOT COALESCE((${predicates.join(' OR ')}), FALSE) ORDER BY __dc_order`
      }
    } else if (action === 'cap') {
      projection = refs.map((c) => {
        if (!selected.includes(c.slice(1, -1).replaceAll('""', '"'))) return c
        const q1 = `(SELECT QUANTILE_CONT(TRY_CAST(${c} AS DOUBLE), .25) FROM ${source})`
        const q3 = `(SELECT QUANTILE_CONT(TRY_CAST(${c} AS DOUBLE), .75) FROM ${source})`
        const spread = `(${q3} - ${q1})`
        const low = `(${q1} - 1.5 * ${spread})`
        const high = `(${q3} + 1.5 * ${spread})`
        const number = `TRY_CAST(${c} AS DOUBLE)`
        return `CASE WHEN ${number} IS NOT NULL AND (${number} < ${low} OR ${number} > ${high}) THEN CAST(GREATEST(${low}, LEAST(${high}, ${number})) AS VARCHAR) ELSE ${c} END AS ${c}`
      }).join(', ')
    }
  } else if (decision.kind === 'standardize-categories') {
    const mapping = JSON.parse(String(decision.options.mapping ?? '{}')) as Record<string, string>
    const normalized = new Map<string, string>()
    for (const [key, value] of Object.entries(mapping)) {
      const norm = key.trim().toLowerCase()
      const prior = normalized.get(norm)
      if (prior !== undefined && prior !== value) throw new Error(`Conflicting category mappings for “${key.trim()}”.`)
      normalized.set(norm, value)
    }
    const cases = [...normalized].map(([key, value]) => `WHEN LOWER(TRIM(CAST(${quoteSqlIdentifier(selected[0] ?? '')} AS VARCHAR))) = ${quoteSqlString(key)} THEN ${quoteSqlString(value)}`)
    projection = refs.map((c) => selected.includes(c.slice(1, -1).replaceAll('""', '"')) ? `CASE ${cases.map((item) => item.replaceAll(quoteSqlIdentifier(selected[0] ?? ''), c)).join(' ')} ELSE CAST(${c} AS VARCHAR) END AS ${c}` : c).join(', ')
  } else if (decision.kind === 'resolve-ambiguous-dates') {
    const first = decision.options.order === 'month-first' ? 'month' : 'day'
    projection = refs.map((c) => selected.includes(c.slice(1, -1).replaceAll('""', '"')) ? `CASE WHEN TRY_STRPTIME(REPLACE(TRIM(CAST(${c} AS VARCHAR)), '-', '/'), '${first === 'day' ? '%d/%m/%Y' : '%m/%d/%Y'}') IS NOT NULL THEN STRFTIME(TRY_STRPTIME(REPLACE(TRIM(CAST(${c} AS VARCHAR)), '-', '/'), '${first === 'day' ? '%d/%m/%Y' : '%m/%d/%Y'}'), '%Y-%m-%d') ELSE CAST(${c} AS VARCHAR) END AS ${c}` : c).join(', ')
  }
  return `SELECT ${projection}, __dc_order FROM ${source}${where} ORDER BY __dc_order`
}
