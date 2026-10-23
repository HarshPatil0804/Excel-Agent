/// <reference lib="webworker" />
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import * as duckdb from '@duckdb/duckdb-wasm'
import duckdbWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import duckdbWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import { decodeTextBuffer, parseCsvText } from '../parsers/csv'
import { takeFullBatches } from '../parsers/batching'
import { parseJsonText } from '../parsers/json'
import { inspectWorksheet, parseWorksheet } from '../parsers/xlsx'
import { profileDataset, profileResultSchema } from '../profiler/profile'
import { buildSmartCleanPlan, LOW_RISK_RULES, RISKY_RULES, runSmartClean } from '../engine/smartClean'
import { normalizeColumnName } from '../cleaners/rules'
import { executeRiskyDecision, makeChangeStep } from '../engine/riskyDecisions'
import { buildRiskySelect } from '../engine/riskySql'
import { buildLowRiskExpression } from '../engine/lowRiskSql'
import type { DataFormat, DataRow, DataValue } from '../types'
import type { RiskyDecision } from '../types'

const LARGE_FILE_BYTES = 50 * 1024 * 1024
const BATCH_ROWS = 50_000
type WorkerRequest = { type: 'parse'; file: File } | { type: 'inspect-xlsx-sheet'; sheet: string } | { type: 'continue-xlsx'; sheet: string; headerRow: number } | { type: 'smart-clean'; profile: ReturnType<typeof profileResultSchema.parse>; protectedColumns: string[]; rows?: DataRow[]; rules?: import('../types').CleaningRule[] } | { type: 'dry-run-risky'; decision: RiskyDecision; rows?: DataRow[]; profile: ReturnType<typeof profileResultSchema.parse>; protectedColumns: string[] } | { type: 'apply-risky'; decision: RiskyDecision; rows?: DataRow[]; profile: ReturnType<typeof profileResultSchema.parse>; protectedColumns: string[] } | { type: 'history'; action: 'undo' | 'redo' | 'reset' } | { type: 'cancel' }
type WorkerResponse = Record<string, unknown>
const send = (message: WorkerResponse): void => self.postMessage(message)
let pendingWorkbook: XLSX.WorkBook | null = null
let pendingWorkbookFormat: DataFormat = 'xlsx'
let activeDb: duckdb.AsyncDuckDB | null = null
let activeConnection: duckdb.AsyncDuckDBConnection | null = null
let activeAbort: (() => void) | null = null
let cancellationRequested = false
let largeColumns: string[] = []
let originalLargeColumns: string[] = []
let largeStableIds = new Map<string, string>()
let originalLargeStableIds = new Map<string, string>()
let largeInitialProfile: ReturnType<typeof profileResultSchema.parse> | null = null
let largeFormat: DataFormat = 'csv'
let largeRaggedRows = 0
let largeVersions: string[] = []
let largeHistoryCursor = 0
let largeVersionNumber = 0

function formatFromFile(file: File): DataFormat {
  const extension = file.name.split('.').at(-1)?.toLowerCase()
  if (extension === 'csv' || extension === 'tsv' || extension === 'xlsx' || extension === 'xls' || extension === 'json') return extension
  throw new Error('Choose a CSV, TSV, XLSX, XLS, or JSON file.')
}

function isMemoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /out of memory|memory access out of bounds|allocation failed|wasm.*memory/i.test(message)
}

async function parseWorkbook(file: File, format: DataFormat): Promise<void> {
  const bytes = await file.arrayBuffer()
  pendingWorkbookFormat = format
  pendingWorkbook = XLSX.read(bytes, { type: 'array', cellDates: true, dense: true })
  if (!pendingWorkbook.SheetNames.length) throw new Error('This workbook does not contain any worksheets.')
  const firstSheet = pendingWorkbook.Sheets[pendingWorkbook.SheetNames[0]!]
  const inspection = inspectWorksheet(firstSheet!)
  send({ type: 'workbook-inspected', sheets: pendingWorkbook.SheetNames, sheet: pendingWorkbook.SheetNames[0], ...inspection, sizeBytes: file.size })
}

function sqlIdentifier(name: string): string { return `"${name.replaceAll('"', '""')}"` }
function sqlValue(value: DataValue): string { return value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'` }

async function createDuckDb(): Promise<{ db: duckdb.AsyncDuckDB; connection: duckdb.AsyncDuckDBConnection }> {
  const worker = new Worker(duckdbWorkerUrl)
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker)
  try {
    await db.instantiate(duckdbWasmUrl)
    const connection = await db.connect()
    activeDb = db
    activeConnection = connection
    return { db, connection }
  } catch (error) {
    await db.terminate().catch(() => undefined)
    throw error
  }
}

async function queryRows(connection: duckdb.AsyncDuckDBConnection, sql: string): Promise<Array<Record<string, unknown>>> {
  const table = await connection.query(sql)
  return table.toArray().map((row) => row.toJSON() as Record<string, unknown>)
}

