export interface DuckDbCompareColumn { original: string; cleaned: string; display: string }
export interface DuckDbVersion { table: string; removedBy: string }

const id = (value: string): string => `"${value.replaceAll('"', '""')}"`
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`

function expandedCompareCte(columns: DuckDbCompareColumn[]): string {
  const names = columns.map((column) => literal(column.display)).join(', ')
  const before = columns.map((column) => `CAST(b.${id(column.original)} AS VARCHAR)`).join(', ')
  const after = columns.map((column) => `CAST(a.${id(column.cleaned)} AS VARCHAR)`).join(', ')
  return `WITH paired AS (SELECT b."__dc_order" AS row_id, list_value(${names}) AS names, list_value(${before}) AS before_values, list_value(${after}) AS after_values FROM dataset_original b JOIN dataset a USING ("__dc_order")), expanded AS (SELECT row_id, unnest(names) AS "column", unnest(before_values) AS "before", unnest(after_values) AS "after" FROM paired)`
}

/** Build one DuckDB query that expands a bounded result page from the immutable source/current view pair. */
export function buildDuckDbCompareSql(columns: DuckDbCompareColumn[], limit: number, offset: number): string {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new RangeError('Compare page size must be from 1 to 10,000.')
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Compare page offset must be a non-negative integer.')
  if (!columns.length) return 'SELECT 0 AS row_id, \'\' AS "column", NULL AS "before", NULL AS "after" WHERE FALSE'
  return `${expandedCompareCte(columns)} SELECT row_id, "column", "before", "after" FROM expanded WHERE "before" IS DISTINCT FROM "after" ORDER BY row_id, "column" LIMIT ${limit} OFFSET ${offset}`
}

export function buildDuckDbCompareAfterSql(columns: DuckDbCompareColumn[], limit: number, after?: { rowId: number; column: string }): string {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new RangeError('Compare page size must be from 1 to 10,000.')
  if (!columns.length) return 'SELECT 0 AS row_id, \'\' AS "column", NULL AS "before", NULL AS "after" WHERE FALSE'
  const cursor = after ? ` AND (row_id > ${Math.floor(after.rowId)} OR (row_id = ${Math.floor(after.rowId)} AND "column" > ${literal(after.column)}))` : ''
  return `${expandedCompareCte(columns)} SELECT row_id, "column", "before", "after" FROM expanded WHERE "before" IS DISTINCT FROM "after"${cursor} ORDER BY row_id, "column" LIMIT ${limit}`
}

export function buildDuckDbCompareCountSql(columns: DuckDbCompareColumn[]): string {
  if (!columns.length) return 'SELECT 0 AS count'
  return `${expandedCompareCte(columns)} SELECT COUNT(*) AS count FROM expanded WHERE "before" IS DISTINCT FROM "after"`
}

export function buildDuckDbRemovedRowsSql(versions: DuckDbVersion[], columns: string[], limit: number, offset: number): string {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new RangeError('Removed-row page size must be from 1 to 10,000.')
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Removed-row page offset must be a non-negative integer.')
  if (versions.length < 2) throw new Error('A cleaned dataset version is required to compare removed rows.')
  const source = versions[0]!
  const joins = versions.slice(1).map((version, index) => `LEFT JOIN ${id(version.table)} v${index + 1} USING ("__dc_order")`).join(' ')
  const firstMissing = versions.slice(1).map((version, index) => `WHEN v${index + 1}."__dc_order" IS NULL THEN ${literal(version.removedBy)}`).join(' ')
  const projection = columns.map((column) => `o.${id(column)}`).join(', ')
  return `SELECT o."__dc_order" AS row_id, CASE ${firstMissing} ELSE 'Removal rule unavailable' END AS removal_rule${projection ? `, ${projection}` : ''} FROM ${id(source.table)} o ${joins} LEFT JOIN dataset c USING ("__dc_order") WHERE c."__dc_order" IS NULL ORDER BY o."__dc_order" LIMIT ${limit} OFFSET ${offset}`
}
