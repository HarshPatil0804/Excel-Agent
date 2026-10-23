// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import * as duckdb from '@duckdb/duckdb-wasm/dist/duckdb-node-blocking'
import { buildLowRiskExpression } from './lowRiskSql'
import { buildRiskySelect, quoteSqlIdentifier } from './riskySql'
import type { RiskyDecision } from '../types'

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
})
