// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import * as duckdb from '@duckdb/duckdb-wasm/dist/duckdb-node-blocking'
import { executeRiskyDecision } from './riskyDecisions'
import { buildRiskySelect, quoteSqlIdentifier, quoteSqlString } from './riskySql'
import { buildCategoryCaseExpression, buildDateNormalizationExpression, buildLowRiskExpression, buildMojibakeRepairExpression } from './lowRiskSql'
import { buildCategoryMapping, buildCategoryMappingFromCounts, transformValue } from '../cleaners/rules'
import { LOW_RISK_RULES, runSmartClean, buildSmartCleanPlan } from './smartClean'
import { profileDataset } from '../profiler/profile'
import { globalLibraryFixture, trainFixture } from '../../tests/fixtures/smartCleanRegression'
import { normalizeColumnName } from '../cleaners/rules'
import { buildDuckDbCompareAfterSql, buildDuckDbCompareCountSql, buildDuckDbCompareSql, buildDuckDbRemovedRowsSql } from './duckdbCompare'
import { buildDuckDbJsonExportProjection, normalizeDuckDbJsonValue } from './duckdbExport'
import { buildDuckDbImputationSampleSql, buildDuckDbImputationViewSql, processDuckDbEstimateBatches } from './duckdbImputation'
import { recommendMissingValues } from './localImputation'
import { DuckDbBundleSession } from './duckdbBundle'
import { serializeCsv } from '../lib/exportData'
import { serializeJson, serializeXlsx, type ExportColumn } from '../lib/exportData'
import { parseCsvText } from '../parsers/csv'
import { parseJsonText } from '../parsers/json'
import { parseWorksheet } from '../parsers/xlsx'
import * as XLSX from 'xlsx'
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