async function runLargeCsv(file: File, format: DataFormat): Promise<void> {
  cancellationRequested = false
  const sniff = decodeTextBuffer(await file.slice(0, Math.min(file.size, 64 * 1024)).arrayBuffer())
  if (cancellationRequested) return
  const { db, connection } = await createDuckDb()
  if (cancellationRequested) {
    await connection.close().catch(() => undefined)
    await db.terminate().catch(() => undefined)
    activeConnection = null
    activeDb = null
    return
  }
  const started = performance.now()
  let columns: string[] = []
  let delimiter = format === 'tsv' ? '\t' : ''
  const pendingRows: DataRow[] = []
  let rowsProcessed = 0
  let raggedRows = 0
  let initialized = false
  let batchRows = BATCH_ROWS
  let initPromise: Promise<void> | null = null
  let insertQueue = Promise.resolve()
  const preview: DataRow[] = []
  const createTable = async (): Promise<void> => {
    const definition = [...columns.map((column) => `${sqlIdentifier(column)} VARCHAR`), '"__dc_order" BIGINT'].join(', ')
    await connection.query(`CREATE TABLE dataset (${definition})`)
    initialized = true
  }
  const insertBatch = async (batch: DataRow[]): Promise<void> => {
    if (!batch.length) return
    if (initPromise) await initPromise
    const startOrder = rowsProcessed
    const values = batch.map((row, index) => `(${[...columns.map((column) => sqlValue(row[column] ?? null)), String(startOrder + index)].join(',')})`).join(',')
    await connection.query(`INSERT INTO dataset VALUES ${values}`)
    rowsProcessed += batch.length
    const elapsed = Math.max(performance.now() - started, 1)
    const estimatedRows = Math.max(rowsProcessed, Math.ceil(file.size / Math.max(batch.reduce((sum, row) => sum + JSON.stringify(row).length, 0) / batch.length, 1)))
    const etaSeconds = Math.max(0, Math.ceil(((estimatedRows - rowsProcessed) / (rowsProcessed / elapsed)) / 1000))
    send({ type: 'progress', rowsProcessed, estimatedSecondsRemaining: etaSeconds, percent: Math.min(99, Math.max(1, Math.round(rowsProcessed / estimatedRows * 100))) })
  }
  const queueFullBatches = (): boolean => {
    const batches = takeFullBatches(pendingRows, batchRows)
    for (const batch of batches) {
      insertQueue = insertQueue.then(() => insertBatch(batch))
    }
    return batches.length > 0
  }
  const flushRemaining = async (): Promise<void> => {
    await insertQueue
    if (pendingRows.length) {
      const batch = pendingRows.splice(0, pendingRows.length)
      await insertBatch(batch)
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      Papa.parse<DataRow>(file, {
        header: true,
        encoding: sniff.encoding === 'latin-1' ? 'ISO-8859-1' : sniff.encoding,
        delimiter,
        skipEmptyLines: false,
        chunkSize: 1 * 1024 * 1024,
        delimitersToGuess: [',', '\t', ';', '|'],
        chunk: (result, parser) => {
          activeAbort = () => parser.abort()
          if (cancellationRequested) { parser.abort(); return }
          const fields = result.meta.fields ?? []
          if (!columns.length) {
            columns = fields.map((field, index) => field.trim() || `Column ${index + 1}`)
            batchRows = Math.max(1, Math.min(BATCH_ROWS, Math.floor(250_000 / Math.max(columns.length, 1))))
            delimiter = result.meta.delimiter || delimiter || ','
            if (!columns.length) { parser.abort(); reject(new Error('We could not find a header row in this file.')); return }
            initPromise = createTable()
            void initPromise.catch(reject)
          }
          raggedRows += result.errors.filter((error) => error.code === 'TooManyFields' || error.code === 'TooFewFields').length
          for (const rawRow of result.data) {
            const row: DataRow = {}
            columns.forEach((column, index) => { row[column] = rawRow[fields[index] ?? column] ?? null })
            if (preview.length < 1000) preview.push(row)
            pendingRows.push(row)
          }
          const fullBatchQueued = queueFullBatches()
          if (fullBatchQueued) {
            parser.pause()
            void insertQueue.then(() => parser.resume(), reject)
          }
        },
        complete: () => {
          if (!columns.length) reject(new Error('This file is empty or contains no data rows.'))
          else void flushRemaining().then(resolve, reject)
        },
        error: reject,
      })
    })
    if (!initialized || rowsProcessed === 0) throw new Error('This file is empty or contains no data rows.')
    largeColumns = columns
    largeStableIds = new Map(columns.map((name, index) => [name, `column:${index}`]))
    originalLargeStableIds = new Map(largeStableIds)
    largeFormat = format
    largeRaggedRows = raggedRows
    const profile = await profileLargeTable(connection, columns, raggedRows, largeStableIds)
    originalLargeColumns = [...columns]
    largeInitialProfile = profile
    send({ type: 'complete', format, columns, rowCount: rowsProcessed, preview, profile, raggedRows, delimiter, encoding: sniff.encoding, largeFileMode: true, note: 'Large CSV/TSV was streamed into local DuckDB-WASM in batches. Original rows remain unchanged.' })
    // Keep the DuckDB worker alive for this dataset's lifetime; the UI can terminate this parser worker on Start over.
    void db
  } catch (error) {
    await connection.close().catch(() => undefined)
    await db.terminate().catch(() => undefined)
    activeDb = null
    activeConnection = null
    activeAbort = null
    throw error
  }
}

