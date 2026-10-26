// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import * as duckdb from '@duckdb/duckdb-wasm/dist/duckdb-node-blocking'
import { buildLowRiskExpression } from './lowRiskSql'
import { buildRiskySelect, quoteSqlIdentifier, quoteSqlString } from './riskySql'
import { buildDuckDbImputationViewSql, processDuckDbEstimateBatches } from './duckdbImputation'
import { recommendMissingValues, selectImputationTrainingSample } from './localImputation'
import { buildDuckDbCompareCountSql } from './duckdbCompare'
import { DuckDbBundleSession } from './duckdbBundle'
import type { DataRow, RiskyDecision } from '../types'

const rowCount = 100_000
const columnCount = 1_000
let database: Awaited<ReturnType<typeof duckdb.createDuckDB>>
let connection: duckdb.DuckDBConnection
let peakRss = process.memoryUsage().rss
let sampler: ReturnType<typeof setInterval>

beforeAll(async () => {
  const dist = resolve(process.cwd(), 'node_modules/@duckdb/duckdb-wasm/dist')
  database = await duckdb.createDuckDB({ mvp: { mainModule: resolve(dist, 'duckdb-mvp.wasm'), mainWorker: resolve(dist, 'duckdb-node-mvp.worker.cjs') } }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME)
  await database.instantiate()
  database.open({})
  connection = database.connect()
  connection.query('SET max_expression_depth = 10000')
  sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 20)
}, 30_000)

afterAll(() => { clearInterval(sampler); connection?.close(); database?.reset() })

const value = (column: number): string => {
  switch (column) {
    case 0: return `CASE WHEN i % 19 = 0 THEN ' N/A ' ELSE '  value ' || CAST(i % 8 AS VARCHAR) || '  ' END AS ${quoteSqlIdentifier(`column_${column}`)}`
    case 1: return `CASE WHEN i % 13 = 0 THEN '$1,250.50' ELSE CAST(i % 500 AS VARCHAR) END AS ${quoteSqlIdentifier(`column_${column}`)}`
    case 2: return `CASE WHEN i % 2 = 0 THEN '01/02/2024' ELSE '13/02/2024' END AS ${quoteSqlIdentifier(`column_${column}`)}`
    case 3: return `CASE WHEN i % 1000 = 0 THEN '1000000' ELSE '4' END AS ${quoteSqlIdentifier(`column_${column}`)}`
    case 4: return `CASE WHEN i % 2 = 0 THEN 'YES' ELSE 'yes' END AS ${quoteSqlIdentifier(`column_${column}`)}`
    case 5: return `CAST(i % 99999 AS VARCHAR) AS ${quoteSqlIdentifier(`column_${column}`)}`
    case 6: return `'protected-' || CAST(i AS VARCHAR) AS ${quoteSqlIdentifier(`column_${column}`)}`
    default: return `i % 4 AS ${quoteSqlIdentifier(`column_${column}`)}`
  }
}

function queryRows(sql: string): Array<Record<string, unknown>> {
  return connection.query(sql).toArray().map((row) => row.toJSON() as Record<string, unknown>)
}
function setActive(source: string): void {
  connection.query('DROP VIEW IF EXISTS scale_active')
  connection.query(`CREATE VIEW scale_active AS SELECT * FROM ${source}`)
}