function unpackZip(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decode = (start: number, length: number) => new TextDecoder().decode(bytes.slice(start, start + length))
  const end = bytes.length - 22
  const count = view.getUint16(end + 10, true)
  let cursor = view.getUint32(end + 16, true)
  const files: Record<string, string> = {}
  for (let index = 0; index < count; index += 1) {
    const size = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const name = decode(cursor + 46, nameLength)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const start = localOffset + 30 + localNameLength + localExtraLength
    files[name] = decode(start, size)
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return files
}

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
  it('applies the same validated seeded estimates in memory and DuckDB while preserving row order', async () => {
    const rows: DataRow[] = Array.from({ length: 200 }, (_, index) => ({ signal: index, amount: index * 3 + 1 }))
    for (let index = 0; index < rows.length; index += 7) rows[index]!.amount = null
    const recommendation = recommendMissingValues(rows, ['amount'], ['signal'], 20261025, {}, { amount: 'integer' })[0]
    expect(recommendation?.recommended).toBe(true)
    if (recommendation?.validation?.kind !== 'numeric') throw new Error('Expected numeric model validation metrics')
    const estimatedValues = JSON.stringify({ amount: recommendation!.estimates.map((estimate) => ({ rowIndex: estimate.sampleRow - 1, value: estimate.value, uncertainty: estimate.uncertainty })) })
    const decision: RiskyDecision = { kind: 'fill-missing', columns: ['amount'], options: { strategy: 'model-estimates', estimatedValues, targetType: 'integer', model: recommendation.validation.model, validation: JSON.stringify(recommendation.validation) } }
    const inMemory = executeRiskyDecision(rows, decision, [], false).rows

    connection.query('DROP VIEW IF EXISTS imputation_result')
    connection.query('DROP TABLE IF EXISTS imputation_result_values')
    connection.query('DROP TABLE IF EXISTS imputation_result_source')
    connection.query('CREATE TABLE imputation_result_source (signal BIGINT, amount DOUBLE, "__dc_order" BIGINT)')
    const values = rows.map((row, index) => `(${row.signal}, ${row.amount == null ? 'NULL' : row.amount}, ${index})`).join(', ')
    connection.query(`INSERT INTO imputation_result_source VALUES ${values}`)
    const training = connection.query('SELECT signal, amount, "__dc_order" FROM imputation_result_source WHERE amount IS NOT NULL ORDER BY "__dc_order"').toArray().map((row) => row.toJSON() as DataRow)
    const targets = connection.query('SELECT signal, amount, "__dc_order" FROM imputation_result_source WHERE amount IS NULL ORDER BY "__dc_order"').toArray().map((row) => row.toJSON() as DataRow)
    const duckEstimates: Array<{ rowOrder: number; value: DataRow[string]; uncertainty: number }> = []
    async function* pages() {
      for (let offset = 0; offset < targets.length; offset += 7) yield targets.slice(offset, offset + 7)
    }
    const batchResult = await processDuckDbEstimateBatches(pages(), {
      trainingRows: training, target: 'amount', features: ['signal'], targetType: 'integer', model: recommendation.validation.model, min: 4, max: 598, integerTarget: true, nonNegative: true,
      insertBatch: async (batch) => { duckEstimates.push(...batch) },
    })
    expect(batchResult).toMatchObject({ processedRows: targets.length, estimatedCells: targets.length, cancelled: false })
    expect(duckEstimates.map((estimate) => estimate.rowOrder)).toEqual(recommendation!.estimates.map((estimate) => estimate.sampleRow - 1))
    duckEstimates.forEach((estimate) => expect(estimate.value as number).toBe(Number(inMemory[estimate.rowOrder]?.amount)))
    connection.query('CREATE TABLE imputation_result_values ("__dc_order" BIGINT, "__dc_column" VARCHAR, "estimate_value" VARCHAR, "uncertainty" DOUBLE)')
    connection.query(`INSERT INTO imputation_result_values VALUES ${duckEstimates.map((estimate) => `(${estimate.rowOrder}, 'amount', ${quote(estimate.value)}, ${estimate.uncertainty})`).join(', ')}`)
    const view = buildDuckDbImputationViewSql('imputation_result_source', 'imputation_result_values', ['signal', 'amount'], 'amount', undefined, 'integer')
    connection.query(`CREATE VIEW imputation_result AS ${view}`)
    const duckRows = connection.query('SELECT signal, amount FROM imputation_result ORDER BY "__dc_order"').toArray().map((row) => row.toJSON() as DataRow)
    expect(canonicalRows(duckRows.map((row) => ({ ...row, signal: Number(row.signal) })))).toEqual(canonicalRows(inMemory))
    expect(duckEstimates).toHaveLength(rows.filter((row) => row.amount == null).length)
    connection.query('DROP VIEW imputation_result')
    connection.query('DROP TABLE imputation_result_values')
    connection.query('DROP TABLE imputation_result_source')
  })

  it('materializes estimated values as an undoable DuckDB view without mutating its source', () => {
    connection.query('DROP VIEW IF EXISTS estimate_version')
    connection.query('DROP TABLE IF EXISTS estimate_source')
    connection.query('DROP TABLE IF EXISTS estimate_values')
    connection.query('CREATE TABLE estimate_source ("name" VARCHAR, "target" VARCHAR, "__dc_order" BIGINT)')
    connection.query("INSERT INTO estimate_source VALUES ('missing', NULL, 0), ('observed', 'kept', 1)")
    connection.query('CREATE TABLE estimate_values ("__dc_order" BIGINT, "__dc_column" VARCHAR, "estimate_value" VARCHAR, "uncertainty" DOUBLE)')
    connection.query("INSERT INTO estimate_values VALUES (0, 'target', 'estimated', 0.1)")
    connection.query(`CREATE VIEW estimate_version AS ${buildDuckDbImputationViewSql('estimate_source', 'estimate_values', ['name', 'target'], 'target', 'target_was_missing')}`)
    const result = connection.query('SELECT * FROM estimate_version ORDER BY "__dc_order"').toArray().map((row) => row.toJSON())
    expect(result.map((row) => row.target)).toEqual(['estimated', 'kept'])
    expect(result.map((row) => row.target_was_missing)).toEqual([true, false])
    expect(connection.query('SELECT target FROM estimate_source ORDER BY "__dc_order"').toArray().map((row) => row.toJSON().target)).toEqual([null, 'kept'])
    connection.query('DROP VIEW estimate_version')
    connection.query('DROP TABLE estimate_values')
    connection.query('DROP TABLE estimate_source')
  })

  it('samples small DuckDB datasets fully and repeatably up to the configured cap', () => {
    connection.query('DROP TABLE IF EXISTS imputation_sample')
    connection.query('CREATE TABLE imputation_sample ("group name" VARCHAR, target VARCHAR, "__dc_order" BIGINT)')
    const values = Array.from({ length: 120 }, (_, index) => `('${index % 2 ? 'west' : 'east'}', '${index % 2 ? 'B' : 'A'}', ${index})`).join(', ')
    connection.query(`INSERT INTO imputation_sample VALUES ${values}`)
    const sampleSql = buildDuckDbImputationSampleSql(['group name', 'target'], 50_000, 'imputation_sample')
    const first = connection.query(sampleSql).toArray().map((row) => row.toJSON())
    const repeated = connection.query(sampleSql).toArray().map((row) => row.toJSON())
    expect(first).toHaveLength(120)
    expect(first).toEqual(repeated)
    expect(sampleSql).toContain('LIMIT 50000')
    expect(sampleSql).not.toContain('% 101')
    connection.query('DROP TABLE imputation_sample')
  })

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
  }, 15_000)

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
  it('produces identical CSV bytes from in-memory rows and DuckDB query rows', () => {
    const rows: DataRow[] = [{ name: 'Zoë, 東京', amount: 1250.75, note: 'line one\n"line two"' }, { name: null, amount: null, note: '' }]
    const columns = [{ source: 'name', name: 'name' }, { source: 'amount', name: 'amount' }, { source: 'note', name: 'note' }]
    connection.query('DROP TABLE IF EXISTS export_source')
    connection.query('CREATE TABLE export_source (name VARCHAR, amount DOUBLE, note VARCHAR, "__dc_order" BIGINT)')
    connection.query(`INSERT INTO export_source VALUES (${quote(rows[0]!.name)}, 1250.75, ${quote(rows[0]!.note)}, 0), (NULL, NULL, '', 1)`)
    const duckRows = connection.query('SELECT name, amount, note FROM export_source ORDER BY "__dc_order"').toArray().map((row) => row.toJSON() as DataRow)
    expect(serializeCsv(duckRows, columns)).toBe(serializeCsv(rows, columns))
  })

  it('round trips Global Library and train-shaped data through CSV, XLSX, and JSON on both engines', () => {
    const scenarios = [
      { name: 'global_roundtrip', fixture: globalLibraryFixture, expectedRows: 219, acceptDuplicates: false },
      { name: 'train_roundtrip', fixture: trainFixture, expectedRows: 119, acceptDuplicates: true },
    ]
    for (const scenario of scenarios) {
      const { rows, columns } = scenario.fixture()
      const originalProfile = profileDataset(rows, columns)
      const memoryClean = runSmartClean(rows, originalProfile)
      const duckClean = runDuckDbSmartClean(rows, columns, originalProfile, scenario.name)
      const memoryRows = memoryClean.rows
      const duckRows = canonicalRows(duckClean.rows)
      let memoryFinal = memoryRows
      let duckFinal = duckRows
      if (scenario.acceptDuplicates) {
        const decision: RiskyDecision = { kind: 'remove-duplicates', columns, options: { keys: [], keep: 'first' } }
        memoryFinal = executeRiskyDecision(memoryFinal, decision).rows
        const duplicateSql = buildRiskySelect(decision, duckClean.columns, [], duckClean.source)
        duckFinal = connection.query(duplicateSql).toArray().map((row) => cleanOrder(row.toJSON() as OrderedRow))
        expect(memoryFinal).toHaveLength(102)
        expect(duckFinal).toHaveLength(102)
      } else {
        expect(memoryFinal).toHaveLength(scenario.expectedRows)
        expect(duckFinal).toHaveLength(scenario.expectedRows)
      }
      const names = scenario.acceptDuplicates ? duckClean.columns : duckClean.columns
      const memoryProfile = profileDataset(memoryFinal, names)
      const types = new Map(memoryProfile.columns.map((column) => [column.name, column.inferredType]))
      const exportColumns: ExportColumn[] = names.map((name) => ({ source: name, name, type: types.get(name) }))
      expect(serializeCsv(duckFinal, exportColumns)).toBe(serializeCsv(memoryFinal, exportColumns))
      expect(serializeJson(duckFinal, exportColumns)).toBe(serializeJson(memoryFinal, exportColumns))
      const memoryXlsx = serializeXlsx(memoryFinal, exportColumns)
      const duckXlsx = serializeXlsx(duckFinal, exportColumns)
      const memoryBook = XLSX.read(memoryXlsx, { type: 'array', cellDates: true, raw: true })
      const duckBook = XLSX.read(duckXlsx, { type: 'array', cellDates: true, raw: true })
      expect(XLSX.utils.sheet_to_json(memoryBook.Sheets[memoryBook.SheetNames[0]!]!, { header: 1, raw: true, defval: null }))
        .toEqual(XLSX.utils.sheet_to_json(duckBook.Sheets[duckBook.SheetNames[0]!]!, { header: 1, raw: true, defval: null }))
      const csvImported = parseCsvText(serializeCsv(duckFinal, exportColumns))
      const jsonImported = parseJsonText(serializeJson(duckFinal, exportColumns))
      const xlsxImported = parseWorksheet(duckBook.Sheets[duckBook.SheetNames[0]!]!, 1)
      for (const imported of [csvImported, jsonImported, xlsxImported]) {
        expect(imported.rows).toHaveLength(memoryFinal.length)
        expect(imported.columns).toHaveLength(names.length)
        const importedProfile = profileDataset(imported.rows, imported.columns)
        expect(importedProfile.summary.rows).toBe(memoryFinal.length)
        expect(importedProfile.summary.columns).toBe(names.length)
      }
    }
  }, 30_000)

  it('normalizes day-first, month-first, and ISO dates with DuckDB expressions', () => {
    connection.query('DROP TABLE IF EXISTS date_source')
    connection.query("CREATE TABLE date_source (day_date VARCHAR, month_date VARCHAR, iso_date VARCHAR)")
    connection.query("INSERT INTO date_source VALUES ('20-03-2026','03/20/2026','2026-08-20'), ('31-02-2026','13/25/2026','not-a-date')")
    const day = buildDateNormalizationExpression('day_date', 'day-first')
    const month = buildDateNormalizationExpression('month_date', 'month-first')
    const iso = buildDateNormalizationExpression('iso_date', 'none')
    const result = connection.query(`SELECT ${day} AS day, ${month} AS month, ${iso} AS iso FROM date_source`).toArray().map((row) => row.toJSON())
    expect(result).toEqual([{ day: '2026-03-20', month: '2026-03-20', iso: '2026-08-20' }, { day: null, month: null, iso: 'not-a-date' }])
    const ambiguous = buildDateNormalizationExpression('month_date', 'ambiguous')
    const ambiguousRows = connection.query(`SELECT ${ambiguous} AS value FROM (VALUES ('03/04/2026'), ('31/02/2026')) AS t(month_date)`).toArray().map((row) => row.toJSON().value)
    expect(ambiguousRows).toEqual(['03/04/2026', null])
  })

  it.each(['trim-whitespace', 'normalize-missing', 'formatted-numbers', 'fix-type-mismatches'] as const)('matches in-memory Phase 2 values for %s', (kind) => {
    const values = kind === 'formatted-numbers' ? ['$1,200.50', '(€42)', '12.5%', '₹12,34,567.50', 'INR 1,250.75', '€1.234,56', '1,25 EUR', 'plain']
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
      { rows: [{ key: 'a', value: '10', category: 'A', date: '01/02/2024', lock: '守る' }, { key: 'b', value: null, category: 'A', date: '02/01/2024', lock: '守る' }, { key: 'c', value: '30', category: 'A', date: 'n/a', lock: '守る' }, { key: 'd', value: '100', category: 'B', date: 'x', lock: '守る' }, { key: 'e', value: null, category: 'B', date: 'x', lock: '守る' }, { key: 'f', value: '200', category: 'B', date: 'x', lock: '守る' }], decision: { kind: 'fill-missing', columns: ['value'], options: { strategy: 'group-median', groupBy: 'category' } } },
      { rows: [{ key: 'a', value: 'red', category: 'A', date: '01/02/2024', lock: '守る' }, { key: 'b', value: 'N/A', category: 'A', date: '02/01/2024', lock: '守る' }, { key: 'c', value: 'red', category: 'A', date: 'n/a', lock: '守る' }, { key: 'd', value: 'blue', category: 'B', date: 'x', lock: '守る' }, { key: 'e', value: null, category: 'B', date: 'x', lock: '守る' }, { key: 'f', value: 'green', category: 'B', date: 'x', lock: '守る' }], decision: { kind: 'fill-missing', columns: ['value'], options: { strategy: 'group-mode', groupBy: 'category' } } },
      { rows: [{ key: 'a', value: '1', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: 'N/A', category: 'yes', date: '02/01/2024', lock: '守る' }, { key: 'c', value: '3', category: 'No', date: 'n/a', lock: '守る' }], decision: { kind: 'fill-missing', columns: ['value'], options: { strategy: 'mean' } } },
      { rows: [{ key: 'a', value: 'A', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: 'N/A', category: 'yes', date: '02/01/2024', lock: '守る' }, { key: 'c', value: 'B', category: 'No', date: 'n/a', lock: '守る' }], decision: { kind: 'fill-missing', columns: ['value'], options: { strategy: 'mode' } } },
      { rows: [{ key: 'a', value: null, category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: null, category: 'yes', date: '02/01/2024', lock: '守る' }], decision: { kind: 'fill-missing', columns: ['value'], options: { strategy: 'median' } } },
      { rows: [{ key: 'a', value: 'A', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: 'N/A', category: 'yes', date: '02/01/2024', lock: '守る' }, { key: 'c', value: 'C', category: 'No', date: 'n/a', lock: '守る' }], decision: { kind: 'fill-missing', columns: ['value'], options: { strategy: 'forward-fill', orderedRows: true } } },
      { rows: [{ key: 'a', value: 'A', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: 'N/A', category: 'yes', date: '02/01/2024', lock: '守る' }], decision: { kind: 'fill-missing', columns: ['value'], options: { strategy: 'constant', value: '固定' } } },
      { rows: [{ key: 'a', value: 'A', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: 'N/A', category: 'yes', date: '02/01/2024', lock: '守る' }], decision: { kind: 'fill-missing', columns: ['value'], options: { strategy: 'drop-rows' } } },
      { rows: [{ key: 'a', value: '1', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: '2', category: 'yes', date: '02/01/2024', lock: '守る' }, { key: 'c', value: '3', category: 'No', date: 'n/a', lock: '守る' }, { key: 'd', value: '100', category: 'no', date: 'x', lock: '守る' }], decision: { kind: 'handle-outliers', columns: ['value'], options: { action: 'cap' } } },
      { rows: [{ key: 'a', value: '1', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: '2', category: 'yes', date: '02/01/2024', lock: '守る' }, { key: 'c', value: '3', category: 'No', date: 'n/a', lock: '守る' }, { key: 'd', value: '100', category: 'no', date: 'x', lock: '守る' }], decision: { kind: 'handle-outliers', columns: ['value'], options: { action: 'remove' } } },
      { rows: [{ key: 'a', value: '4', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: '4', category: 'yes', date: '02/01/2024', lock: '守る' }, { key: 'c', value: '4', category: 'No', date: 'n/a', lock: '守る' }, { key: 'd', value: '4', category: 'no', date: 'x', lock: '守る' }], decision: { kind: 'handle-outliers', columns: ['value'], options: { action: 'flag' } } },
      { rows: [{ key: 'a', value: '1', category: 'YES', date: '01/02/2024', lock: '守る' }, { key: 'b', value: '2', category: 'yes', date: '02/01/2024', lock: '守る' }, { key: 'c', value: '3', category: 'No', date: 'n/a', lock: '守る' }, { key: 'd', value: '100', category: 'no', date: 'x', lock: '守る' }], decision: { kind: 'handle-outliers', columns: ['value'], options: { action: 'flag' } } },
      { rows: [{ key: 'a', value: '1', category: '東京', date: '01/02/2024', lock: '守る' }, { key: 'b', value: '2', category: '東京', date: '02/01/2024', lock: '守る' }], decision: { kind: 'standardize-categories', columns: ['category'], options: { mapping: '{"東京":"東京・東"}' } } },
      { rows: [{ key: 'a', value: '-2', category: 'YES', date: '2024-01-01', lock: '守る' }, { key: 'b', value: '3', category: 'no', date: '2024-01-02', lock: '守る' }], decision: { kind: 'resolve-validation', columns: ['value'], options: { action: 'absolute' } } },
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

  it('repairs the supported mojibake corpus identically in DuckDB and memory', () => {
    const values = ['FranÃ§ais', 'ordinary text', 'â€™']
    connection.query('DROP TABLE IF EXISTS repair_input')
    connection.query(`CREATE TABLE repair_input AS SELECT * FROM (VALUES ${values.map((value, index) => `('${value.replaceAll("'", "''")}', ${index})`).join(',')}) AS v(value, __dc_order)`)
    const expr = buildMojibakeRepairExpression('value')
    const actual = connection.query(`SELECT ${expr} AS value FROM repair_input ORDER BY __dc_order`).toArray().map((row) => row.toJSON().value)
    expect(actual).toEqual(values.map((value) => transformValue('repair-mojibake', value)))
    connection.query('DROP TABLE repair_input')
  })

  it('canonicalizes category punctuation and case identically in memory and DuckDB', () => {
    const values = ['north-west', 'north-west', 'North West', 'North West', 'North West', 'NORTH-WEST', 'Northeast']
    const rows: DataRow[] = values.map((category) => ({ Category: category }))
    const memoryMap = buildCategoryMapping(rows, 'Category')
    connection.query('DROP TABLE IF EXISTS category_source')
    connection.query(`CREATE TABLE category_source AS SELECT * FROM (VALUES ${values.map((value, index) => `('${value}', ${index})`).join(',')}) AS v(Category, __dc_order)`)
    const variants = connection.query('SELECT Category AS value, COUNT(*) AS n FROM category_source GROUP BY Category').toArray().map((row) => row.toJSON())
    const duckMap = buildCategoryMappingFromCounts(variants.map((row) => [String(row.value), Number(row.n)] as const))
    const expression = buildCategoryCaseExpression('Category', duckMap)
    const actual = connection.query(`SELECT ${expression} AS Category FROM category_source ORDER BY __dc_order`).toArray().map((row) => row.toJSON().Category)
    const expected = values.map((value) => memoryMap.get(value) ?? value)
    expect(actual).toEqual(expected)
    connection.query('DROP TABLE category_source')
  })

  it('pages changed DuckDB cells against immutable original columns after renaming', () => {
    for (const kind of ['VIEW', 'TABLE'] as const) {
      connection.query(`DROP ${kind} IF EXISTS dataset`)
      connection.query(`DROP ${kind} IF EXISTS dataset_original`)
    }
    connection.query(`CREATE TABLE dataset_original AS SELECT * FROM (VALUES ('  old  ', 0), (NULL, 1)) AS t("Order ID", "__dc_order")`)
    connection.query('CREATE VIEW dataset AS SELECT CASE WHEN "__dc_order" = 0 THEN TRIM("Order ID") ELSE \'new\' END AS "Order_ID", "__dc_order" FROM dataset_original')
    const sql = buildDuckDbCompareSql([{ original: 'Order ID', cleaned: 'Order_ID', display: 'Order_ID' }], 1, 0)
    const first = connection.query(sql).toArray().map((row) => row.toJSON())
    const second = connection.query(buildDuckDbCompareSql([{ original: 'Order ID', cleaned: 'Order_ID', display: 'Order_ID' }], 1, 1)).toArray().map((row) => row.toJSON())
    const count = connection.query(buildDuckDbCompareCountSql([{ original: 'Order ID', cleaned: 'Order_ID', display: 'Order_ID' }])).toArray().map((row) => row.toJSON())
    const afterCursor = connection.query(buildDuckDbCompareAfterSql([{ original: 'Order ID', cleaned: 'Order_ID', display: 'Order_ID' }], 1, { rowId: 0, column: 'Order_ID' })).toArray().map((row) => row.toJSON())
    expect(first).toEqual([{ row_id: 0, column: 'Order_ID', before: '  old  ', after: 'old' }])
    expect(second).toEqual([{ row_id: 1, column: 'Order_ID', before: null, after: 'new' }])
    expect(Number(count[0]?.count)).toBe(2)
    expect(afterCursor).toEqual([{ row_id: 1, column: 'Order_ID', before: null, after: 'new' }])
    connection.query('DROP VIEW dataset')
    connection.query('DROP TABLE dataset_original')
  })

  it('streams a DuckDB cleaned file, all changed cells, report, and recipe into one ZIP', async () => {
    connection.query('DROP VIEW IF EXISTS dataset'); connection.query('DROP TABLE IF EXISTS dataset_original')
    connection.query(`CREATE TABLE dataset_original AS SELECT * FROM (VALUES ('  a, "x"  ', 0), ('same', 1)) AS t(value, "__dc_order")`)
    connection.query('CREATE VIEW dataset AS SELECT TRIM(value) AS value, "__dc_order" FROM dataset_original')
    const compareColumns = [{ original: 'value', cleaned: 'value', display: 'value' }]
    const changedCells = Number(connection.query(buildDuckDbCompareCountSql(compareColumns)).toArray()[0]?.toJSON().count)
    const bundle = new DuckDbBundleSession({ requestId: 'zip-test', format: 'csv', columns: [{ source: 'value', name: 'value', type: 'text' }],
      fileName: 'sample_cleaned.csv', report: '# Report', recipe: '{"rules":[]}', ruleByColumn: { value: 'Trim whitespace' }, stepByColumn: { value: 1 },
      bom: false, cleanRows: 2, changedCells, compareColumns })
    const parts: Uint8Array[] = []
    const progress: number[] = []
    let done = false
    while (!done) {
      const result = await bundle.next(async (sql) => connection.query(sql).toArray().map((row) => row.toJSON() as Record<string, unknown>))
      parts.push(result.bytes); progress.push(result.rowsProcessed); done = result.done
    }
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
    let offset = 0
    for (const part of parts) { bytes.set(part, offset); offset += part.length }
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    expect(unpackZip(bytes)).toEqual({
      'sample_cleaned.csv': 'value\r\n"a, ""x"""\r\nsame\r\n',
      'changes.csv': 'row_id,column,before,after,rule,step\r\n1,value,"  a, ""x""  ","a, ""x""",Trim whitespace,1\r\n',
      'cleaning-report.md': '# Report',
      'recipe.json': '{"rules":[]}',
    })
    connection.query('DROP VIEW dataset'); connection.query('DROP TABLE dataset_original')
  })

  it('caps DuckDB bundle data pages by a bounded cell batch for very wide datasets', async () => {
    const columns = Array.from({ length: 1000 }, (_, index) => ({ source: `c${index}`, name: `c${index}`, type: 'text' as const }))
    const bundle = new DuckDbBundleSession({ requestId: 'wide-zip-test', format: 'csv', columns, fileName: 'wide.csv', report: '', recipe: '{}',
      ruleByColumn: {}, stepByColumn: {}, bom: false, cleanRows: 1000, changedCells: 0, compareColumns: [] })
    await bundle.next(async () => []) // local header
    let pageQuery = ''
    await bundle.next(async (sql) => { pageQuery = sql; return [] })
    expect(pageQuery).toContain('LIMIT 250')
  })

  it('streams removed DuckDB rows with the first version that removed each row', () => {
    for (const [kind, name] of [['VIEW', 'dataset'], ['VIEW', 'removed_clean'], ['TABLE', 'removed_source']] as const) connection.query(`DROP ${kind} IF EXISTS ${name}`)
    connection.query(`CREATE TABLE removed_source AS SELECT * FROM (VALUES ('keep', 0), ('duplicate', 1), ('keep', 2)) AS t(value, "__dc_order")`)
    connection.query('CREATE VIEW removed_clean AS SELECT * FROM removed_source WHERE "__dc_order" <> 1')
    connection.query('CREATE VIEW dataset AS SELECT * FROM removed_clean')
    const sql = buildDuckDbRemovedRowsSql([{ table: 'removed_source', removedBy: 'Original' }, { table: 'removed_clean', removedBy: 'Remove duplicates' }], ['value'], 10, 0)
    const removed = connection.query(sql).toArray().map((row) => row.toJSON())
    expect(removed).toEqual([{ row_id: 1, removal_rule: 'Remove duplicates', value: 'duplicate' }])
    connection.query('DROP VIEW dataset'); connection.query('DROP VIEW removed_clean'); connection.query('DROP TABLE removed_source')
  })

  it('casts profiled large-export columns into JSON scalar types in DuckDB', () => {
    connection.query('DROP TABLE IF EXISTS json_export_source')
    connection.query('CREATE TABLE json_export_source AS SELECT * FROM (VALUES (\'1234.5\', \'7\', \'true\', \'NaN\')) AS t("Revenue", "Count", "Enabled", "Unparseable")')
    const projection = buildDuckDbJsonExportProjection([
      { source: 'Revenue', type: 'float' }, { source: 'Count', type: 'integer' }, { source: 'Enabled', type: 'boolean' }, { source: 'Unparseable', type: 'float' },
    ])
    const row = connection.query(`SELECT ${projection} FROM json_export_source`).toArray()[0]!.toJSON()
    expect(row).toMatchObject({ Revenue: 1234.5, Count: 7, Enabled: true })
    expect(normalizeDuckDbJsonValue(row.Unparseable)).toBeNull()
    expect(JSON.parse(JSON.stringify({ Revenue: normalizeDuckDbJsonValue(row.Revenue), Count: normalizeDuckDbJsonValue(row.Count), Enabled: normalizeDuckDbJsonValue(row.Enabled), Unparseable: normalizeDuckDbJsonValue(row.Unparseable) }))).toEqual({ Revenue: 1234.5, Count: 7, Enabled: true, Unparseable: null })
    connection.query('DROP TABLE json_export_source')
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