async function cleanLargeDataset(profile: ReturnType<typeof profileResultSchema.parse>, protectedColumns: string[], requestedRules?: import('../types').CleaningRule[]): Promise<void> {
  const connection = activeConnection
  if (!connection || !largeColumns.length) throw new Error('The local large-file session expired. Please upload the file again.')
  const originalExists = Number((await queryRows(connection, "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_name = 'dataset_original'"))[0]?.count ?? 0) > 0
  if (!originalExists) {
    await connection.query('ALTER TABLE dataset RENAME TO dataset_original')
    await connection.query('CREATE VIEW dataset AS SELECT * FROM dataset_original')
    largeColumns = [...originalLargeColumns]
    largeStableIds = new Map(originalLargeStableIds)
    largeVersions = ['dataset_original']
    largeHistoryCursor = 0
    profile = largeInitialProfile ?? profile
  } else {
    largeColumns = profile.columns.map((column) => column.name)
    largeStableIds = new Map(profile.columns.map((column) => [column.name, column.id]))
  }
  await connection.query('DROP TABLE IF EXISTS dataset_smart_source')
  await connection.query('CREATE TEMP TABLE dataset_smart_source AS SELECT * FROM dataset')
  await connection.query('DROP TABLE IF EXISTS dataset_cleaned')
  await connection.query('CREATE TABLE dataset_cleaned AS SELECT * FROM dataset_smart_source')
  const targetTable = 'dataset_cleaned'
  const sourceRowCount = Number((await queryRows(connection, 'SELECT COUNT(*) AS count FROM dataset_smart_source'))[0]?.count ?? 0)
  let loggedRowsRemoved = 0
  let loggedColumnsRemoved = 0
  const protectedSet = new Set(protectedColumns)
  const mutable = profile.columns.filter((column) => !protectedSet.has(column.name))
  const completePlan = buildSmartCleanPlan(profile, protectedColumns, requestedRules ?? [...LOW_RISK_RULES, ...RISKY_RULES])
  const rulePlan = completePlan.filter((item) => !item.proposed)
  const plannedColumns = (id: string) => rulePlan.find((item) => item.rule.id === id)?.columns ?? []
  const quote = sqlIdentifier
  const groups: Array<{ ruleId: string; category: string; label: string; columnCount: number; columns: string[]; columnIds?: string[]; affectedRows: number; samples: string[]; rowsRemoved?: number; cellsChanged?: number; cellsFlagged?: number; columnsRenamed?: number; columnsRemoved?: number; warning?: string }> = []
  const deferredFill = completePlan.find((item) => item.rule.kind === 'fill-missing')?.deferredColumns ?? []
  if (deferredFill.length) groups.push({ ruleId: 'fill-missing-deferred', category: 'fill-missing', label: `${deferredFill.length} high-missing columns left null`, columnCount: deferredFill.length, columns: deferredFill, columnIds: deferredFill.map((name) => profile.columns.find((column) => column.name === name)?.id ?? `column:${name}`), affectedRows: 0, cellsChanged: 0, cellsFlagged: deferredFill.reduce((sum, name) => sum + (profile.columns.find((column) => column.name === name)?.nullCount ?? 0), 0), rowsRemoved: 0, columnsRenamed: 0, samples: [] })
  const total = 8
  const progress = (step: number, rule: string) => send({ type: 'clean-progress', completed: step, total, rule })
  const update = async (id: string, expr: (column: string) => string, subset = mutable.map((c) => c.name)) => {
    if (!subset.length) return
    const expressions = subset.map((name) => ({ name, value: expr(name) }))
    const cellsChanged = Number((await queryRows(connection, `SELECT COALESCE(SUM(${expressions.map(({ name, value }) => `CASE WHEN ${quote(name)} IS DISTINCT FROM ${value} THEN 1 ELSE 0 END`).join(' + ')}),0) AS count FROM ${targetTable}`))[0]?.count ?? 0)
    const affectedPredicate = expressions.map(({ name, value }) => `${quote(name)} IS DISTINCT FROM ${value}`).join(' OR ')
    const affectedRows = Number((await queryRows(connection, `SELECT COUNT(*) AS count FROM ${targetTable} WHERE ${affectedPredicate}`))[0]?.count ?? 0)
    await connection.query(`UPDATE ${targetTable} SET ${expressions.map(({ name, value }) => `${quote(name)} = ${value}`).join(', ')}`)
    groups.push({ ruleId: id, category: id, label: `${cellsChanged.toLocaleString()} cells changed across ${affectedRows.toLocaleString()} rows`, columnCount: subset.length, columns: subset, columnIds: subset.map((name) => largeStableIds.get(name) ?? `column:${name}`), affectedRows, cellsChanged, samples: [] })
  }
  await update('trim-whitespace', (name) => buildLowRiskExpression('trim-whitespace', name), plannedColumns('trim-whitespace')); progress(1, 'trim-whitespace')
  await update('normalize-missing', (name) => buildLowRiskExpression('normalize-missing', name), plannedColumns('normalize-missing')); progress(2, 'normalize-missing')
  const numeric = plannedColumns('formatted-numbers')
  await update('formatted-numbers', (name) => buildLowRiskExpression('formatted-numbers', name), numeric); progress(3, 'formatted-numbers')
  await update('fix-type-mismatches', (name) => buildLowRiskExpression('fix-type-mismatches', name), plannedColumns('fix-type-mismatches')); progress(4, 'fix-type-mismatches')
  const emptyColumns = plannedColumns('remove-empty-rows')
  const emptyPredicateFor = (name: string) => `(${quote(name)} IS NULL OR LOWER(TRIM(${quote(name)})) IN ('', 'n/a', 'na', 'null', 'none', '-'))`
  const protectedEmptyPredicate = protectedColumns.map(emptyPredicateFor)
  const emptyPredicate = [...emptyColumns.map(emptyPredicateFor), ...protectedEmptyPredicate].join(' AND ')
  if (emptyColumns.length && emptyPredicate) {
    const emptyCount = Number((await queryRows(connection, `SELECT COUNT(*) AS count FROM ${targetTable} WHERE ${emptyPredicate}`))[0]?.count ?? 0)
    const beforeCount = Number((await queryRows(connection, `SELECT COUNT(*) AS count FROM ${targetTable}`))[0]?.count ?? 0)
    const samples = emptyCount ? (await queryRows(connection, `SELECT ${largeColumns.map(quote).join(', ')} FROM ${targetTable} WHERE ${emptyPredicate} ORDER BY "__dc_order" LIMIT 5`)).map((row) => JSON.stringify(row)) : []
    if (emptyCount > beforeCount * 0.2 || emptyCount === beforeCount) {
      const warning = `Safety guard: ${emptyCount} of ${beforeCount} rows would be removed (${beforeCount ? ((emptyCount / beforeCount) * 100).toFixed(1) : 0}%); the step was skipped. Review the sample rows before deciding.`
      groups.push({ ruleId: 'remove-empty-rows', category: 'remove-empty-rows', label: warning, columnCount: emptyColumns.length, columns: emptyColumns, columnIds: emptyColumns.map((name) => largeStableIds.get(name) ?? `column:${name}`), affectedRows: 0, rowsRemoved: 0, samples, warning })
    } else if (emptyCount) {
      await connection.query(`DELETE FROM ${targetTable} WHERE ${emptyPredicate}`)
      loggedRowsRemoved = emptyCount
      groups.push({ ruleId: 'remove-empty-rows', category: 'remove-empty-rows', label: `${emptyCount} rows removed`, columnCount: emptyColumns.length, columns: emptyColumns, columnIds: emptyColumns.map((name) => largeStableIds.get(name) ?? `column:${name}`), affectedRows: 0, rowsRemoved: emptyCount, samples })
    }
  }
  progress(5, 'remove-empty-rows')
  const removable = plannedColumns('remove-empty-columns')
  const removableNames = removable
  if (removableNames.length >= largeColumns.length && removableNames.length > 0) {
    const warning = `Safety guard: removing ${removableNames.length} of ${largeColumns.length} columns would leave no columns; the step was skipped.`
    groups.push({ ruleId: 'remove-empty-columns', category: 'remove-empty-columns', label: warning, columnCount: removableNames.length, columns: removableNames, columnIds: removableNames.map((name) => largeStableIds.get(name) ?? `column:${name}`), affectedRows: 0, columnsRemoved: 0, samples: removableNames.slice(0, 5).map((name) => `Would remove empty column: ${name}`), warning })
  } else if (removableNames.length) {
    const kept = largeColumns.filter((name) => !removableNames.includes(name))
    const removedColumnIds = removableNames.map((name) => largeStableIds.get(name) ?? `column:${name}`)
    await connection.query(`CREATE TABLE dataset_without_empty AS SELECT ${[...kept.map(quote), '"__dc_order"'].join(', ')} FROM ${targetTable}`)
    await connection.query(`DROP TABLE ${targetTable}`); await connection.query('ALTER TABLE dataset_without_empty RENAME TO dataset_cleaned')
    largeColumns = kept
    loggedColumnsRemoved = removableNames.length
    for (const name of removableNames) largeStableIds.delete(name)
    groups.push({ ruleId: 'remove-empty-columns', category: 'remove-empty-columns', label: `${removableNames.length} empty columns removed`, columnCount: removableNames.length, columns: removableNames, columnIds: removedColumnIds, affectedRows: 0, columnsRemoved: removableNames.length, samples: [] })
  }
  const currentRowCount = Number((await queryRows(connection, `SELECT COUNT(*) AS count FROM ${targetTable}`))[0]?.count ?? 0)
  if (currentRowCount === 0 || currentRowCount !== sourceRowCount - loggedRowsRemoved || largeColumns.length === 0 || largeColumns.length !== originalLargeColumns.length - loggedColumnsRemoved) {
    throw new Error('Smart Clean safety check failed: row or column counts changed without a matching removal record. The original dataset was restored and no cleaned result was applied.')
  }
  const nullViolationTerms = largeColumns.map((name) => {
    const source = quote(name); const target = quote(name)
    return [`(o.${source} IS NOT NULL AND TRIM(CAST(o.${source} AS VARCHAR)) <> '' AND LOWER(TRIM(CAST(o.${source} AS VARCHAR))) NOT IN ('n/a','na','null','none','-') AND c.${target} IS NULL)`]
  }).flat()
  if (nullViolationTerms.length) {
    const violations = Number((await queryRows(connection, `SELECT COUNT(*) AS count FROM dataset_smart_source o JOIN ${targetTable} c USING ("__dc_order") WHERE ${nullViolationTerms.join(' OR ')}`))[0]?.count ?? 0)
    if (violations) throw new Error('Smart Clean safety check failed: a non-empty source cell became null. The original dataset was restored and no cleaned result was applied.')
  }
  progress(6, 'remove-empty-columns')
  const renamed = new Map<string, string>()
  const renameCandidates = new Set(plannedColumns('normalize-column-names'))
  const used = new Set(largeColumns.filter((name) => protectedSet.has(name) || !renameCandidates.has(name)))
  for (const name of largeColumns.filter((item) => renameCandidates.has(item))) {
    const base = normalizeColumnName(name); let next = base; let suffix = 2
    while (used.has(next)) next = `${base}_${suffix++}`
    used.add(next); renamed.set(name, next)
  }
  if ([...renamed].some(([before, after]) => before !== after)) {
    await connection.query(`CREATE TABLE dataset_renamed AS SELECT ${largeColumns.map((name) => `${quote(name)} AS ${quote(renamed.get(name) ?? name)}`).join(', ')}, "__dc_order" FROM ${targetTable}`)
    await connection.query(`DROP TABLE ${targetTable}`); await connection.query('ALTER TABLE dataset_renamed RENAME TO dataset_cleaned')
    largeColumns = largeColumns.map((name) => renamed.get(name) ?? name)
    for (const [before, after] of renamed) {
      const id = largeStableIds.get(before)
      if (id) { largeStableIds.delete(before); largeStableIds.set(after, id) }
    }
    const renamedColumns = [...renamed].filter(([before, after]) => before !== after)
    groups.push({ ruleId: 'normalize-column-names', category: 'normalize-column-names', label: `${renamedColumns.length} columns renamed`, columnCount: renamedColumns.length, columns: renamedColumns.map(([, after]) => after), columnIds: renamedColumns.map(([before]) => largeStableIds.get(renamed.get(before) ?? before) ?? `column:${before}`), affectedRows: 0, cellsChanged: 0, columnsRenamed: renamedColumns.length, samples: renamedColumns.slice(0, 5).map(([before, after]) => `${before} → ${after}`) })
  }
  progress(7, 'normalize-column-names')
  await connection.query('DROP VIEW IF EXISTS dataset')
  largeVersions = largeVersions.slice(0, largeHistoryCursor + 1)
  const cleanVersion = `dataset_smart_clean_${++largeVersionNumber}`
  await connection.query(`ALTER TABLE dataset_cleaned RENAME TO ${cleanVersion}`)
  await connection.query(`CREATE VIEW dataset AS SELECT * FROM ${cleanVersion}`)
  progress(8, 'refreshing-profile')
  const count = Number((await queryRows(connection, 'SELECT COUNT(*) AS count FROM dataset'))[0]?.count ?? 0)
  const preview = await queryRows(connection, `SELECT ${largeColumns.map(sqlIdentifier).join(', ')} FROM dataset ORDER BY "__dc_order" LIMIT 1000`) as DataRow[]
  const nextProfile = await profileLargeTable(connection, largeColumns, largeRaggedRows, largeStableIds)
  await connection.query('DROP TABLE IF EXISTS dataset_smart_source')
  largeVersions.push(cleanVersion)
  largeHistoryCursor = largeVersions.length - 1
  send({ type: 'clean-complete', groups, proposed: completePlan.filter((item) => item.proposed), protectedColumns, changeLog: groups.map((group) => ({ id: crypto.randomUUID(), ruleId: group.ruleId, description: group.label, affectedRows: group.affectedRows, rowsRemoved: group.rowsRemoved ?? 0, cellsChanged: group.cellsChanged ?? 0, columnsRenamed: group.columnsRenamed ?? 0, cellsFlagged: group.cellsFlagged ?? 0, timestamp: new Date().toISOString(), undone: false, columnIds: group.columnIds ?? [] })), rows: [], preview, profile: nextProfile, columns: largeColumns, rowCount: count, format: largeFormat })
}