describe('combined DuckDB scale path (run with npm run test:scale)', () => {
  it('runs Smart Clean, accepts all risky groups, protects a column, and restores the immutable original', () => {
    const started = performance.now()
    const columns = Array.from({ length: columnCount }, (_, index) => `column_${index}`)
    const projection = columns.map((_, index) => value(index)).join(', ')
    connection.query('DROP TABLE IF EXISTS scale_original')
    connection.query('DROP VIEW IF EXISTS scale_active')
    connection.query(`CREATE TABLE scale_original AS SELECT ${projection}, i AS "__dc_order" FROM range(${rowCount}) AS input(i)`)
    const sourceFingerprint = queryRows('SELECT COUNT(*) AS rows, SUM(hash(column_0)) AS fingerprint FROM scale_original')[0]
    setActive('scale_original')
    const protectedName = 'column_6'

    // Smart Clean's deterministic batch expressions, in a single projection per rule.
    const lowRisk = ['trim-whitespace', 'normalize-missing', 'formatted-numbers', 'fix-type-mismatches'] as const
    let previous = 'scale_original'
    const versions: string[] = [previous]
    let step = 0
    for (const rule of lowRisk) {
      const selected = rule === 'trim-whitespace' || rule === 'normalize-missing' ? [columns[0]!] : rule === 'formatted-numbers' ? [columns[1]!] : []
      if (!selected.length) continue
      const next = `scale_v${++step}`
      const sql = `CREATE VIEW ${next} AS SELECT ${columns.map((name) => `${selected.includes(name) ? buildLowRiskExpression(rule, name) : quoteSqlIdentifier(name)} AS ${quoteSqlIdentifier(name)}`).join(', ')}, "__dc_order" FROM ${previous}`
      connection.query(sql)
      previous = next; versions.push(next)
      setActive(next)
    }
    connection.query(`CREATE VIEW scale_smart_clean AS SELECT * FROM ${previous}`)
    previous = 'scale_smart_clean'; versions.push(previous); setActive(previous)

    // Each proposal is one dataset-wide decision; the generated DuckDB SQL is the same
    // builder exercised by the small parity suite. Protected columns remain excluded.
    const decisions: RiskyDecision[] = [
      { kind: 'remove-duplicates', columns, options: { keys: [columns[5]!], keep: 'first' } },
      { kind: 'fill-missing', columns: [columns[0]!], options: { strategy: 'constant', value: 'filled' } },
      { kind: 'handle-outliers', columns: [columns[3]!], options: { action: 'cap' } },
      { kind: 'standardize-categories', columns: [columns[4]!], options: { mapping: '{"YES":"yes"}' } },
      { kind: 'resolve-ambiguous-dates', columns: [columns[2]!], options: { order: 'day-first' } },
    ]
    for (const decision of decisions) {
      const next = `scale_v${++step}`
      connection.query(`CREATE VIEW ${next} AS ${buildRiskySelect(decision, columns, [protectedName], previous)}`)
      previous = next; versions.push(next); setActive(next)
      // Force each lazy DuckDB version to execute before advancing, equivalent to a
      // dry-run/apply boundary and catches SQL failures without materializing copies.
      queryRows(`SELECT COUNT(*) AS count FROM ${previous}`)
    }
    const after = queryRows(`SELECT COUNT(*) AS rows, SUM(hash(column_0)) AS fingerprint FROM ${previous}`)[0]
    expect(Number(after?.rows)).toBeLessThanOrEqual(Number(sourceFingerprint?.rows))
    expect(Number(queryRows(`SELECT COUNT(*) AS changed FROM ${previous} a JOIN scale_original b USING ("__dc_order") WHERE a.${quoteSqlIdentifier(protectedName)} IS DISTINCT FROM b.${quoteSqlIdentifier(protectedName)}`)[0]?.changed)).toBe(0)

    // Undo each step by selecting the prior view, then reset to the immutable table.
    for (const version of [...versions].reverse()) {
      setActive(version)
    }
    setActive('scale_original')
    const restored = queryRows('SELECT COUNT(*) AS rows, SUM(hash(column_0)) AS fingerprint FROM scale_active')[0]
    expect(restored).toEqual(sourceFingerprint)
    const activeDefinition = String(queryRows("SELECT view_definition FROM information_schema.views WHERE table_name = 'scale_active'")[0]?.view_definition ?? '')
    expect(activeDefinition.toLowerCase()).toContain('scale_original')
    console.log(JSON.stringify({ scaleSeconds: Number(((performance.now() - started) / 1000).toFixed(2)), peakRssBytes: peakRss, rows: rowCount, columns: columnCount, riskyDecisionsAccepted: decisions.length, restoredExactly: true }))
  }, 600_000)

  it('validates and applies estimates to a 100k-row DuckDB dataset in bounded pages', async () => {
    const started = performance.now()
    connection.query('DROP VIEW IF EXISTS estimate_scale_result')
    connection.query('DROP TABLE IF EXISTS estimate_scale_values')
    connection.query('DROP TABLE IF EXISTS estimate_scale_source')
    connection.query(`CREATE TABLE estimate_scale_source AS SELECT i AS signal, CASE WHEN i % 20 = 0 THEN NULL ELSE i * 3 + 1 END AS target, i AS "__dc_order" FROM range(${rowCount}) AS source(i)`)
    const sampled = queryRows(`SELECT signal, target, "__dc_order" FROM estimate_scale_source ORDER BY HASH("__dc_order"), "__dc_order" LIMIT 50000`) as DataRow[]
    const seed = 101
    const [recommendation] = recommendMissingValues(sampled, ['target'], ['signal'], seed, { target: 5 }, { target: 'integer' }, 5000)
    expect(recommendation?.recommended).toBe(true)
    expect(recommendation?.validation).toMatchObject({ kind: 'numeric', model: 'ridge-regression' })
    const trainingRows = selectImputationTrainingSample(sampled, seed, 5000)
    connection.query('CREATE TABLE estimate_scale_values ("__dc_order" BIGINT, "__dc_column" VARCHAR, "estimate_value" VARCHAR, "uncertainty" DOUBLE)')
    let cursor = -1
    async function* targetPages() {
      while (true) {
        const batch = queryRows(`SELECT signal, target, "__dc_order" FROM estimate_scale_source WHERE target IS NULL AND "__dc_order" > ${cursor} ORDER BY "__dc_order" LIMIT 2000`) as DataRow[]
        if (!batch.length) return
        cursor = Number(batch[batch.length - 1]?.__dc_order ?? cursor)
        yield batch
      }
    }
    let lastProcessed = 0
    const batchResult = await processDuckDbEstimateBatches(targetPages(), {
      trainingRows, target: 'target', features: ['signal'], targetType: 'integer', model: recommendation?.validation?.kind === 'numeric' ? recommendation.validation.model : 'weighted-knn', integerTarget: true, nonNegative: true,
      insertBatch: async (batch) => { connection.query(`INSERT INTO estimate_scale_values VALUES ${batch.map((item) => `(${item.rowOrder}, 'target', ${quoteSqlString(String(item.value))}, ${item.uncertainty})`).join(', ')}`) },
      onProgress: (processed) => { expect(processed).toBeGreaterThan(lastProcessed); lastProcessed = processed },
    })
    expect(batchResult).toMatchObject({ processedRows: 5000, estimatedCells: 5000, cancelled: false })
    connection.query(`CREATE VIEW estimate_scale_result AS ${buildDuckDbImputationViewSql('estimate_scale_source', 'estimate_scale_values', ['signal', 'target'], 'target', undefined, 'integer')}`)
    const profileCounts = queryRows('SELECT COUNT(*) AS rows, COUNT(*) FILTER (WHERE target IS NULL) AS nulls FROM estimate_scale_result')[0]
    const originalNulls = queryRows('SELECT COUNT(*) FILTER (WHERE target IS NULL) AS nulls FROM estimate_scale_source')[0]
    expect(Number(profileCounts?.rows)).toBe(rowCount)
    expect(Number(profileCounts?.nulls)).toBe(0)
    expect(Number(originalNulls?.nulls)).toBe(5000)
    console.log(JSON.stringify({ estimateSeconds: Number(((performance.now() - started) / 1000).toFixed(2)), peakRssBytes: peakRss, rows: rowCount, trainingRows: trainingRows.length, model: recommendation!.validation!.model, processedRows: batchResult.processedRows, cellsEstimated: batchResult.estimatedCells }))
    connection.query('DROP VIEW estimate_scale_result'); connection.query('DROP TABLE estimate_scale_values'); connection.query('DROP TABLE estimate_scale_source')
  }, 600_000)

  it('streams a generated 1M-row DuckDB bundle in bounded chunks without retaining the archive', async () => {
    const started = performance.now()
    const rows = 1_000_000
    for (const [kind, name] of [['VIEW', 'dataset'], ['TABLE', 'dataset_original']] as const) connection.query(`DROP ${kind} IF EXISTS ${name}`)
    connection.query(`CREATE TABLE dataset_original AS SELECT CAST(i AS BIGINT) AS id, CAST(i AS VARCHAR) AS value, i AS "__dc_order" FROM range(${rows}) AS source(i)`)
    connection.query('CREATE VIEW dataset AS SELECT id, CASE WHEN "__dc_order" = 0 THEN \'changed\' ELSE value END AS value, "__dc_order" FROM dataset_original')
    const compareColumns = [{ original: 'value', cleaned: 'value', display: 'value' }]
    const changedCells = Number(queryRows(buildDuckDbCompareCountSql(compareColumns))[0]?.count)
    const session = new DuckDbBundleSession({ requestId: 'million-scale', format: 'csv', columns: [{ source: 'id', name: 'id', type: 'integer' }, { source: 'value', name: 'value', type: 'text' }],
      fileName: 'million.csv', report: '# report', recipe: '{}', ruleByColumn: { value: 'Trim whitespace' }, stepByColumn: { value: 1 }, bom: false,
      cleanRows: rows, changedCells, compareColumns })
    let bytesWritten = 0
    let maxChunkBytes = 0
    let chunks = 0
    let lastRowsProcessed = 0
    let done = false
    while (!done) {
      const result = await session.next(async (sql) => queryRows(sql))
      bytesWritten += result.bytes.byteLength
      maxChunkBytes = Math.max(maxChunkBytes, result.bytes.byteLength)
      chunks += 1
      expect(result.rowsProcessed).toBeGreaterThanOrEqual(lastRowsProcessed)
      lastRowsProcessed = result.rowsProcessed
      done = result.done
    }
    expect(changedCells).toBe(1)
    expect(lastRowsProcessed).toBe(rows + 1)
    expect(chunks).toBeGreaterThan(200)
    expect(maxChunkBytes).toBeLessThan(1_000_000)
    expect(bytesWritten).toBeGreaterThan(10_000_000)
    console.log(JSON.stringify({ bundleSeconds: Number(((performance.now() - started) / 1000).toFixed(2)), peakRssBytes: peakRss, rows, bytesWritten, maxChunkBytes, chunks }))
    connection.query('DROP VIEW dataset'); connection.query('DROP TABLE dataset_original')
  }, 600_000)
})
