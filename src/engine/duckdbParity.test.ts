// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import * as duckdb from '@duckdb/duckdb-wasm/dist/duckdb-node-blocking'
import { executeRiskyDecision } from './riskyDecisions'
import { buildRiskySelect, quoteSqlIdentifier, quoteSqlString } from './riskySql'
import { buildLowRiskExpression } from './lowRiskSql'
import { transformValue } from '../cleaners/rules'
import { LOW_RISK_RULES, runSmartClean, buildSmartCleanPlan } from './smartClean'
import { profileDataset } from '../profiler/profile'
import { globalLibraryFixture, trainFixture } from '../../tests/fixtures/smartCleanRegression'
import { normalizeColumnName } from '../cleaners/rules'
import type { DataRow, RiskyDecision } from '../types'

let database: Awaited<ReturnType<typeof duckdb.createDuckDB>>
let connection: duckdb.DuckDBConnection

beforeAll(async () => {
  const dist = resolve(process.cwd(), 'node_modules/@duckdb/duckdb-wasm/dist')
  database = await duckdb.createDuckDB({ mvp: { mainModule: resolve(dist, 'duckdb-mvp.wasm'), mainWorker: resolve(dist, 'duckdb-node-mvp.worker.cjs') } }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME)
  await database.instantiate()
  database.open({})
  connection = database.connect()
}, 30_000)

afterAll(() => { connection?.close(); database?.reset() })

const canonical = (value: unknown): unknown => {
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return value
}
type OrderedRow = DataRow & { __dc_order: number }
const cleanOrder = (row: OrderedRow): DataRow => Object.fromEntries(Object.entries(row).filter(([key]) => key !== '__dc_order')) as DataRow
const canonicalRows = (rows: DataRow[]): DataRow[] => rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, canonical(value) as DataRow[string]])))
const quote = (value: unknown): string => value == null ? 'NULL' : quoteSqlString(String(value))