async function profileLargeTable(connection: duckdb.AsyncDuckDBConnection, columns: string[], raggedRows: number, stableIds = new Map(columns.map((name, index) => [name, `column:${index}`]))) {
  const total = Number((await queryRows(connection, 'SELECT COUNT(*) AS rows FROM dataset'))[0]?.rows ?? 0)
  const profiles = []
  for (const name of columns) {
    const col = sqlIdentifier(name)
    const stats = (await queryRows(connection, `SELECT COUNT(*) FILTER (WHERE ${col} IS NULL OR TRIM(${col}) = '' OR LOWER(TRIM(${col})) IN ('n/a','na','-')) AS null_count, COUNT(DISTINCT CASE WHEN ${col} IS NULL OR TRIM(${col}) = '' OR LOWER(TRIM(${col})) IN ('n/a','na','-') THEN NULL ELSE TRIM(${col}) END) AS unique_count, MIN(${col}) AS min_value, MAX(${col}) AS max_value, MIN(TRY_CAST(${col} AS DOUBLE)) AS min_numeric, MAX(TRY_CAST(${col} AS DOUBLE)) AS max_numeric, AVG(TRY_CAST(${col} AS DOUBLE)) AS mean_value, MEDIAN(TRY_CAST(${col} AS DOUBLE)) AS median_value, COUNT(*) FILTER (WHERE ${col} LIKE ' %') AS leading_count, COUNT(*) FILTER (WHERE ${col} LIKE '% ') AS trailing_count, COUNT(*) FILTER (WHERE TRY_CAST(${col} AS DOUBLE) IS NOT NULL) AS numeric_count, COUNT(*) FILTER (WHERE REGEXP_FULL_MATCH(TRIM(${col}), '^[+-]?[0-9]+$')) AS integer_count, COUNT(*) FILTER (WHERE LOWER(TRIM(${col})) IN ('true','false','yes','no')) AS boolean_count, COUNT(*) FILTER (WHERE TRY_CAST(${col} AS DATE) IS NOT NULL) AS date_count, COUNT(*) FILTER (WHERE TRY_CAST(${col} AS TIMESTAMP) IS NOT NULL AND REGEXP_MATCHES(${col}, '[ T][0-9]{1,2}:[0-9]{2}')) AS datetime_count, COUNT(*) FILTER (WHERE ${col} IS NOT NULL AND TRIM(${col}) <> '' AND LOWER(TRIM(${col})) NOT IN ('n/a','na','-') AND TRY_CAST(${col} AS DOUBLE) IS NULL AND LOWER(TRIM(${col})) NOT IN ('true','false','yes','no') AND TRY_CAST(${col} AS DATE) IS NULL) AS text_count FROM dataset`))[0] ?? {}
    const top = await queryRows(connection, `SELECT ${col} AS value, COUNT(*) AS count FROM dataset WHERE ${col} IS NOT NULL AND TRIM(${col}) <> '' AND LOWER(TRIM(${col})) NOT IN ('n/a','na','-') GROUP BY ${col} ORDER BY count DESC LIMIT 5`)
    const numericRows = Number(stats.numeric_count ?? 0)
    const integerRows = Number(stats.integer_count ?? 0)
    const boolRows = Number(stats.boolean_count ?? 0)
    const dateRows = Number(stats.date_count ?? 0)
    const datetimeRows = Number(stats.datetime_count ?? 0)
    const textRows = Number(stats.text_count ?? 0)
    const presentRows = total - Number(stats.null_count ?? 0)
    const typeCount = [numericRows, boolRows, dateRows, textRows].filter((count) => count > 0).length
    const mixedTypeCount = typeCount > 1 ? presentRows : 0
    const inferredType = !presentRows ? 'categorical' : numericRows === presentRows ? integerRows === presentRows ? 'integer' : 'float' : boolRows === presentRows ? 'boolean' : dateRows === presentRows ? datetimeRows === presentRows ? 'datetime' : 'date' : typeCount > 1 ? 'text' : Number(stats.unique_count ?? 0) <= Math.max(12, Math.ceil(presentRows * 0.2)) ? 'categorical' : 'text'
    const nullCount = Number(stats.null_count ?? 0)
    const leadingWhitespaceCount = Number(stats.leading_count ?? 0)
    const trailingWhitespaceCount = Number(stats.trailing_count ?? 0)
    const isEmailColumn = /email|e-mail/i.test(name)
    const isPhoneColumn = /phone|mobile|tel/i.test(name)
    const isDateColumn = /date|time|dob|birth|joined|created|updated/i.test(name)
    const invalidEmailCount = isEmailColumn ? Number((await queryRows(connection, `SELECT COUNT(*) AS count FROM dataset WHERE ${col} IS NOT NULL AND TRIM(${col}) <> '' AND LOWER(TRIM(${col})) NOT IN ('n/a','na','-') AND NOT REGEXP_FULL_MATCH(TRIM(${col}), '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')`))[0]?.count ?? 0) : 0
    const invalidPhoneCount = isPhoneColumn ? Number((await queryRows(connection, `SELECT COUNT(*) AS count FROM dataset WHERE ${col} IS NOT NULL AND TRIM(${col}) <> '' AND LOWER(TRIM(${col})) NOT IN ('n/a','na','-') AND LENGTH(REGEXP_REPLACE(${col}, '[^0-9]', '', 'g')) NOT BETWEEN 7 AND 15`))[0]?.count ?? 0) : 0
    const invalidDateCount = isDateColumn ? Number((await queryRows(connection, `SELECT COUNT(*) AS count FROM dataset WHERE ${col} IS NOT NULL AND TRIM(${col}) <> '' AND LOWER(TRIM(${col})) NOT IN ('n/a','na','-') AND TRY_CAST(${col} AS DATE) IS NULL`))[0]?.count ?? 0) : 0
    const inconsistentCasingCount = Number((await queryRows(connection, `SELECT COUNT(*) AS count FROM dataset WHERE ${col} IS NOT NULL AND TRIM(${col}) <> '' AND LOWER(TRIM(${col})) NOT IN ('n/a','na','-') AND LOWER(TRIM(${col})) IN (SELECT LOWER(TRIM(${col})) FROM dataset WHERE ${col} IS NOT NULL AND TRIM(${col}) <> '' AND LOWER(TRIM(${col})) NOT IN ('n/a','na','-') GROUP BY LOWER(TRIM(${col})) HAVING COUNT(DISTINCT TRIM(${col})) > 1)`))[0]?.count ?? 0)
    let iqrOutlierCount = 0
    if (numericRows >= 4) {
      const quartiles = (await queryRows(connection, `SELECT QUANTILE_CONT(TRY_CAST(${col} AS DOUBLE), 0.25) AS q1, QUANTILE_CONT(TRY_CAST(${col} AS DOUBLE), 0.75) AS q3 FROM dataset`))[0]
      if (quartiles?.q1 != null && quartiles.q3 != null) {
        const spread = Number(quartiles.q3) - Number(quartiles.q1)
        const low = Number(quartiles.q1) - 1.5 * spread
        const high = Number(quartiles.q3) + 1.5 * spread
        iqrOutlierCount = Number((await queryRows(connection, `SELECT COUNT(*) AS count FROM dataset WHERE TRY_CAST(${col} AS DOUBLE) < ${low} OR TRY_CAST(${col} AS DOUBLE) > ${high}`))[0]?.count ?? 0)
      }
    }
    const issues = [
      ...(nullCount ? [{ code: 'missing-values', severity: nullCount > total * 0.25 ? 'warning' : 'info', message: 'Missing or empty values found.', count: nullCount }] : []),
      ...(mixedTypeCount ? [{ code: 'mixed-types', severity: 'warning', message: 'Values use mixed data types.', count: mixedTypeCount }] : []),
      ...(leadingWhitespaceCount ? [{ code: 'leading-whitespace', severity: 'warning', message: 'Values contain leading whitespace.', count: leadingWhitespaceCount }] : []),
      ...(trailingWhitespaceCount ? [{ code: 'trailing-whitespace', severity: 'warning', message: 'Values contain trailing whitespace.', count: trailingWhitespaceCount }] : []),
      ...(inconsistentCasingCount ? [{ code: 'inconsistent-casing', severity: 'warning', message: 'Values use inconsistent casing.', count: inconsistentCasingCount }] : []),
      ...(invalidEmailCount ? [{ code: 'invalid-email', severity: 'error', message: 'Values do not look like valid email addresses.', count: invalidEmailCount }] : []),
      ...(invalidPhoneCount ? [{ code: 'invalid-phone', severity: 'warning', message: 'Phone values should contain 7 to 15 digits.', count: invalidPhoneCount }] : []),
      ...(invalidDateCount ? [{ code: 'invalid-date', severity: 'error', message: 'Date values could not be parsed consistently.', count: invalidDateCount }] : []),
      ...(iqrOutlierCount ? [{ code: 'iqr-outliers', severity: 'info', message: 'Numeric values outside the 1.5× IQR range.', count: iqrOutlierCount }] : []),
    ]
    profiles.push({ id: stableIds.get(name) ?? `column:${columns.indexOf(name)}`, name, inferredType, nullCount, nullPercent: total ? (nullCount / total) * 100 : 0, uniqueCount: Number(stats.unique_count ?? 0), duplicateValueCount: Math.max(presentRows - Number(stats.unique_count ?? 0), 0), min: numericRows === presentRows ? stats.min_numeric == null ? null : Number(stats.min_numeric) : stats.min_value ?? null, max: numericRows === presentRows ? stats.max_numeric == null ? null : Number(stats.max_numeric) : stats.max_value ?? null, mean: stats.mean_value == null ? null : Number(stats.mean_value), median: stats.median_value == null ? null : Number(stats.median_value), topValues: top.map((entry) => ({ value: entry.value as DataValue, count: Number(entry.count) })), mixedTypeCount, leadingWhitespaceCount, trailingWhitespaceCount, inconsistentCasingCount, invalidEmailCount, invalidPhoneCount, invalidDateCount, iqrOutlierCount, issues })
  }
  const duplicateRows = Number((await queryRows(connection, `SELECT COALESCE(SUM(n - 1), 0) AS duplicates FROM (SELECT COUNT(*) AS n FROM dataset GROUP BY ${columns.map(sqlIdentifier).join(', ')} HAVING COUNT(*) > 1)`))[0]?.duplicates ?? 0)
  const emptyRowsPredicate = columns.map((column) => `(${sqlIdentifier(column)} IS NULL OR TRIM(${sqlIdentifier(column)}) = '' OR LOWER(TRIM(${sqlIdentifier(column)})) IN ('n/a','na','-'))`).join(' AND ')
  const emptyRows = Number((await queryRows(connection, `SELECT COUNT(*) AS count FROM dataset WHERE ${emptyRowsPredicate}`))[0]?.count ?? 0)
  const nullCells = profiles.reduce((sum, profile) => sum + profile.nullCount, 0)
  const result = { summary: { rows: total, columns: columns.length, fullyDuplicateRows: duplicateRows, fullyEmptyRows: emptyRows, fullyEmptyColumns: profiles.filter((profile) => profile.nullCount === total).length, nullCells, memoryEstimateBytes: total * columns.length * 16 }, columns: profiles, datasetIssues: [...(duplicateRows ? [{ code: 'duplicate-rows', severity: 'warning', message: 'Fully duplicated rows found.', count: duplicateRows }] : []), ...(emptyRows ? [{ code: 'empty-rows', severity: 'info', message: 'Fully empty rows found.', count: emptyRows }] : []), ...(raggedRows ? [{ code: 'ragged-rows', severity: 'warning', message: 'Rows have a different number of fields from the header.', count: raggedRows }] : [])] }
  return profileResultSchema.parse(result)
}

async function executeDuckDbRisky(decision: RiskyDecision, protectedColumns: string[], apply: boolean): Promise<void> {
  const connection = activeConnection
  if (!connection) throw new Error('The local DuckDB session has expired. Upload the file again.')
  const source = largeVersions[largeHistoryCursor] ?? 'dataset'
  const beforeCount = Number((await queryRows(connection, `SELECT COUNT(*) AS count FROM ${source}`))[0]?.count ?? 0)
  const previewName = `risky_preview_${Date.now()}`
  const query = buildRiskySelect(decision, largeColumns, protectedColumns, source)
  send({ type: 'operation-progress', stage: 'dry-run', rowsProcessed: 0, totalRows: beforeCount, percent: 0 })
  await connection.query(`CREATE TEMP VIEW ${previewName} AS ${query}`)
  try {
    const afterCount = Number((await queryRows(connection, `SELECT COUNT(*) AS count FROM ${previewName}`))[0]?.count ?? 0)
    const rowsRemoved = beforeCount - afterCount
    const joinCondition = `b."__dc_order" = a."__dc_order"`
    const changedPredicates = largeColumns.map((name) => `b.${sqlIdentifier(name)} IS DISTINCT FROM a.${sqlIdentifier(name)}`)
    const changedExpression = changedPredicates.length ? changedPredicates.map((predicate) => `CASE WHEN ${predicate} THEN 1 ELSE 0 END`).join(' + ') : '0'
    const cellsChanged = Number((await queryRows(connection, `SELECT COALESCE(SUM(${changedExpression}),0) AS count FROM ${source} b JOIN ${previewName} a ON ${joinCondition}`))[0]?.count ?? 0)
    let flaggedCells = 0
    if (decision.kind === 'handle-outliers') {
      const selected = decision.columns.filter((name) => largeColumns.includes(name) && !protectedColumns.includes(name))
      const terms = selected.map((name) => { const c = sqlIdentifier(name); return `CASE WHEN TRY_CAST(${c} AS DOUBLE) < (SELECT QUANTILE_CONT(TRY_CAST(${c} AS DOUBLE), .25) - 1.5 * (QUANTILE_CONT(TRY_CAST(${c} AS DOUBLE), .75) - QUANTILE_CONT(TRY_CAST(${c} AS DOUBLE), .25)) FROM ${source}) OR TRY_CAST(${c} AS DOUBLE) > (SELECT QUANTILE_CONT(TRY_CAST(${c} AS DOUBLE), .75) + 1.5 * (QUANTILE_CONT(TRY_CAST(${c} AS DOUBLE), .75) - QUANTILE_CONT(TRY_CAST(${c} AS DOUBLE), .25)) FROM ${source}) THEN 1 ELSE 0 END` })
      if (terms.length) flaggedCells = Number((await queryRows(connection, `SELECT COALESCE(SUM(${terms.join(' + ')}),0) AS count FROM ${source}`))[0]?.count ?? 0)
    }
    let sampleOrders: number[]
    let samplePredicate = changedPredicates.length ? changedPredicates.join(' OR ') : 'FALSE'
    if (rowsRemoved > 0) sampleOrders = (await queryRows(connection, `SELECT b."__dc_order" AS order_id FROM ${source} b LEFT JOIN ${previewName} a ON ${joinCondition} WHERE a."__dc_order" IS NULL ORDER BY b."__dc_order" LIMIT 10`)).map((row) => Number(row.order_id))
    else {
      if (decision.kind === 'handle-outliers' && (decision.options.action ?? 'flag') === 'flag') {
        const selected = decision.columns.filter((name) => largeColumns.includes(name) && !protectedColumns.includes(name))
        samplePredicate = selected.map((name) => {
          const c = sqlIdentifier(name)
          const q1 = `(SELECT QUANTILE_CONT(TRY_CAST(${c} AS DOUBLE), .25) FROM ${source})`
          const q3 = `(SELECT QUANTILE_CONT(TRY_CAST(${c} AS DOUBLE), .75) FROM ${source})`
          const spread = `(${q3} - ${q1})`
          return `TRY_CAST(${c} AS DOUBLE) < (${q1} - 1.5 * ${spread}) OR TRY_CAST(${c} AS DOUBLE) > (${q3} + 1.5 * ${spread})`
        }).join(' OR ') || 'FALSE'
      }
      sampleOrders = (await queryRows(connection, `SELECT b."__dc_order" AS order_id FROM ${source} b JOIN ${previewName} a ON ${joinCondition} WHERE ${samplePredicate} ORDER BY b."__dc_order" LIMIT 10`)).map((row) => Number(row.order_id))
    }
    const samples = []
    for (const order of sampleOrders) {
      const before = (await queryRows(connection, `SELECT ${largeColumns.map(sqlIdentifier).join(', ')} FROM ${source} WHERE "__dc_order" = ${order} LIMIT 1`))[0] as DataRow | undefined
      const after = (await queryRows(connection, `SELECT ${largeColumns.map(sqlIdentifier).join(', ')} FROM ${previewName} WHERE "__dc_order" = ${order} LIMIT 1`))[0] as DataRow | undefined
      if (before) samples.push({ before, after: after ?? {} })
    }
    const result = { decision, rowsBefore: beforeCount, rowsAfter: afterCount, rowsRemoved, cellsChanged, flaggedCells, samples }
    if (!apply) {
      send({ type: 'risky-dry-run', result })
      return
    }
    send({ type: 'operation-progress', stage: 'apply', rowsProcessed: beforeCount, totalRows: beforeCount, percent: 70 })
    const nextVersion = `dataset_version_${++largeVersionNumber}`
    largeVersions = largeVersions.slice(0, largeHistoryCursor + 1)
    await connection.query(`CREATE VIEW ${nextVersion} AS ${query}`)
    const previousVersion = source
    const previousColumns = [...largeColumns]
    const previousStableIds = new Map(largeStableIds)
    const versionSchema = await queryRows(connection, `DESCRIBE ${nextVersion}`)
    const nextColumns = versionSchema.map((row) => String(row.column_name)).filter((name) => name !== '__dc_order')
    const nextStableIds = new Map(largeStableIds)
    nextColumns.forEach((name, index) => { if (!nextStableIds.has(name)) nextStableIds.set(name, `column:indicator:${index}`) })
    await connection.query('DROP VIEW dataset')
    await connection.query(`CREATE VIEW dataset AS SELECT * FROM ${nextVersion}`)
    largeColumns = nextColumns
    largeStableIds = nextStableIds
    largeVersions.push(nextVersion)
    largeHistoryCursor = largeVersions.length - 1
    let nextProfile: ReturnType<typeof profileResultSchema.parse>
    let preview: DataRow[]
    try {
      nextProfile = await profileLargeTable(connection, largeColumns, largeRaggedRows, largeStableIds)
      preview = await queryRows(connection, `SELECT ${largeColumns.map(sqlIdentifier).join(', ')} FROM dataset ORDER BY "__dc_order" LIMIT 1000`) as DataRow[]
    } catch (error) {
      await connection.query('DROP VIEW dataset')
      await connection.query(`CREATE VIEW dataset AS SELECT * FROM ${previousVersion}`)
      await connection.query(`DROP VIEW IF EXISTS ${nextVersion}`)
      largeColumns = previousColumns
      largeStableIds = previousStableIds
      largeVersions.pop()
      largeHistoryCursor = largeVersions.length - 1
      throw error
    }
    send({ type: 'risky-applied', rows: null, preview, profile: nextProfile, rowCount: afterCount, changeStep: makeChangeStep(result), decision })
    send({ type: 'operation-progress', stage: 'complete', rowsProcessed: afterCount, totalRows: afterCount, percent: 100 })
  } finally {
    await connection.query(`DROP VIEW IF EXISTS ${previewName}`).catch(() => undefined)
  }
}