function runDuckDbSmartClean(rows: DataRow[], columns: string[], profile: ReturnType<typeof profileDataset>, prefix: string): { rows: DataRow[]; columns: string[]; source: string; counts: Record<string, { cellsChanged: number; rowsRemoved: number; columnsRenamed: number }> } {
  const quoteId = (name: string) => `"${name.replaceAll('"', '""')}"`
  const schema = [...columns.map((name) => `${quoteId(name)} VARCHAR`), '"__dc_order" BIGINT'].join(', ')
  connection.query(`DROP TABLE IF EXISTS ${prefix}_source`)
  connection.query(`CREATE TABLE ${prefix}_source (${schema})`)
  const values = rows.map((row, index) => `(${[...columns.map((name) => quote(row[name])), String(index)].join(', ')})`).join(', ')
  connection.query(`INSERT INTO ${prefix}_source VALUES ${values}`)
  let current = `${prefix}_source`
  let names = [...columns]
  const counts: Record<string, { cellsChanged: number; rowsRemoved: number; columnsRenamed: number }> = {}
  let step = 0
  const plan = buildSmartCleanPlan(profile, [], LOW_RISK_RULES)
  for (const item of plan.filter((entry) => entry.rule.kind !== 'normalize-column-names' && entry.columns.length)) {
    const next = `${prefix}_v${++step}`
    if (item.rule.kind === 'remove-empty-rows') {
      const empty = names.map((name) => { const column = quoteId(name); return `(${column} IS NULL OR LOWER(TRIM(CAST(${column} AS VARCHAR))) IN ('', 'n/a', 'na', 'null', 'none', '-'))` }).join(' AND ')
      connection.query(`CREATE VIEW ${next} AS SELECT * FROM ${current} WHERE NOT (${empty})`)
    } else if (item.rule.kind === 'remove-empty-columns') {
      const removed = new Set(item.columns.filter((name) => names.includes(name)))
      if (removed.size && removed.size < names.length) names = names.filter((name) => !removed.has(name))
      const projection = [...names.map(quoteId), '"__dc_order"'].join(', ')
      connection.query(`CREATE VIEW ${next} AS SELECT ${projection} FROM ${current}`)
    } else {
      const selected = new Set(item.columns)
      const projection = names.map((name) => `${selected.has(name) ? buildLowRiskExpression(item.rule.kind as 'trim-whitespace' | 'normalize-missing' | 'formatted-numbers' | 'fix-type-mismatches', name) : quoteId(name)} AS ${quoteId(name)}`).concat('"__dc_order"').join(', ')
      connection.query(`CREATE VIEW ${next} AS SELECT ${projection} FROM ${current}`)
    }
    const comparable = names.filter((name) => {
      const schema = connection.query(`DESCRIBE ${next}`).toArray().map((row) => String(row.toJSON().column_name))
      return schema.includes(name)
    })
    const changedSql = comparable.map((name) => `CASE WHEN a.${quoteId(name)} IS DISTINCT FROM b.${quoteId(name)} THEN 1 ELSE 0 END`).join(' + ')
    const changed = changedSql ? Number(connection.query(`SELECT COALESCE(SUM(${changedSql}),0) AS count FROM ${current} a JOIN ${next} b USING ("__dc_order")`).toArray()[0]?.toJSON().count ?? 0) : 0
    const beforeRows = Number(connection.query(`SELECT COUNT(*) AS count FROM ${current}`).toArray()[0]?.toJSON().count ?? 0)
    const afterRows = Number(connection.query(`SELECT COUNT(*) AS count FROM ${next}`).toArray()[0]?.toJSON().count ?? 0)
    counts[item.rule.id] = { cellsChanged: changed, rowsRemoved: beforeRows - afterRows, columnsRenamed: 0 }
    current = next
  }
  const rename = plan.find((entry) => entry.rule.kind === 'normalize-column-names')
  if (rename?.columns.length) {
    const selected = new Set(rename.columns.filter((name) => names.includes(name)))
    const used = new Set(names.filter((name) => !selected.has(name)))
    const renames = new Map<string, string>()
    for (const name of names.filter((item) => selected.has(item))) {
      const base = normalizeColumnName(name); let next = base; let suffix = 2
      while (used.has(next)) next = `${base}_${suffix++}`
      used.add(next); renames.set(name, next)
    }
    names = names.map((name) => renames.get(name) ?? name)
    counts['normalize-column-names'] = { cellsChanged: 0, rowsRemoved: 0, columnsRenamed: [...renames].filter(([before, after]) => before !== after).length }
    const projection = columns.filter((name) => profile.columns.some((column) => column.name === name) && !profile.columns.some((column) => column.name === name && column.nullPercent === 100)).map((name) => `${quoteId(name)} AS ${quoteId(renames.get(name) ?? name)}`).concat('"__dc_order"').join(', ')
    const next = `${prefix}_v${++step}`
    connection.query(`CREATE VIEW ${next} AS SELECT ${projection} FROM ${current} ORDER BY "__dc_order"`)
    current = next
  }
  const result = connection.query(`SELECT * EXCLUDE ("__dc_order") FROM ${current} ORDER BY "__dc_order"`).toArray().map((row) => row.toJSON() as DataRow)
  return { rows: result, columns: names, source: current, counts }
}