async function moveLargeHistory(action: 'undo' | 'redo' | 'reset'): Promise<void> {
  const connection = activeConnection
  if (!connection || !largeVersions.length) throw new Error('No large-file history is available in this worker session.')
  if (action === 'undo') largeHistoryCursor = Math.max(0, largeHistoryCursor - 1)
  else if (action === 'redo') largeHistoryCursor = Math.min(largeVersions.length - 1, largeHistoryCursor + 1)
  else largeHistoryCursor = 0
  const version = largeVersions[largeHistoryCursor]!
  await connection.query('DROP VIEW dataset')
  await connection.query(`CREATE VIEW dataset AS SELECT * FROM ${version}`)
  const original = largeHistoryCursor === 0
  const columns = original ? originalLargeColumns : (await queryRows(connection, `DESCRIBE ${version}`)).map((row) => String(row.column_name)).filter((name) => name !== '__dc_order')
  if (original) largeStableIds = new Map(originalLargeStableIds)
  else columns.forEach((name, index) => { if (!largeStableIds.has(name)) largeStableIds.set(name, `column:history:${index}`) })
  largeColumns = [...columns]
  const profile = original ? largeInitialProfile : await profileLargeTable(connection, columns, largeRaggedRows, largeStableIds)
  if (!profile) throw new Error('The original profile is unavailable.')
  const rowCount = Number((await queryRows(connection, 'SELECT COUNT(*) AS count FROM dataset'))[0]?.count ?? 0)
  const preview = await queryRows(connection, `SELECT ${columns.map(sqlIdentifier).join(', ')} FROM dataset ORDER BY "__dc_order" LIMIT 1000`) as DataRow[]
  send({ type: 'history-moved', action, cursor: largeHistoryCursor, rowCount, preview, profile, columns })
}