describe('in-memory and DuckDB risky rule parity', () => {
  it('runs Global Library shaped Smart Clean on both engines without losing rows or column identity', () => {
    const { rows, columns } = globalLibraryFixture()
    const profile = profileDataset(rows, columns)
    const memory = runSmartClean(rows, profile)
    const duck = runDuckDbSmartClean(rows, columns, profile, 'global_library')
    expect(memory.rows).toHaveLength(219)
    expect(duck.rows).toHaveLength(219)
    expect(duck.columns).toHaveLength(7)
    expect(canonicalRows(duck.rows)).toEqual(canonicalRows(memory.rows))
    expect(memory.rows[0]?.country).toBe('Country 0')
    expect(Number(memory.rows[0]?.expenditures)).toBe(1)
    expect(memory.rows[0]?.region_name).toBeNull()
    expect(memory.groups.find((group) => group.ruleId === 'normalize-column-names')?.affectedRows).toBe(0)
    expect(memory.groups.find((group) => group.ruleId === 'normalize-column-names')?.columnsRenamed).toBe(7)
    expect(memory.groups.find((group) => group.ruleId === 'formatted-numbers')?.cellsChanged).toBe(854)
    expect(memory.groups.find((group) => group.ruleId === 'trim-whitespace')?.cellsChanged).toBe(1)
    expect(memory.groups.find((group) => group.ruleId === 'remove-empty-rows')?.rowsRemoved ?? 0).toBe(0)
    expect(duck.counts['formatted-numbers']).toMatchObject({ cellsChanged: 854, rowsRemoved: 0, columnsRenamed: 0 })
    expect(duck.counts['trim-whitespace']).toMatchObject({ cellsChanged: 1, rowsRemoved: 0, columnsRenamed: 0 })
    expect(duck.counts['normalize-missing']).toMatchObject({ cellsChanged: 29, rowsRemoved: 0, columnsRenamed: 0 })
    expect(duck.counts['normalize-column-names']).toMatchObject({ cellsChanged: 0, rowsRemoved: 0, columnsRenamed: 7 })
    const cleanedProfile = profileDataset(duck.rows, duck.columns, new Map(Object.entries(memory.stableColumnIds ?? {})))
    const secondMemory = runSmartClean(memory.rows, profileDataset(memory.rows, duck.columns, new Map(Object.entries(memory.stableColumnIds ?? {}))))
    const secondDuck = runDuckDbSmartClean(duck.rows, duck.columns, cleanedProfile, 'global_library_second')
    expect(secondMemory.groups.reduce((sum, group) => sum + (group.cellsChanged ?? 0), 0)).toBe(0)
    expect(secondMemory.groups.reduce((sum, group) => sum + (group.rowsRemoved ?? 0), 0)).toBe(0)
    expect(secondMemory.groups.reduce((sum, group) => sum + (group.columnsRenamed ?? 0), 0)).toBe(0)
    expect(Object.values(secondDuck.counts).reduce((sum, count) => sum + count.cellsChanged + count.rowsRemoved + count.columnsRenamed, 0)).toBe(0)
    const profileAfter = profileDataset(duck.rows, duck.columns, new Map(Object.entries(memory.stableColumnIds ?? {})))
    expect(profileAfter.summary.rows).toBe(219)
    expect(profileAfter.columns.find((column) => column.name === 'expenditures')?.uniqueCount).toBeGreaterThan(1)
    expect(profileAfter.columns.find((column) => column.name === 'expenditures')?.min).toBe(1)
    expect(profileAfter.columns.find((column) => column.name === 'expenditures')?.max).toBe(101)
    expect(profileAfter.columns.find((column) => column.name === 'country')?.id).toBe(profile.columns[0]?.id)
  })

  it('keeps 17 train-shaped duplicates as a proposal on both paths, then removes them only when accepted', () => {
    const { rows, columns } = trainFixture()
    const profile = profileDataset(rows, columns)
    const memory = runSmartClean(rows, profile)
    const duck = runDuckDbSmartClean(rows, columns, profile, 'train_regression')
    expect(memory.rows).toHaveLength(119)
    expect(duck.rows).toHaveLength(119)
    expect(memory.changeLog.find((entry) => entry.ruleId === 'normalize-column-names')).toMatchObject({ cellsChanged: 0, rowsRemoved: 0, columnsRenamed: 13, cellsFlagged: 0 })
    expect(memory.changeLog.reduce((sum, entry) => sum + (entry.cellsChanged ?? 0), 0)).toBe(0)
    expect(memory.changeLog.reduce((sum, entry) => sum + (entry.rowsRemoved ?? 0), 0)).toBe(0)
    expect(duck.counts['normalize-column-names']).toMatchObject({ cellsChanged: 0, rowsRemoved: 0, columnsRenamed: 13 })
    expect(canonicalRows(duck.rows)).toEqual(canonicalRows(memory.rows))
    const proposal = memory.proposed.find((item) => item.rule.kind === 'remove-duplicates')
    expect(proposal).toBeDefined()
    const decision: RiskyDecision = { kind: 'remove-duplicates', columns: duck.columns, options: { keys: [], keep: 'first' } }
    const memoryAccepted = executeRiskyDecision(memory.rows, decision)
    const sql = buildRiskySelect(decision, duck.columns, [], duck.source)
    const duckAccepted = connection.query(sql).toArray().map((row) => cleanOrder(row.toJSON() as OrderedRow))
    expect(memoryAccepted.result.rowsRemoved).toBe(17)
    expect(duckAccepted).toHaveLength(102)
    expect(canonicalRows(duckAccepted)).toEqual(canonicalRows(memoryAccepted.rows))
  })

  it('matches in-memory empty row/column removal and column renaming with difficult identifiers', () => {
    const names = ['a', 'a_2', ' A ', '', '東京 名', 'select', 'empty']
    const rows: DataRow[] = [
      { a: 'one', a_2: 'x', ' A ': 'v', '': 'z', '東京 名': '東', select: 'keep', empty: null },
      { a: '  ', a_2: null, ' A ': '', '': null, '東京 名': '-', select: ' ', empty: null },
      { a: 'two', a_2: 'y', ' A ': 'w', '': 'q', '東京 名': '京', select: 'second', empty: null },
      { a: 'three', a_2: 'z', ' A ': 'x', '': 'r', '東京 名': '都', select: 'third', empty: null },
      { a: 'four', a_2: 'm', ' A ': 'n', '': 's', '東京 名': '府', select: 'fourth', empty: null },
      { a: 'five', a_2: 'p', ' A ': 'o', '': 't', '東京 名': '県', select: 'fifth', empty: null },
    ]
    const profile = profileDataset(rows, names)
    const memoryResult = runSmartClean(rows, profile, [], undefined, LOW_RISK_RULES)
    const memory = memoryResult.rows

    connection.query('DROP TABLE IF EXISTS shape_source')
    connection.query('DROP TABLE IF EXISTS shape_cleaned')
    const sqlNames = names.map((name, index) => name === '' ? `__source_${index}` : name)
    const schema = sqlNames.map((name) => `${quoteSqlIdentifier(name)} VARCHAR`).join(', ')
    connection.query(`CREATE TABLE shape_source (${schema}, "__dc_order" BIGINT)`)
    const values = rows.map((row, index) => `(${names.map((name) => quote(row[name] ?? null)).concat(String(index)).join(', ')})`).join(', ')
    connection.query(`INSERT INTO shape_source VALUES ${values}`)
    // Match the worker's operations: empty rows are based on source values, then columns
    // are removed, then names are made unique against the unselected names.
    const removable = ['empty']
    const rowPredicate = names.map((name, index) => ({ name, sqlName: sqlNames[index]! })).filter(({ name }) => !removable.includes(name)).map(({ sqlName }) => `(${quoteSqlIdentifier(sqlName)} IS NULL OR LOWER(TRIM(CAST(${quoteSqlIdentifier(sqlName)} AS VARCHAR))) IN ('', 'n/a', 'na', 'null', 'none', '-'))`).join(' AND ')
    connection.query(`CREATE TABLE shape_nonempty AS SELECT * FROM shape_source WHERE NOT (${rowPredicate})`)
    const rename = new Map<string, string>()
    const used = new Set(names.filter((name) => normalizeColumnName(name) === name && name !== 'empty'))
    for (const name of names.filter((name) => normalizeColumnName(name) !== name && name !== 'empty')) {
      const base = normalizeColumnName(name); let next = base; let suffix = 2
      while (used.has(next)) next = `${base}_${suffix++}`
      used.add(next); rename.set(name, next)
    }
    const projection = names.map((name, index) => ({ name, sqlName: sqlNames[index]! })).filter(({ name }) => !removable.includes(name)).map(({ name, sqlName }) => `${quoteSqlIdentifier(sqlName)} AS ${quoteSqlIdentifier(rename.get(name) ?? name)}`).concat('"__dc_order"').join(', ')
    connection.query(`CREATE TABLE shape_cleaned AS SELECT ${projection} FROM shape_nonempty ORDER BY "__dc_order"`)
    const actual = connection.query('SELECT * EXCLUDE ("__dc_order") FROM shape_cleaned ORDER BY "__dc_order"').toArray().map((row) => row.toJSON() as DataRow)
    expect(actual).toEqual(memory)
    expect(Object.keys(actual[0] ?? {})).toContain('select')
    expect(Object.keys(actual[0] ?? {})).toContain('column')
    expect(Object.keys(actual[0] ?? {})).toContain('a_3')
    expect(Object.keys(actual[0] ?? {})).not.toContain('empty')
  })
  it.each(['trim-whitespace', 'normalize-missing', 'formatted-numbers', 'fix-type-mismatches'] as const)('matches in-memory Phase 2 values for %s', (kind) => {
    const values = kind === 'formatted-numbers' ? ['$1,200.50', '(€42)', '12.5%', 'plain']
      : kind === 'fix-type-mismatches' ? [' TRUE ', 'false', 'other', ' 7 ']
        : kind === 'normalize-missing' ? ['N/A', '-', 'normal', null]
          : ['  alpha  ', 'beta\t', '', null]
    connection.query('DROP TABLE IF EXISTS phase2_source')
    connection.query('CREATE TABLE phase2_source (value VARCHAR)')
    connection.query(`INSERT INTO phase2_source VALUES ${values.map((value) => `(${quote(value)})`).join(', ')}`)
    const sql = `SELECT ${buildLowRiskExpression(kind, 'value')} AS value FROM phase2_source`
    const actual = connection.query(sql).toArray().map((row) => row.toJSON().value as DataRow[string])
    const expected = values.map((value) => transformValue(kind, value as DataRow[string]))
    expect(actual.map(canonical)).toEqual(expected.map(canonical))
  })

  it('matches values, stable row order, nulls, counts, and sample changes for risky decisions', () => {
    const cases: Array<{ rows: DataRow[]; decision: RiskyDecision }> = [
      { rows: [{ key: 'a', value: '1', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'a', value: 'N/A', category: 'yes', date: '02/01/2024', lock: '守る' }, { key: null, value: '3', category: 'No', date: 'n/a', lock: '守る' }, { key: null, value: '5', category: 'no', date: 'x', lock: '守る' }], decision: { kind: 'remove-duplicates', columns: ['key'], options: { keys: ['key'], keep: 'last' } } },
      { rows: [{ key: 'a', value: '1', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'a', value: '1', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'a', value: '1', category: 'YES', date: '01/02/2024', lock: '別' }], decision: { kind: 'remove-duplicates', columns: ['key'], options: { keys: [], keep: 'first' } } },
      { rows: [{ key: 'a', value: '1', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: 'N/A', category: 'yes', date: '02/01/2024', lock: '守る' }, { key: 'c', value: '3', category: 'No', date: 'n/a', lock: '守る' }, { key: 'd', value: null, category: 'no', date: 'x', lock: '守る' }], decision: { kind: 'fill-missing', columns: ['value'], options: { strategy: 'median' } } },
      { rows: [{ key: 'a', value: '1', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: 'N/A', category: 'yes', date: '02/01/2024', lock: '守る' }, { key: 'c', value: '3', category: 'No', date: 'n/a', lock: '守る' }], decision: { kind: 'fill-missing', columns: ['value'], options: { strategy: 'mean' } } },
      { rows: [{ key: 'a', value: 'A', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: 'N/A', category: 'yes', date: '02/01/2024', lock: '守る' }, { key: 'c', value: 'B', category: 'No', date: 'n/a', lock: '守る' }], decision: { kind: 'fill-missing', columns: ['value'], options: { strategy: 'mode' } } },
      { rows: [{ key: 'a', value: null, category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: null, category: 'yes', date: '02/01/2024', lock: '守る' }], decision: { kind: 'fill-missing', columns: ['value'], options: { strategy: 'median' } } },
      { rows: [{ key: 'a', value: 'A', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: 'N/A', category: 'yes', date: '02/01/2024', lock: '守る' }, { key: 'c', value: 'C', category: 'No', date: 'n/a', lock: '守る' }], decision: { kind: 'fill-missing', columns: ['value'], options: { strategy: 'forward-fill' } } },
      { rows: [{ key: 'a', value: 'A', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: 'N/A', category: 'yes', date: '02/01/2024', lock: '守る' }], decision: { kind: 'fill-missing', columns: ['value'], options: { strategy: 'constant', value: '固定' } } },
      { rows: [{ key: 'a', value: 'A', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: 'N/A', category: 'yes', date: '02/01/2024', lock: '守る' }], decision: { kind: 'fill-missing', columns: ['value'], options: { strategy: 'drop-rows' } } },
      { rows: [{ key: 'a', value: '1', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: '2', category: 'yes', date: '02/01/2024', lock: '守る' }, { key: 'c', value: '3', category: 'No', date: 'n/a', lock: '守る' }, { key: 'd', value: '100', category: 'no', date: 'x', lock: '守る' }], decision: { kind: 'handle-outliers', columns: ['value'], options: { action: 'cap' } } },
      { rows: [{ key: 'a', value: '1', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: '2', category: 'yes', date: '02/01/2024', lock: '守る' }, { key: 'c', value: '3', category: 'No', date: 'n/a', lock: '守る' }, { key: 'd', value: '100', category: 'no', date: 'x', lock: '守る' }], decision: { kind: 'handle-outliers', columns: ['value'], options: { action: 'remove' } } },
      { rows: [{ key: 'a', value: '4', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: '4', category: 'yes', date: '02/01/2024', lock: '守る' }, { key: 'c', value: '4', category: 'No', date: 'n/a', lock: '守る' }, { key: 'd', value: '4', category: 'no', date: 'x', lock: '守る' }], decision: { kind: 'handle-outliers', columns: ['value'], options: { action: 'flag' } } },
      { rows: [{ key: 'a', value: '1', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: '2', category: 'yes', date: '02/01/2024', lock: '守る' }, { key: 'c', value: '3', category: 'No', date: 'n/a', lock: '守る' }, { key: 'd', value: '100', category: 'no', date: 'x', lock: '守る' }], decision: { kind: 'handle-outliers', columns: ['value'], options: { action: 'flag' } } },
      { rows: [{ key: 'a', value: '1', category: '東京', date: '01/02/2024', lock: '守る' }, { key: 'b', value: '2', category: '東京', date: '02/01/2024', lock: '守る' }], decision: { kind: 'standardize-categories', columns: ['category'], options: { mapping: '{"東京":"東京・東"}' } } },
      { rows: [{ key: 'a', value: '1', category: '東京', date: '02-01-2024', lock: '守る' }, { key: 'b', value: '2', category: '東亰', date: '31/02/2024', lock: '守る' }], decision: { kind: 'resolve-ambiguous-dates', columns: ['date'], options: { order: 'day-first' } } },
    ]

    for (const { rows, decision } of cases) {
      connection.query('DROP TABLE IF EXISTS source_version')
      connection.query('CREATE TABLE source_version ("key" VARCHAR, "value" VARCHAR, "category" VARCHAR, "date" VARCHAR, "lock" VARCHAR, "__dc_order" BIGINT)')
      const values = rows.map((row, index) => `(${['key', 'value', 'category', 'date', 'lock'].map((name) => quote(row[name])).concat(String(index)).join(', ')})`).join(', ')
      connection.query(`INSERT INTO source_version VALUES ${values}`)
      const sql = buildRiskySelect(decision, ['key', 'value', 'category', 'date', 'lock'], ['lock'], 'source_version')
      const duckRows = connection.query(sql).toArray().map((row) => {
        return cleanOrder(row.toJSON() as OrderedRow)
      })
      const inMemory = executeRiskyDecision(rows, decision, ['lock'])
      expect(canonicalRows(duckRows)).toEqual(canonicalRows(inMemory.rows))
      expect(duckRows.length).toBe(inMemory.result.rowsAfter)
      const afterByOrder = new Map<number, OrderedRow>(connection.query('SELECT * FROM source_version').toArray().map((row) => { const entry = row.toJSON() as OrderedRow; return [entry.__dc_order, entry] as const }))
      const selectedByOrder = new Map<number, OrderedRow>(connection.query(sql).toArray().map((row) => { const entry = row.toJSON() as OrderedRow; return [entry.__dc_order, entry] as const }))
      let changedCells = 0
      for (const [order, before] of afterByOrder) {
        const after = selectedByOrder.get(order)
        if (!after) continue
        for (const name of ['key', 'value', 'category', 'date', 'lock']) if (before[name] !== after[name]) changedCells++
      }
      expect(changedCells).toBe(inMemory.result.cellsChanged)
      if (decision.kind === 'handle-outliers') {
        const numeric = 'TRY_CAST("value" AS DOUBLE)'
        const q1 = `(SELECT QUANTILE_CONT(${numeric}, .25) FROM source_version)`
        const q3 = `(SELECT QUANTILE_CONT(${numeric}, .75) FROM source_version)`
        const spread = `(${q3} - ${q1})`
        const sqlFlagged = Number(connection.query(`SELECT COALESCE(SUM(CASE WHEN ${numeric} < (${q1} - 1.5 * ${spread}) OR ${numeric} > (${q3} + 1.5 * ${spread}) THEN 1 ELSE 0 END), 0) AS count FROM source_version`).toArray()[0]?.toJSON().count ?? 0)
        expect(sqlFlagged).toBe(inMemory.result.flaggedCells)
      }
      let sqlSamples = [...afterByOrder].flatMap(([order, before]) => {
        const after = selectedByOrder.get(order)
        const clean = (row: OrderedRow | undefined): DataRow => row ? cleanOrder(row) : {}
        if (!after) return [{ before: clean(before), after: {} }]
        const beforeClean = clean(before); const afterClean = clean(after)
        return Object.keys(beforeClean).some((name) => beforeClean[name] !== afterClean[name]) ? [{ before: beforeClean, after: afterClean }] : []
      }).slice(0, 10)
      if (decision.kind === 'handle-outliers' && decision.options.action === 'flag') {
        const numeric = 'TRY_CAST("value" AS DOUBLE)'
        const q1 = `(SELECT QUANTILE_CONT(${numeric}, .25) FROM source_version)`
        const q3 = `(SELECT QUANTILE_CONT(${numeric}, .75) FROM source_version)`
        const spread = `(${q3} - ${q1})`
        const flaggedRows = connection.query(`SELECT * FROM source_version WHERE ${numeric} < (${q1} - 1.5 * ${spread}) OR ${numeric} > (${q3} + 1.5 * ${spread}) ORDER BY "__dc_order" LIMIT 10`).toArray().map((row) => cleanOrder(row.toJSON() as OrderedRow))
        sqlSamples = flaggedRows.map((row) => ({ before: row, after: row }))
      }
      expect(canonicalRows(sqlSamples.map((sample) => sample.before))).toEqual(canonicalRows(inMemory.result.samples.map((sample) => sample.before)))
      expect(canonicalRows(sqlSamples.map((sample) => sample.after))).toEqual(canonicalRows(inMemory.result.samples.map((sample) => sample.after)))
      const removedRows = [...afterByOrder].filter(([order]) => !selectedByOrder.has(order)).map(([, row]) => cleanOrder(row))
      const memoryRemoved = inMemory.result.samples.filter((sample) => Object.keys(sample.after).length === 0).map((sample) => sample.before)
      expect(canonicalRows(removedRows)).toEqual(canonicalRows(memoryRemoved))
    }
  }, 30_000)

  it('builds a dataset-wide query for 1,000 columns without per-column request generation', () => {
    const columns = Array.from({ length: 1000 }, (_, index) => `column_${index}`)
    const sql = buildRiskySelect({ kind: 'fill-missing', columns, options: { strategy: 'constant', value: 'x' } }, columns, ['column_999'], 'source_version')
    expect(sql.match(/CASE WHEN/g)?.length).toBe(999)
    expect(sql).toContain('__dc_order')
  })

  it('replays history by switching views and restores the immutable source on reset', () => {
    connection.query('DROP VIEW IF EXISTS active_dataset')
    connection.query('DROP VIEW IF EXISTS version_two')
    connection.query('DROP VIEW IF EXISTS version_one')
    connection.query('DROP TABLE IF EXISTS original_source')
    connection.query("CREATE TABLE original_source AS SELECT * FROM (VALUES ('  first  ', 0), ('second', 1)) AS input(value, __dc_order)")
    connection.query('CREATE VIEW version_one AS SELECT TRIM(value) AS value, __dc_order FROM original_source')
    connection.query("CREATE VIEW version_two AS SELECT REPLACE(value, 'first', 'clean') AS value, __dc_order FROM version_one")
    connection.query('CREATE VIEW active_dataset AS SELECT * FROM version_two')
    expect(connection.query('SELECT value FROM active_dataset ORDER BY __dc_order').toArray().map((row) => row.toJSON().value)).toEqual(['clean', 'second'])
    connection.query('DROP VIEW active_dataset')
    connection.query('CREATE VIEW active_dataset AS SELECT * FROM version_one')
    expect(connection.query('SELECT value FROM active_dataset ORDER BY __dc_order').toArray().map((row) => row.toJSON().value)).toEqual(['first', 'second'])
    connection.query('DROP VIEW active_dataset')
    connection.query('CREATE VIEW active_dataset AS SELECT * FROM version_two')
    expect(connection.query('SELECT value FROM active_dataset ORDER BY __dc_order').toArray().map((row) => row.toJSON().value)).toEqual(['clean', 'second'])
    connection.query('DROP VIEW active_dataset')
    connection.query('CREATE VIEW active_dataset AS SELECT * FROM original_source')
    expect(connection.query('SELECT value FROM active_dataset ORDER BY __dc_order').toArray().map((row) => row.toJSON().value)).toEqual(['  first  ', 'second'])
  })
})