function resolveDecisionColumns(decision: RiskyDecision, profile: ReturnType<typeof profileResultSchema.parse>): RiskyDecision {
  if (!decision.columnIds?.length) return decision
  const currentNameById = new Map(profile.columns.map((column) => [column.id, column.name]))
  const resolved = decision.columnIds.map((id) => currentNameById.get(id)).filter((name): name is string => Boolean(name))
  return { ...decision, columns: resolved }
}

async function parseRequest(file: File): Promise<void> {
  const format = formatFromFile(file)
  const largeFileMode = file.size >= LARGE_FILE_BYTES && (format === 'csv' || format === 'tsv')
  send({ type: 'started', format, largeFileMode, sizeBytes: file.size })
  if (format === 'xlsx' || format === 'xls') {
    await parseWorkbook(file, format)
    return
  }
  if (largeFileMode) {
    await runLargeCsv(file, format)
    return
  }
  send({ type: 'progress', stage: 'reading', percent: 10, rowsProcessed: 0, estimatedSecondsRemaining: null })
  const decoded = decodeTextBuffer(await file.arrayBuffer())
  let rows: DataRow[]
  let columns: string[]
  let note: string | undefined
  let raggedRows = 0
  let delimiter = ','
  if (format === 'json') {
    const parsed = parseJsonText(decoded.text)
    rows = parsed.rows
    columns = parsed.columns
    note = parsed.note
  } else {
    const parsed = parseCsvText(decoded.text, decoded.encoding)
    rows = parsed.rows
    columns = parsed.columns
    delimiter = parsed.delimiter
    raggedRows = parsed.raggedRows
  }
  send({ type: 'progress', stage: 'profiling', percent: 70, rowsProcessed: rows.length, estimatedSecondsRemaining: null })
  const profile = profileDataset(rows, columns)
  if (raggedRows) profile.datasetIssues.push({ code: 'ragged-rows', severity: 'warning', message: 'Rows have a different number of fields from the header.', count: raggedRows })
  send({ type: 'complete', format, columns, rowCount: rows.length, rows, preview: rows.slice(0, 1000), profile, raggedRows, delimiter, encoding: decoded.encoding, largeFileMode: false, note })
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data
  if (message.type === 'cancel') {
    if (activeConnection && largeVersions.length) {
      void activeConnection.cancelSent().catch(() => false)
      send({ type: 'operation-cancelled' })
      return
    }
    cancellationRequested = true
    activeAbort?.()
    void (async () => {
      await activeConnection?.close().catch(() => undefined)
      await activeDb?.terminate().catch(() => undefined)
      activeConnection = null
      activeDb = null
      pendingWorkbook = null
      send({ type: 'cancelled' })
    })()
    return
  }
  void (async () => {
    try {
      if (message.type === 'dry-run-risky' || message.type === 'apply-risky') {
        const decision = resolveDecisionColumns(message.decision, message.profile)
        if (activeConnection) {
          await executeDuckDbRisky(decision, message.protectedColumns, message.type === 'apply-risky')
          return
        }
        if (!message.rows) throw new Error('The current in-memory dataset is unavailable. Upload it again before reviewing this decision.')
        const dryRun = message.type === 'dry-run-risky'
        const execution = executeRiskyDecision(message.rows, decision, message.protectedColumns, dryRun)
        if (dryRun) send({ type: 'risky-dry-run', result: execution.result })
        else {
          const columns = Object.keys(execution.rows[0] ?? Object.fromEntries(message.profile.columns.map((column) => [column.name, null])))
          const stableIds = new Map(message.profile.columns.map((column) => [column.name, column.id]))
          const profile = profileResultSchema.parse(profileDataset(execution.rows, columns, stableIds))
          send({ type: 'risky-applied', rows: execution.rows, preview: execution.rows.slice(0, 1000), profile, rowCount: execution.rows.length, changeStep: makeChangeStep(execution.result), decision })
        }
      }
      else if (message.type === 'history') await moveLargeHistory(message.action)
      else if (message.type === 'parse') await parseRequest(message.file)
      else if (message.type === 'smart-clean') {
        if (activeConnection) {
          const isView = Number((await queryRows(activeConnection, "SELECT COUNT(*) AS count FROM information_schema.views WHERE table_name = 'dataset'"))[0]?.count ?? 0) > 0
          if (isView) await activeConnection.query('DROP VIEW dataset')
          for (const version of largeVersions.slice(1).reverse()) await activeConnection.query(`DROP VIEW IF EXISTS ${version}`).catch(() => undefined)
          await activeConnection.query('DROP TABLE IF EXISTS dataset_smart_clean')
          largeVersions = []
          largeHistoryCursor = 0
          await cleanLargeDataset(message.profile, message.protectedColumns, message.rules)
        }
        else {
          if (!message.rows) throw new Error('This dataset is no longer available in the browser worker.')
          const result = runSmartClean(message.rows, message.profile, message.protectedColumns, (progress) => send({ type: 'clean-progress', ...progress }), message.rules)
          const columns = Object.keys(result.rows[0] ?? Object.fromEntries(message.profile.columns.map((column) => [column.name, null])))
          const profile = profileDataset(result.rows, columns, new Map(Object.entries(result.stableColumnIds ?? {})))
          send({ type: 'clean-complete', ...result, profile, preview: result.rows.slice(0, 1000), rowCount: result.rows.length, columns })
        }
      }
      else if (message.type === 'inspect-xlsx-sheet') {
        if (!pendingWorkbook) throw new Error('The workbook is no longer available. Select it again to continue.')
        const sheet = pendingWorkbook.Sheets[message.sheet]
        if (!sheet) throw new Error('That worksheet could not be found.')
        send({ type: 'workbook-inspected', sheets: pendingWorkbook.SheetNames, sheet: message.sheet, ...inspectWorksheet(sheet) })
      } else {
        if (!pendingWorkbook) throw new Error('The workbook is no longer available. Select it again to continue.')
        const sheet = pendingWorkbook.Sheets[message.sheet]
        if (!sheet) throw new Error('That worksheet could not be found.')
        const result = parseWorksheet(sheet, message.headerRow)
        const profile = profileDataset(result.rows, result.columns)
        if (result.raggedRows) profile.datasetIssues.push({ code: 'ragged-rows', severity: 'warning', message: 'Rows have a different number of fields from the header.', count: result.raggedRows })
        send({ type: 'complete', format: pendingWorkbookFormat, columns: result.columns, rowCount: result.rows.length, rows: result.rows, preview: result.rows.slice(0, 1000), profile, raggedRows: result.raggedRows, largeFileMode: false, note: 'Merged cells use the value from the top-left cell. Empty leading rows are preserved for header selection.' })
        pendingWorkbook = null
      }
    } catch (error) {
      if (cancellationRequested) return
      const raw = error instanceof Error ? error.message : String(error)
      if (message.type === 'smart-clean' && activeConnection && largeInitialProfile) {
        try {
          const hasOriginal = Number((await queryRows(activeConnection, "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_name = 'dataset_original'"))[0]?.count ?? 0) > 0
          if (hasOriginal) {
            const hasSmartSource = Number((await queryRows(activeConnection, "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_name = 'dataset_smart_source'"))[0]?.count ?? 0) > 0
            const datasetView = Number((await queryRows(activeConnection, "SELECT COUNT(*) AS count FROM information_schema.views WHERE table_name = 'dataset'"))[0]?.count ?? 0) > 0
            if (datasetView) await activeConnection.query('DROP VIEW dataset')
            const datasetTable = Number((await queryRows(activeConnection, "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_name = 'dataset'"))[0]?.count ?? 0) > 0
            if (datasetTable) await activeConnection.query('DROP TABLE dataset')
            await activeConnection.query(`CREATE VIEW dataset AS SELECT * FROM ${hasSmartSource ? 'dataset_smart_source' : 'dataset_original'}`)
            if (hasSmartSource) {
              largeColumns = message.profile.columns.map((column) => column.name)
              largeStableIds = new Map(message.profile.columns.map((column) => [column.name, column.id]))
            } else {
              largeColumns = [...originalLargeColumns]
              largeStableIds = new Map(originalLargeStableIds)
              largeVersions = ['dataset_original']; largeHistoryCursor = 0
            }
          }
        } catch { /* preserve and report the original clean failure below */ }
      }
      if (message.type === 'dry-run-risky' || message.type === 'apply-risky') { send({ type: 'risky-failed', message: raw || 'The review action could not be completed.' }); return }
      const failureMessage = isMemoryError(error) ? 'This file needs more memory than the browser can provide. Close other tabs, split the file, or try CSV instead of XLSX.' : raw || 'We could not read this file.'
      send({ type: 'failed', message: failureMessage })
    }
  })()
}
