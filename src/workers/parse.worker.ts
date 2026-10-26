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
import { buildSmartCleanPlan, LOW_RISK_RULES, RISKY_RULES, rankRiskyProposals, runSmartClean, scopeMatches } from '../engine/smartClean'
import { buildCategoryMappingFromCounts, currencySignature, normalizeColumnName } from '../cleaners/rules'
import { executeRiskyDecision, makeChangeStep } from '../engine/riskyDecisions'
import { recommendMissingValues, selectImputationTrainingSample } from '../engine/localImputation'
import { buildRiskySelect, quoteSqlString } from '../engine/riskySql'
import { buildCategoryCaseExpression, buildDateNormalizationExpression, buildLowRiskExpression, buildMojibakeRepairExpression } from '../engine/lowRiskSql'
import { buildDuckDbCompareCountSql, buildDuckDbCompareSql, buildDuckDbRemovedRowsSql, type DuckDbVersion } from '../engine/duckdbCompare'
import { DuckDbBundleSession } from '../engine/duckdbBundle'
import { buildDuckDbJsonExportProjection, normalizeDuckDbJsonValue } from '../engine/duckdbExport'
import { buildDuckDbImputationSampleSql, buildDuckDbImputationViewSql, processDuckDbEstimateBatches } from '../engine/duckdbImputation'
import { compareCsvExportPage, compareJsonlExportPage, type VerifyColumn } from '../lib/streamVerification'
import type { DataFormat, DataRow, DataValue } from '../types'
import type { RiskyDecision } from '../types'

const LARGE_FILE_BYTES = 50 * 1024 * 1024
const BATCH_ROWS = 50_000
type WorkerRequest = { type: 'parse'; file: File } | { type: 'inspect-xlsx-sheet'; sheet: string } | { type: 'continue-xlsx'; sheet: string; headerRow: number } | { type: 'smart-clean'; profile: ReturnType<typeof profileResultSchema.parse>; protectedColumns: string[]; rows?: DataRow[]; rules?: import('../types').CleaningRule[]; excelDateRows?: Record<string, number[]> } | { type: 'recommend-imputation'; requestId: string; columns: string[]; featureColumns: string[]; rows?: DataRow[]; seed: number; maxTrainingRows?: number; missingPercentByColumn: Record<string, number>; targetTypes: Record<string, import('../types').InferredType> } | { type: 'dry-run-risky'; decision: RiskyDecision; rows?: DataRow[]; profile: ReturnType<typeof profileResultSchema.parse>; protectedColumns: string[] } | { type: 'apply-risky'; decision: RiskyDecision; rows?: DataRow[]; profile: ReturnType<typeof profileResultSchema.parse>; protectedColumns: string[] } | { type: 'history'; action: 'undo' | 'redo' | 'reset' } | { type: 'export-stream'; requestId: string; format: 'csv' | 'jsonl'; columns: Array<{ source: string; name: string; type?: import('../types').InferredType }>; bom?: boolean } | { type: 'export-removed-stream'; requestId: string } | { type: 'download-all-large'; requestId: string; format: 'csv' | 'jsonl'; columns: Array<{ source: string; name: string; type?: import('../types').InferredType }>; fileName: string; report: string; recipe: string; ruleByColumn: Record<string, string>; stepByColumn: Record<string, number>; bom?: boolean } | { type: 'verify-export-file'; requestId: string; file: File; format: 'csv' | 'jsonl'; columns: Array<VerifyColumn & { type?: import('../types').InferredType }> } | { type: 'compare-page'; requestId: string; offset: number; limit: number; rules?: Record<string, string> } | { type: 'export-next'; requestId: string } | { type: 'export-cancel'; requestId: string } | { type: 'cancel' }
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
let inMemoryRowOrderKey = ''
let largeVersions: string[] = []
let largeVersionRules: string[] = []
let largeHistoryCursor = 0
let largeVersionNumber = 0
const duckDbEstimateRuns = new Map<string, { table: string; source: string; target: string; estimated: number; rowCount: number; samples: Array<{ before: DataRow; after: DataRow }>; decision: RiskyDecision }>()
const duckDbEstimateTables = new Set<string>()
let exportStream: { requestId: string; format: 'csv' | 'jsonl'; columns: Array<{ source: string; name: string; type?: import('../types').InferredType }>; offset: number; lastOrderId: number; orderAlias: string; rowCount: number; bom: boolean; first: boolean; source: 'cleaned' | 'removed'; versions?: DuckDbVersion[] } | null = null
let largeZipStream: DuckDbBundleSession | null = null
const exportPreparations = new Set<string>()
const cancelledExports = new Set<string>()

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

function addInMemoryRowOrder(rows: DataRow[], columns: string[]): string {
  let key = '__dc_internal_row_order'
  while (columns.includes(key)) key += '_'
  inMemoryRowOrderKey = key
  rows.forEach((row, index) => { row[key] = index })
  return key
}

function exportEscape(value: unknown): string {
  if (value == null || value === 'null' || value === 'undefined' || value === 'None' || value === 'NaN') return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function uniqueCsvHeader(base: string, existing: string[]): string {
  let header = base
  let suffix = 2
  while (existing.includes(header)) header = `${base}_removed_${suffix++}`
  return header
}

async function sendExportPage(requestId: string): Promise<void> {
  const session = exportStream
  const connection = activeConnection
  if (!session || !connection || session.requestId !== requestId) return
  const selected = session.format === 'jsonl' && session.source === 'cleaned'
    ? buildDuckDbJsonExportProjection(session.columns)
    : session.columns.map((column) => sqlIdentifier(column.source)).join(', ')
  const rowBatch = Math.max(1, Math.min(5000, Math.floor(250_000 / Math.max(session.columns.length, 1))))
  const page = session.source === 'removed'
    ? await queryRows(connection, buildDuckDbRemovedRowsSql(session.versions ?? [], session.columns.map((column) => column.source), rowBatch, session.offset))
    : await queryRows(connection, `SELECT ${selected}, "__dc_order" AS ${sqlIdentifier(session.orderAlias)} FROM dataset WHERE "__dc_order" > ${session.lastOrderId} ORDER BY "__dc_order" LIMIT ${rowBatch}`)
  if (exportStream !== session) return
  let chunk = ''
  if (session.first) {
    if (session.format === 'csv') {
      const names = session.columns.map((column) => column.name)
      const rowIdHeader = uniqueCsvHeader('row_id', names)
      const ruleHeader = uniqueCsvHeader('removal_rule', [...names, rowIdHeader])
      const headers = session.source === 'removed' ? [rowIdHeader, ruleHeader, ...names] : names
      chunk = `${session.bom ? '\uFEFF' : ''}${headers.map(exportEscape).join(',')}\r\n`
    }
    session.first = false
  }
  if (session.format === 'csv') chunk += page.map((row) => (session.source === 'removed' ? [Number(row.row_id) + 1, row.removal_rule, ...session.columns.map((column) => row[column.source])] : session.columns.map((column) => row[column.source])).map(exportEscape).join(',')).join('\r\n') + (page.length ? '\r\n' : '')
  else chunk += page.map((row) => JSON.stringify(Object.fromEntries(session.columns.map((column) => [column.name, normalizeDuckDbJsonValue(row[column.source])])))).join('\n') + (page.length ? '\n' : '')
  session.offset += page.length
  if (session.source === 'cleaned' && page.length) session.lastOrderId = Number(page[page.length - 1]?.[session.orderAlias] ?? session.lastOrderId)
  const done = session.offset >= session.rowCount || page.length === 0
  send({ type: 'export-chunk', requestId, chunk, done, rowsProcessed: session.offset, rowCount: session.rowCount, percent: session.rowCount ? Math.min(100, Math.round(session.offset / session.rowCount * 100)) : 100 })
  if (done) exportStream = null
}

async function sendLargeZipPage(requestId: string): Promise<void> {
  const session = largeZipStream
  const connection = activeConnection
  if (!session || !connection || session.requestId !== requestId) return
  const result = await session.next((sql) => queryRows(connection, sql))
  if (largeZipStream !== session) return
  const buffer = result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength)
  self.postMessage({ type: 'export-zip-chunk', requestId, bytes: buffer, done: result.done, rowsProcessed: result.rowsProcessed, rowCount: result.rowCount, percent: result.rowCount ? Math.min(100, Math.round(result.rowsProcessed / result.rowCount * 100)) : result.done ? 100 : 0, stage: result.stage }, [buffer])
  if (result.done) largeZipStream = null
}

async function verifyLargeCsv(requestId: string, file: File, columns: VerifyColumn[]): Promise<void> {
  const connection = activeConnection
  if (!connection) throw new Error('The local DuckDB session is unavailable for verification.')
  if (!columns.length) throw new Error('The exported file has no selected columns.')
  const rowCount = Number((await queryRows(connection, 'SELECT COUNT(*) AS count FROM dataset'))[0]?.count ?? 0)
  const projection = columns.map((column) => sqlIdentifier(column.source)).join(', ')
  const actualNullCounts = Object.fromEntries(columns.map((column) => [column.name, 0]))
  const expectedNullCounts = Object.fromEntries(columns.map((column) => [column.name, 0]))
  const mismatches: string[] = []
  let rowOffset = 0
  let headerChecked = false
  await new Promise<void>((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      dynamicTyping: false,
      chunkSize: 1024 * 1024,
      chunk: (results, parser) => {
        parser.pause()
        void (async () => {
          if (!headerChecked) {
            headerChecked = true
            if (JSON.stringify(results.meta.fields ?? []) !== JSON.stringify(columns.map((column) => column.name))) mismatches.push(`Column names differ: expected ${columns.map((column) => column.name).join(', ')}, got ${(results.meta.fields ?? []).join(', ')}.`)
          }
          if (results.errors.length && mismatches.length < 20) mismatches.push(`CSV parser reported: ${results.errors[0]?.message ?? 'invalid CSV'}`)
          const parsedRows = results.data as Array<Record<string, unknown>>
          if (parsedRows.length) {
            const expected = await queryRows(connection, `SELECT ${projection} FROM dataset ORDER BY "__dc_order" LIMIT ${parsedRows.length} OFFSET ${rowOffset}`) as DataRow[]
            mismatches.push(...compareCsvExportPage(parsedRows, expected, columns, rowOffset).slice(0, Math.max(0, 20 - mismatches.length)))
            for (const column of columns) {
              actualNullCounts[column.name] += parsedRows.filter((row) => row[column.name] === '').length
              expectedNullCounts[column.name] += expected.filter((row) => row[column.source] == null || row[column.source] === '' || ['null', 'undefined', 'None', 'NaN'].includes(String(row[column.source]))).length
            }
            rowOffset += parsedRows.length
          }
          send({ type: 'verify-export-progress', requestId, rowsProcessed: rowOffset, rowCount })
          parser.resume()
        })().catch((error: unknown) => { parser.abort(); reject(error) })
      },
      complete: () => resolve(),
      error: (error) => reject(error),
    })
  })
  if (rowOffset !== rowCount) mismatches.push(`Row count differs: DuckDB has ${rowCount}, file has ${rowOffset}.`)
  for (const column of columns) if (actualNullCounts[column.name] !== expectedNullCounts[column.name]) mismatches.push(`Null count for “${column.name}” differs: expected ${expectedNullCounts[column.name]}, got ${actualNullCounts[column.name]}.`)
  send({ type: 'verify-export-complete', requestId, result: { pass: mismatches.length === 0, mismatches: mismatches.slice(0, 20), rows: rowOffset, columns: columns.length } })
}

async function verifyLargeJsonl(requestId: string, file: File, columns: Array<VerifyColumn & { type?: import('../types').InferredType }>): Promise<void> {
  const connection = activeConnection
  if (!connection) throw new Error('The local DuckDB session is unavailable for verification.')
  const rowCount = Number((await queryRows(connection, 'SELECT COUNT(*) AS count FROM dataset'))[0]?.count ?? 0)
  const projection = buildDuckDbJsonExportProjection(columns)
  const mismatches: string[] = []
  const actualNullCounts = Object.fromEntries(columns.map((column) => [column.name, 0]))
  const expectedNullCounts = Object.fromEntries(columns.map((column) => [column.name, 0]))
  let rowOffset = 0
  let buffer = ''
  let page: Array<Record<string, unknown>> = []
  const comparePage = async () => {
    if (!page.length) return
    const expected = await queryRows(connection, `SELECT ${projection} FROM dataset ORDER BY "__dc_order" LIMIT ${page.length} OFFSET ${rowOffset}`) as DataRow[]
    if (rowOffset === 0 && JSON.stringify(Object.keys(page[0] ?? {})) !== JSON.stringify(columns.map((column) => column.name))) mismatches.push(`JSON object keys differ: expected ${columns.map((column) => column.name).join(', ')}, got ${Object.keys(page[0] ?? {}).join(', ')}.`)
    mismatches.push(...compareJsonlExportPage(page, expected, columns, rowOffset).slice(0, Math.max(0, 20 - mismatches.length)))
    for (const column of columns) {
      actualNullCounts[column.name] += page.filter((row) => row[column.name] === null).length
      expectedNullCounts[column.name] += expected.filter((row) => row[column.source] == null || normalizeDuckDbJsonValue(row[column.source]) === null).length
    }
    rowOffset += page.length
    page = []
    send({ type: 'verify-export-progress', requestId, rowsProcessed: rowOffset, rowCount })
  }
  const parseLine = async (line: string) => {
    if (!line.trim()) return
    try { page.push(JSON.parse(line) as Record<string, unknown>) }
    catch { if (mismatches.length < 20) mismatches.push(`Invalid JSON Lines record at row ${rowOffset + page.length + 1}.`) }
    if (page.length >= 1000) await comparePage()
  }
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) await parseLine(line.replace(/\r$/, ''))
    if (done) break
  }
  if (buffer) await parseLine(buffer.replace(/\r$/, ''))
  await comparePage()
  if (rowOffset !== rowCount) mismatches.push(`Row count differs: DuckDB has ${rowCount}, file has ${rowOffset}.`)
  for (const column of columns) if (actualNullCounts[column.name] !== expectedNullCounts[column.name]) mismatches.push(`Null count for “${column.name}” differs: expected ${expectedNullCounts[column.name]}, got ${actualNullCounts[column.name]}.`)
  send({ type: 'verify-export-complete', requestId, result: { pass: mismatches.length === 0, mismatches: mismatches.slice(0, 20), rows: rowOffset, columns: columns.length } })
}

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
    largeVersionRules = ['Original']
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
  const formattedPlan = completePlan.find((item) => item.rule.kind === 'formatted-numbers')
  if (formattedPlan?.columns.length) {
    const candidates = formattedPlan.columns.map((name, index) => {
      const source = sqlIdentifier(name)
      const expression = buildLowRiskExpression('formatted-numbers', name)
      const present = `(${source} IS NOT NULL AND TRIM(CAST(${source} AS VARCHAR)) <> '' AND LOWER(TRIM(CAST(${source} AS VARCHAR))) NOT IN ('n/a','na','null','none','-'))`
      return { name, index, source, expression, present }
    })
    const select = candidates.flatMap(({ source, expression, present, index }) => [
      `COUNT(*) FILTER (WHERE ${present}) AS n${index}`,
      `COUNT(*) FILTER (WHERE ${present} AND TRY_CAST(${expression} AS DOUBLE) IS NOT NULL) AS p${index}`,
      `COUNT(*) FILTER (WHERE ${present} AND ${source} IS DISTINCT FROM ${expression}) AS c${index}`,
    ]).join(', ')
    const metrics = (await queryRows(connection, `SELECT ${select} FROM ${targetTable}`))[0] ?? {}
    const eligible = candidates.filter(({ index }) => {
      const present = Number(metrics[`n${index}`] ?? 0); const parsed = Number(metrics[`p${index}`] ?? 0); const changed = Number(metrics[`c${index}`] ?? 0)
      return present > 0 && parsed / present >= 0.9 && changed > 0
    }).map(({ name }) => name)
    formattedPlan.columns = eligible
    formattedPlan.columnIds = eligible.map((name) => largeStableIds.get(name) ?? profile.columns.find((column) => column.name === name)?.id ?? `column:${name}`)
  }
  const rulePlan = completePlan.filter((item) => !item.proposed)
  const plannedColumns = (id: string) => rulePlan.find((item) => item.rule.id === id)?.columns ?? []
  const quote = sqlIdentifier
  const groups: Array<{ ruleId: string; category: string; label: string; columnCount: number; columns: string[]; columnIds?: string[]; affectedRows: number; samples: string[]; rowsRemoved?: number; cellsChanged?: number; cellsFlagged?: number; columnsRenamed?: number; columnsRemoved?: number; warning?: string }> = []
  const deferredFill = completePlan.find((item) => item.rule.kind === 'fill-missing')?.deferredColumns ?? []
  if (deferredFill.length) groups.push({ ruleId: 'fill-missing-deferred', category: 'fill-missing', label: `${deferredFill.length} high-missing columns left null`, columnCount: deferredFill.length, columns: deferredFill, columnIds: deferredFill.map((name) => profile.columns.find((column) => column.name === name)?.id ?? `column:${name}`), affectedRows: 0, cellsChanged: 0, cellsFlagged: deferredFill.reduce((sum, name) => sum + (profile.columns.find((column) => column.name === name)?.nullCount ?? 0), 0), rowsRemoved: 0, columnsRenamed: 0, samples: [] })
  const excludedFill = completePlan.find((item) => item.rule.kind === 'fill-missing')?.excludedColumns ?? []
  if (excludedFill.length) groups.push({ ruleId: 'fill-missing-excluded', category: 'fill-missing', label: `${excludedFill.length} identifier/text columns excluded from autofill`, columnCount: excludedFill.length, columns: excludedFill, columnIds: excludedFill.map((name) => profile.columns.find((column) => column.name === name)?.id ?? `column:${name}`), affectedRows: 0, cellsChanged: 0, cellsFlagged: 0, rowsRemoved: 0, columnsRenamed: 0, samples: ['Identifier and free-text columns require an explicit scope before imputation.'] })
  const total = 9
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
  await update('repair-mojibake', (name) => buildMojibakeRepairExpression(name), plannedColumns('repair-mojibake'))
  const categoryRule = completePlan.find((item) => item.rule.kind === 'canonicalize-categories')
  const categoryCandidates = profile.columns.filter((column) => !protectedSet.has(column.name) && !protectedSet.has(column.id) && column.inferredType === 'categorical' && (!categoryRule || scopeMatches(categoryRule.rule, column))).map((column) => column.name)
  if (categoryCandidates.length) {
    const union = categoryCandidates.map((name) => {
      const col = quote(name)
      return `SELECT ${quoteSqlString(name)} AS column_name, CAST(${col} AS VARCHAR) AS value, COUNT(*) AS n FROM ${targetTable} WHERE ${col} IS NOT NULL AND TRIM(CAST(${col} AS VARCHAR)) <> '' AND LOWER(TRIM(CAST(${col} AS VARCHAR))) NOT IN ('n/a','na','null','none','-') GROUP BY ${col}`
    }).join(' UNION ALL ')
    const variants = await queryRows(connection, union)
    const byColumn = new Map<string, Array<[string, number]>>()
    for (const variant of variants) {
      const name = String(variant.column_name); const value = String(variant.value)
      const bucket = byColumn.get(name) ?? []
      bucket.push([value, Number(variant.n)])
      byColumn.set(name, bucket)
    }
    const mappings = new Map<string, Map<string, string>>()
    for (const [name, values] of byColumn) {
      const mapping = buildCategoryMappingFromCounts(values)
      if (mapping.size) mappings.set(name, mapping)
    }
    const names = [...mappings.keys()]
    if (categoryRule) {
      categoryRule.columns = names
      categoryRule.columnIds = names.map((name) => largeStableIds.get(name) ?? profile.columns.find((column) => column.name === name)?.id ?? `column:${name}`)
    }
    const mappingExpression = (name: string) => buildCategoryCaseExpression(name, mappings.get(name) ?? new Map())
    await update('canonicalize-categories', mappingExpression, names)
  } else if (categoryRule) {
    categoryRule.columns = []
    categoryRule.columnIds = []
  }
  await update('fix-type-mismatches', (name) => buildLowRiskExpression('fix-type-mismatches', name), plannedColumns('fix-type-mismatches')); progress(4, 'fix-type-mismatches')
  const dateColumns = plannedColumns('normalize-dates')
  if (dateColumns.length) {
    const evidenceSql = dateColumns.map((name, index) => {
      const col = quote(name); const value = `TRIM(CAST(${col} AS VARCHAR))`
      return `COUNT_IF(REGEXP_FULL_MATCH(${value}, '^[0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{2,4}$')) AS d${index}, COUNT_IF(REGEXP_FULL_MATCH(${value}, '^[0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{2,4}$') AND TRY_CAST(REGEXP_EXTRACT(${value}, '^([0-9]{1,2})', 1) AS INTEGER) > 12) AS f${index}, COUNT_IF(REGEXP_FULL_MATCH(${value}, '^[0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{2,4}$') AND TRY_CAST(REGEXP_EXTRACT(${value}, '^[0-9]{1,2}[./-]([0-9]{1,2})', 1) AS INTEGER) > 12) AS s${index}`
    }).join(', ')
    const evidence = (await queryRows(connection, `SELECT ${evidenceSql} FROM ${targetTable}`))[0] ?? {}
    const expressions = dateColumns.map((name, index) => {
      const first = Number(evidence[`f${index}`] ?? 0); const second = Number(evidence[`s${index}`] ?? 0); const count = Number(evidence[`d${index}`] ?? 0)
      const order = first && second ? 'mixed' : first ? 'day-first' : second ? 'month-first' : count ? 'ambiguous' : 'none'
      return { name, value: buildDateNormalizationExpression(name, order) }
    })
    const changed = Number((await queryRows(connection, `SELECT COALESCE(SUM(${expressions.map(({ name, value }) => `CASE WHEN ${quote(name)} IS DISTINCT FROM ${value} THEN 1 ELSE 0 END`).join(' + ')}),0) AS count FROM ${targetTable}`))[0]?.count ?? 0)
    const invalid = Number((await queryRows(connection, `SELECT COALESCE(SUM(${expressions.map(({ name, value }) => `CASE WHEN ${quote(name)} IS NOT NULL AND ${value} IS NULL THEN 1 ELSE 0 END`).join(' + ')}),0) AS count FROM ${targetTable}`))[0]?.count ?? 0)
    await connection.query(`UPDATE ${targetTable} SET ${expressions.map(({ name, value }) => `${quote(name)} = ${value}`).join(', ')}`)
    groups.push({ ruleId: 'normalize-dates', category: 'normalize-dates', label: `${changed.toLocaleString()} date cells normalized`, columnCount: dateColumns.length, columns: dateColumns, columnIds: dateColumns.map((name) => largeStableIds.get(name) ?? `column:${name}`), affectedRows: 0, cellsChanged: changed, cellsFlagged: invalid, samples: [] })
  }
  progress(5, 'normalize-dates')
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
  progress(6, 'remove-empty-rows')
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
  progress(7, 'remove-empty-columns')
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
  progress(8, 'normalize-column-names')
  await connection.query('DROP VIEW IF EXISTS dataset')
  largeVersions = largeVersions.slice(0, largeHistoryCursor + 1)
  largeVersionRules = largeVersionRules.slice(0, largeHistoryCursor + 1)
  const cleanVersion = `dataset_smart_clean_${++largeVersionNumber}`
  await connection.query(`ALTER TABLE dataset_cleaned RENAME TO ${cleanVersion}`)
  await connection.query(`CREATE VIEW dataset AS SELECT * FROM ${cleanVersion}`)
  progress(9, 'refreshing-profile')
  const count = Number((await queryRows(connection, 'SELECT COUNT(*) AS count FROM dataset'))[0]?.count ?? 0)
  const preview = await queryRows(connection, `SELECT ${largeColumns.map(sqlIdentifier).join(', ')} FROM dataset ORDER BY "__dc_order" LIMIT 1000`) as DataRow[]
  const nextProfile = await profileLargeTable(connection, largeColumns, largeRaggedRows, largeStableIds)
  await connection.query('DROP TABLE IF EXISTS dataset_smart_source')
  largeVersions.push(cleanVersion)
  largeVersionRules.push(groups.find((group) => group.ruleId === 'remove-empty-rows')?.label ?? 'Smart Clean: remove empty rows')
  largeHistoryCursor = largeVersions.length - 1
  send({ type: 'clean-complete', groups, proposed: rankRiskyProposals(completePlan.filter((item) => item.proposed), profile), protectedColumns, changeLog: groups.map((group) => ({ id: crypto.randomUUID(), ruleId: group.ruleId, description: group.label, affectedRows: group.affectedRows, rowsRemoved: group.rowsRemoved ?? 0, cellsChanged: group.cellsChanged ?? 0, columnsRenamed: group.columnsRenamed ?? 0, cellsFlagged: group.cellsFlagged ?? 0, timestamp: new Date().toISOString(), undone: false, columnIds: group.columnIds ?? [] })), rows: [], preview, profile: nextProfile, columns: largeColumns, rowCount: count, format: largeFormat })
}

async function profileLargeTable(connection: duckdb.AsyncDuckDBConnection, columns: string[], raggedRows: number, stableIds = new Map(columns.map((name, index) => [name, `column:${index}`]))) {
  const total = Number((await queryRows(connection, 'SELECT COUNT(*) AS rows FROM dataset'))[0]?.rows ?? 0)
  const profiles = []
  for (const name of columns) {
    const col = sqlIdentifier(name)
    const stats = (await queryRows(connection, `SELECT COUNT(*) FILTER (WHERE ${col} IS NULL OR TRIM(${col}) = '' OR LOWER(TRIM(${col})) IN ('n/a','na','-')) AS null_count, COUNT(DISTINCT CASE WHEN ${col} IS NULL OR TRIM(${col}) = '' OR LOWER(TRIM(${col})) IN ('n/a','na','-') THEN NULL ELSE TRIM(${col}) END) AS unique_count, MIN(${col}) AS min_value, MAX(${col}) AS max_value, MIN(TRY_CAST(${col} AS DOUBLE)) AS min_numeric, MAX(TRY_CAST(${col} AS DOUBLE)) AS max_numeric, AVG(TRY_CAST(${col} AS DOUBLE)) AS mean_value, MEDIAN(TRY_CAST(${col} AS DOUBLE)) AS median_value, COUNT(*) FILTER (WHERE ${col} LIKE ' %') AS leading_count, COUNT(*) FILTER (WHERE ${col} LIKE '% ') AS trailing_count, COUNT(*) FILTER (WHERE TRY_CAST(${col} AS DOUBLE) IS NOT NULL) AS numeric_count, COUNT(*) FILTER (WHERE REGEXP_FULL_MATCH(TRIM(${col}), '^[+-]?[0-9]+$')) AS integer_count, COUNT(*) FILTER (WHERE LOWER(TRIM(${col})) IN ('true','false','yes','no')) AS boolean_count, COUNT(*) FILTER (WHERE TRY_CAST(${col} AS DATE) IS NOT NULL) AS date_count, COUNT(*) FILTER (WHERE TRY_CAST(${col} AS TIMESTAMP) IS NOT NULL AND REGEXP_MATCHES(${col}, '[ T][0-9]{1,2}:[0-9]{2}')) AS datetime_count, COUNT(*) FILTER (WHERE ${col} IS NOT NULL AND TRIM(${col}) <> '' AND LOWER(TRIM(${col})) NOT IN ('n/a','na','-') AND TRY_CAST(${col} AS DOUBLE) IS NULL AND LOWER(TRIM(${col})) NOT IN ('true','false','yes','no') AND TRY_CAST(${col} AS DATE) IS NULL) AS text_count, COUNT(*) FILTER (WHERE TRY_CAST(${buildLowRiskExpression('formatted-numbers', name)} AS DOUBLE) < 0) AS negative_count, COUNT(*) FILTER (WHERE TRY_CAST(${col} AS DATE) > CURRENT_DATE) AS future_date_count FROM dataset`))[0] ?? {}
    const top = await queryRows(connection, `SELECT ${col} AS value, COUNT(*) AS count FROM dataset WHERE ${col} IS NOT NULL AND TRIM(${col}) <> '' AND LOWER(TRIM(${col})) NOT IN ('n/a','na','-') GROUP BY ${col} ORDER BY count DESC LIMIT 5`)
    const currencySymbols = [...new Set(top.map((entry) => currencySignature(entry.value as DataValue)).filter((value): value is string => Boolean(value)))].sort()
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
    const isQuantityColumn = /quantity|qty/i.test(name)
    const isProfitColumn = /profit/i.test(name)
    const invalidEmailCount = isEmailColumn ? Number((await queryRows(connection, `SELECT COUNT(*) AS count FROM dataset WHERE ${col} IS NOT NULL AND TRIM(${col}) <> '' AND LOWER(TRIM(${col})) NOT IN ('n/a','na','-') AND NOT REGEXP_FULL_MATCH(TRIM(${col}), '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')`))[0]?.count ?? 0) : 0
    const invalidPhoneCount = isPhoneColumn ? Number((await queryRows(connection, `SELECT COUNT(*) AS count FROM dataset WHERE ${col} IS NOT NULL AND TRIM(${col}) <> '' AND LOWER(TRIM(${col})) NOT IN ('n/a','na','-') AND LENGTH(REGEXP_REPLACE(${col}, '[^0-9]', '', 'g')) NOT BETWEEN 7 AND 15`))[0]?.count ?? 0) : 0
    const invalidDateCount = isDateColumn ? Number((await queryRows(connection, `SELECT COUNT(*) AS count FROM dataset WHERE ${col} IS NOT NULL AND TRIM(${col}) <> '' AND LOWER(TRIM(${col})) NOT IN ('n/a','na','-') AND TRY_CAST(${col} AS DATE) IS NULL`))[0]?.count ?? 0) : 0
    const negativeCount = Number(stats.negative_count ?? 0)
    const futureDateCount = isDateColumn ? Number(stats.future_date_count ?? 0) : 0
    const identifierCount = /(?:^|[ _-])(?:id|identifier|code)(?:$|[ _-])/i.test(name) && presentRows > 1 && Number(stats.unique_count ?? 0) / presentRows >= 0.8 ? presentRows : 0
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
      ...(currencySymbols.length > 1 ? [{ code: 'mixed-currency', severity: 'warning', message: `Values contain multiple currency families: ${currencySymbols.join(', ')}.`, count: currencySymbols.length }] : []),
      ...(isQuantityColumn && negativeCount ? [{ code: 'negative-quantity', severity: 'warning', message: 'Negative quantities require review.', count: negativeCount }] : []),
      ...(isProfitColumn && negativeCount ? [{ code: 'negative-profit', severity: 'warning', message: 'Negative profit values require review.', count: negativeCount }] : []),
      ...(futureDateCount ? [{ code: 'future-date', severity: 'warning', message: 'Dates later than today require review.', count: futureDateCount }] : []),
      ...(identifierCount ? [{ code: 'identifier-column', severity: 'info', message: 'This high-uniqueness ID/code column is excluded from automatic imputation.', count: identifierCount }] : []),
    ]
    profiles.push({ id: stableIds.get(name) ?? `column:${columns.indexOf(name)}`, name, inferredType, nullCount, nullPercent: total ? (nullCount / total) * 100 : 0, uniqueCount: Number(stats.unique_count ?? 0), duplicateValueCount: Math.max(presentRows - Number(stats.unique_count ?? 0), 0), min: numericRows === presentRows ? stats.min_numeric == null ? null : Number(stats.min_numeric) : stats.min_value ?? null, max: numericRows === presentRows ? stats.max_numeric == null ? null : Number(stats.max_numeric) : stats.max_value ?? null, mean: stats.mean_value == null ? null : Number(stats.mean_value), median: stats.median_value == null ? null : Number(stats.median_value), topValues: top.map((entry) => ({ value: entry.value as DataValue, count: Number(entry.count) })), mixedTypeCount, leadingWhitespaceCount, trailingWhitespaceCount, inconsistentCasingCount, invalidEmailCount, invalidPhoneCount, invalidDateCount, iqrOutlierCount, currencySymbols, issues })
  }
  const duplicateRows = Number((await queryRows(connection, `SELECT COALESCE(SUM(n - 1), 0) AS duplicates FROM (SELECT COUNT(*) AS n FROM dataset GROUP BY ${columns.map(sqlIdentifier).join(', ')} HAVING COUNT(*) > 1)`))[0]?.duplicates ?? 0)
  const emptyRowsPredicate = columns.map((column) => `(${sqlIdentifier(column)} IS NULL OR TRIM(${sqlIdentifier(column)}) = '' OR LOWER(TRIM(${sqlIdentifier(column)})) IN ('n/a','na','-'))`).join(' AND ')
  const emptyRows = Number((await queryRows(connection, `SELECT COUNT(*) AS count FROM dataset WHERE ${emptyRowsPredicate}`))[0]?.count ?? 0)
  const nullCells = profiles.reduce((sum, profile) => sum + profile.nullCount, 0)
  const result = { summary: { rows: total, columns: columns.length, fullyDuplicateRows: duplicateRows, fullyEmptyRows: emptyRows, fullyEmptyColumns: profiles.filter((profile) => profile.nullCount === total).length, nullCells, memoryEstimateBytes: total * columns.length * 16 }, columns: profiles, datasetIssues: [...(duplicateRows ? [{ code: 'duplicate-rows', severity: 'warning', message: 'Fully duplicated rows found.', count: duplicateRows }] : []), ...(emptyRows ? [{ code: 'empty-rows', severity: 'info', message: 'Fully empty rows found.', count: emptyRows }] : []), ...(raggedRows ? [{ code: 'ragged-rows', severity: 'warning', message: 'Rows have a different number of fields from the header.', count: raggedRows }] : [])] }
  return profileResultSchema.parse(result)
}

async function executeDuckDbModelEstimate(decisionInput: RiskyDecision, protectedColumns: string[], apply: boolean): Promise<void> {
  const connection = activeConnection
  if (!connection) throw new Error('The local DuckDB session has expired. Upload the file again.')
  const target = decisionInput.columns.find((name) => largeColumns.includes(name) && !protectedColumns.includes(name))
  if (!target || decisionInput.columns.length !== 1) throw new Error('Local model estimates currently require one eligible, unprotected target column per decision.')
  if (/(?:^|[ _-])(?:id|identifier|code)(?:$|[ _-])/i.test(target)) throw new Error('Identifier-like columns cannot be filled with model estimates.')
  let validation: Record<string, unknown>
  try { validation = JSON.parse(String(decisionInput.options.validation ?? 'null')) as Record<string, unknown> } catch { throw new Error('The estimate validation details are missing. Evaluate the local model again before accepting.') }
  const validationPasses = validation.repeats === 3 && Number(validation.sampleCount) >= 5 && (validation.kind === 'numeric'
    ? Number(validation.baselineMae) > 0 && Number(validation.modelMae) <= Number(validation.baselineMae) * 0.9 && (validation.modelMape == null || validation.baselineMape == null || Number(validation.baselineMape) > 0 && Number(validation.modelMape) <= Number(validation.baselineMape) * 0.9)
    : validation.kind === 'categorical' && Number(validation.modelAccuracy) >= Number(validation.baselineAccuracy) + 0.1)
  if (!validationPasses) throw new Error('This local model did not beat the simple baseline by the required validation margin.')
  const source = largeVersions[largeHistoryCursor] ?? 'dataset'
  let runId = typeof decisionInput.options.estimateRunId === 'string' ? decisionInput.options.estimateRunId : ''
  let run = runId ? duckDbEstimateRuns.get(runId) : undefined
  if (!apply || !run) {
    cancellationRequested = false
    if (!apply) {
      for (const [pendingId, pendingRun] of duckDbEstimateRuns) {
        await connection.query(`DROP TABLE IF EXISTS ${sqlIdentifier(pendingRun.table)}`).catch(() => undefined)
        duckDbEstimateTables.delete(pendingRun.table)
        duckDbEstimateRuns.delete(pendingId)
      }
    }
    const profile = decisionInput.options.targetType === 'categorical' || decisionInput.options.targetType === 'boolean' ? 'categorical' : String(decisionInput.options.targetType ?? 'float')
    const rawFeatures = Array.isArray(decisionInput.options.featureColumns) ? decisionInput.options.featureColumns : []
    const features = rawFeatures.filter((name): name is string => typeof name === 'string' && name !== target && largeColumns.includes(name) && !protectedColumns.includes(name)).slice(0, 16)
    if (!features.length) throw new Error('No usable predictor columns are available for this estimate.')
    const missing = `(${sqlIdentifier(target)} IS NULL OR TRIM(CAST(${sqlIdentifier(target)} AS VARCHAR)) = '' OR LOWER(TRIM(CAST(${sqlIdentifier(target)} AS VARCHAR))) IN ('n/a','na','null','none','-'))`
    const count = Number((await queryRows(connection, `SELECT COUNT(*) AS count FROM ${source}`))[0]?.count ?? 0)
    const missingCount = Number((await queryRows(connection, `SELECT COUNT(*) AS count FROM ${source} WHERE ${missing}`))[0]?.count ?? 0)
    if (!count || !missingCount) throw new Error('This column has no missing cells to estimate.')
    if (missingCount / count > 0.4) throw new Error('Model estimates are disabled when more than 40% of a column is missing.')
    const started = performance.now()
    send({ type: 'operation-progress', stage: 'sampling-estimate-training-data', rowsProcessed: 0, totalRows: missingCount, estimatedSecondsRemaining: null, percent: 0 })
    const trainingColumns = [...new Set([target, ...features])]
    const seed = Number(decisionInput.options.seed ?? 20261025) | 0
    const maxTrainingRows = Math.max(100, Math.min(20_000, Number(decisionInput.options.maxTrainingRows ?? 5000) | 0))
    const trainingSql = `SELECT ${trainingColumns.map(sqlIdentifier).join(', ')}, "__dc_order" FROM ${source} ORDER BY HASH("__dc_order"), "__dc_order" LIMIT 50000`
    const sampledTrainingRows = await queryRows(connection, trainingSql) as DataRow[]
    const training = selectImputationTrainingSample(sampledTrainingRows, seed, maxTrainingRows)
    if (training.filter((row) => !((row[target] == null) || typeof row[target] === 'string' && ['', 'n/a', 'na', 'null', 'none', '-'].includes(row[target]!.trim().toLowerCase()))).length < 100) throw new Error('At least 100 observed examples are required for local estimates in the deterministic training sample.')
    const table = `dc_estimate_${crypto.randomUUID().replaceAll('-', '')}`
    await connection.query(`CREATE TEMP TABLE ${sqlIdentifier(table)} ("__dc_order" BIGINT, "__dc_column" VARCHAR, "estimate_value" VARCHAR, "uncertainty" DOUBLE)`)
    duckDbEstimateTables.add(table)
    let cursor = -1
    const integerTarget = profile === 'integer'
    const bounds = profile === 'categorical' ? null : (await queryRows(connection, `SELECT MIN(TRY_CAST(${sqlIdentifier(target)} AS DOUBLE)) AS min, MAX(TRY_CAST(${sqlIdentifier(target)} AS DOUBLE)) AS max FROM ${source} WHERE NOT ${missing}`))[0]
    const min = Number(bounds?.min ?? Number.NEGATIVE_INFINITY)
    const max = Number(bounds?.max ?? Number.POSITIVE_INFINITY)
    const nonNegative = decisionInput.options.nonNegative === true || min >= 0 || /(?:quantity|price|revenue|age|count)/i.test(target)
    const targetPages = async function* () {
      while (!cancellationRequested) {
        const batch = await queryRows(connection, `SELECT ${trainingColumns.map(sqlIdentifier).join(', ')}, "__dc_order" FROM ${source} WHERE ${missing} AND "__dc_order" > ${cursor} ORDER BY "__dc_order" LIMIT 2000`) as DataRow[]
        if (!batch.length) return
        cursor = Number(batch[batch.length - 1]?.__dc_order ?? cursor)
        yield batch
      }
    }
    const batchResult = await processDuckDbEstimateBatches(targetPages(), {
      trainingRows: training, target, features, targetType: profile, model: decisionInput.options.model === 'ridge-regression' ? 'ridge-regression' : 'weighted-knn', min, max, integerTarget, nonNegative,
      isCancelled: () => cancellationRequested,
      insertBatch: async (estimates) => {
        const entries = estimates.map((estimate) => `(${estimate.rowOrder}, ${quoteSqlString(target)}, ${quoteSqlString(String(estimate.value))}, ${estimate.uncertainty})`)
        if (entries.length) await connection.query(`INSERT INTO ${sqlIdentifier(table)} VALUES ${entries.join(', ')}`)
      },
      onProgress: async (processed) => {
        const elapsed = (performance.now() - started) / 1000
        const eta = processed > 0 ? Math.ceil((missingCount - processed) / (processed / elapsed)) : null
        send({ type: 'operation-progress', stage: 'estimating', rowsProcessed: processed, totalRows: missingCount, estimatedSecondsRemaining: eta, percent: Math.min(69, Math.floor(processed / missingCount * 69)) })
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      },
    })
    if (batchResult.cancelled || cancellationRequested) {
      await connection.query(`DROP TABLE IF EXISTS ${sqlIdentifier(table)}`).catch(() => undefined)
      duckDbEstimateTables.delete(table)
      return
    }
    const estimated = batchResult.estimatedCells
    if (!estimated) {
      await connection.query(`DROP TABLE IF EXISTS ${sqlIdentifier(table)}`)
      duckDbEstimateTables.delete(table)
      throw new Error('The available predictors could not produce estimates for any missing cells.')
    }
    const sampleRows = await queryRows(connection, `SELECT s.*, e."estimate_value", e."uncertainty" FROM ${source} s JOIN ${sqlIdentifier(table)} e ON e."__dc_order" = s."__dc_order" ORDER BY s."__dc_order" LIMIT 10`)
    const samples = sampleRows.map((row) => {
      const before = Object.fromEntries(largeColumns.map((name) => [name, row[name] as DataValue])) as DataRow
      return { before, after: { ...before, [target]: row.estimate_value as DataValue } }
    })
    const previewUncertainty = await queryRows(connection, `SELECT row_index, uncertainty FROM (SELECT ROW_NUMBER() OVER (ORDER BY s."__dc_order") - 1 AS row_index, e."uncertainty" AS uncertainty FROM ${source} s JOIN ${sqlIdentifier(table)} e ON e."__dc_order" = s."__dc_order") WHERE row_index < 1000`)
    const estimatesByRow = Object.fromEntries(previewUncertainty.map((row) => [String(row.row_index), { rowIndex: Number(row.row_index), uncertainty: Number(row.uncertainty) }]))
    runId = crypto.randomUUID()
    const decision: RiskyDecision = { ...decisionInput, options: { ...decisionInput.options, strategy: 'model-estimates', estimateRunId: runId, estimatedValues: JSON.stringify({ [target]: Object.values(estimatesByRow) }) } }
    run = { table, source, target, estimated, rowCount: count, samples, decision }
    duckDbEstimateRuns.set(runId, run)
  }
  if (run.source !== source || run.target !== target) throw new Error('This estimate preview is stale. Run the dry run again against the current dataset.')
  const result = { decision: run.decision, rowsBefore: run.rowCount, rowsAfter: run.rowCount, rowsRemoved: 0, cellsChanged: run.estimated, cellsEstimated: run.estimated, flaggedCells: 0, samples: run.samples }
  if (!apply) {
    send({ type: 'risky-dry-run', result })
    return
  }
  send({ type: 'operation-progress', stage: 'applying-estimates', rowsProcessed: run.estimated, totalRows: run.rowCount, percent: 70 })
  const addIndicator = run.decision.options.addWasMissingIndicator === true
  let indicator: string | undefined
  if (addIndicator) {
    const base = `${target}__was_missing`
    indicator = base
    let suffix = 2
    while (largeColumns.includes(indicator)) indicator = `${base}_${suffix++}`
  }
  const nextVersion = `dataset_version_${++largeVersionNumber}`
  largeVersions = largeVersions.slice(0, largeHistoryCursor + 1)
  largeVersionRules = largeVersionRules.slice(0, largeHistoryCursor + 1)
  const previousVersion = source
  const previousColumns = [...largeColumns]
  const previousIds = new Map(largeStableIds)
  let historyAdded = false
  try {
    await connection.query(`CREATE VIEW ${sqlIdentifier(nextVersion)} AS ${buildDuckDbImputationViewSql(source, run.table, largeColumns, target, indicator, String(run.decision.options.targetType ?? 'text'))}`)
    const versionSchema = await queryRows(connection, `DESCRIBE ${sqlIdentifier(nextVersion)}`)
    const nextColumns = versionSchema.map((row) => String(row.column_name)).filter((name) => name !== '__dc_order')
    const nextIds = new Map(largeStableIds)
    if (indicator) nextIds.set(indicator, `column:estimate-indicator:${crypto.randomUUID()}`)
    await connection.query('DROP VIEW dataset')
    await connection.query(`CREATE VIEW dataset AS SELECT * FROM ${sqlIdentifier(nextVersion)}`)
    largeColumns = nextColumns
    largeStableIds = nextIds
    largeVersions.push(nextVersion)
    largeVersionRules.push('model estimates')
    largeHistoryCursor = largeVersions.length - 1
    historyAdded = true
    const nextProfile = await profileLargeTable(connection, largeColumns, largeRaggedRows, largeStableIds)
    const preview = await queryRows(connection, `SELECT ${largeColumns.map(sqlIdentifier).join(', ')} FROM dataset ORDER BY "__dc_order" LIMIT 1000`) as DataRow[]
    send({ type: 'risky-applied', rows: null, preview, profile: nextProfile, rowCount: run.rowCount, changeStep: makeChangeStep(result), decision: run.decision })
    send({ type: 'operation-progress', stage: 'complete', rowsProcessed: run.rowCount, totalRows: run.rowCount, percent: 100 })
    duckDbEstimateRuns.delete(runId)
  } catch (error) {
    await connection.query('DROP VIEW dataset').catch(() => undefined)
    await connection.query(`CREATE VIEW dataset AS SELECT * FROM ${sqlIdentifier(previousVersion)}`).catch(() => undefined)
    await connection.query(`DROP VIEW IF EXISTS ${sqlIdentifier(nextVersion)}`).catch(() => undefined)
    largeColumns = previousColumns
    largeStableIds = previousIds
    if (historyAdded) { largeVersions.pop(); largeVersionRules.pop(); largeHistoryCursor = largeVersions.length - 1 }
    throw error
  }
}

async function executeDuckDbRisky(decision: RiskyDecision, protectedColumns: string[], apply: boolean): Promise<void> {
  const connection = activeConnection
  if (!connection) throw new Error('The local DuckDB session has expired. Upload the file again.')
  if (decision.kind === 'fill-missing' && decision.options.strategy === 'model-estimates') {
    await executeDuckDbModelEstimate(decision, protectedColumns, apply)
    return
  }
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
    } else if (decision.kind === 'resolve-validation') {
      const selected = decision.columns.filter((name) => largeColumns.includes(name) && !protectedColumns.includes(name))
      const terms = selected.map((name) => `CASE WHEN TRY_CAST(${sqlIdentifier(name)} AS DOUBLE) < 0 THEN 1 ELSE 0 END`)
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
      } else if (decision.kind === 'resolve-validation' && decision.options.action === 'leave') {
        samplePredicate = decision.columns.filter((name) => largeColumns.includes(name) && !protectedColumns.includes(name)).map((name) => `TRY_CAST(${sqlIdentifier(name)} AS DOUBLE) < 0`).join(' OR ') || 'FALSE'
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
    largeVersionRules = largeVersionRules.slice(0, largeHistoryCursor + 1)
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
    largeVersionRules.push(decision.kind.replaceAll('-', ' '))
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
      largeVersionRules.pop()
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
  const rowOrderKey = addInMemoryRowOrder(rows, columns)
  send({ type: 'progress', stage: 'profiling', percent: 70, rowsProcessed: rows.length, estimatedSecondsRemaining: null })
  const profile = profileDataset(rows, columns)
  if (raggedRows) profile.datasetIssues.push({ code: 'ragged-rows', severity: 'warning', message: 'Rows have a different number of fields from the header.', count: raggedRows })
  send({ type: 'complete', format, columns, rowCount: rows.length, rows, preview: rows.slice(0, 1000), profile, raggedRows, delimiter, encoding: decoded.encoding, largeFileMode: false, rowOrderKey, note })
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data
  if (message.type === 'export-cancel') {
    const active = exportStream?.requestId === message.requestId || largeZipStream?.requestId === message.requestId
    if (exportStream?.requestId === message.requestId) exportStream = null
    if (largeZipStream?.requestId === message.requestId) largeZipStream = null
    if (!active && exportPreparations.has(message.requestId)) cancelledExports.add(message.requestId)
    send({ type: 'export-cancelled', requestId: message.requestId })
    return
  }
  if (message.type === 'export-next') {
    const nextPage = largeZipStream?.requestId === message.requestId ? sendLargeZipPage(message.requestId) : sendExportPage(message.requestId)
    void nextPage.catch((error) => {
      exportStream = null
      if (largeZipStream?.requestId === message.requestId) largeZipStream = null
      send({ type: 'export-failed', requestId: message.requestId, message: error instanceof Error ? error.message : String(error) })
    })
    return
  }
  if (message.type === 'cancel') {
    if (activeConnection && largeVersions.length) {
      cancellationRequested = true
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
      if (message.type === 'compare-page') {
        const connection = activeConnection
        if (!connection || !largeVersions.length) throw new Error('A DuckDB dataset is required for paged comparison.')
        const originalNameById = new Map([...originalLargeStableIds].map(([name, id]) => [id, name]))
        const compareColumns = [...largeStableIds].flatMap(([cleaned, id]) => {
          const original = originalNameById.get(id)
          return original ? [{ original, cleaned, display: cleaned }] : []
        })
        const pageSize = Math.max(1, Math.min(5000, Math.floor(message.limit)))
        const query = buildDuckDbCompareSql(compareColumns, pageSize + 1, Math.max(0, Math.floor(message.offset)))
        const result = await queryRows(connection, query)
        const hasMore = result.length > pageSize
        const changes = result.slice(0, pageSize).map((row) => ({
          row_id: Number(row.row_id) + 1,
          column: String(row.column),
          before: row.before == null ? null : String(row.before),
          after: row.after == null ? null : String(row.after),
          rule: message.rules?.[String(row.column)] ?? 'cleaning rule',
          step: 1,
        }))
        send({ type: 'compare-page', requestId: message.requestId, offset: message.offset, changes, hasMore })
      }
      else if (message.type === 'verify-export-file') {
        if (message.format === 'csv') await verifyLargeCsv(message.requestId, message.file, message.columns)
        else await verifyLargeJsonl(message.requestId, message.file, message.columns)
      }
      else if (message.type === 'export-stream') {
        if (!activeConnection) throw new Error('Large-file export requires an active local DuckDB session. Upload the file again and retry.')
        if (!message.columns.length) throw new Error('Choose at least one column to export.')
        exportPreparations.add(message.requestId); cancelledExports.delete(message.requestId)
        const count = Number((await queryRows(activeConnection, 'SELECT COUNT(*) AS count FROM dataset'))[0]?.count ?? 0)
        exportPreparations.delete(message.requestId)
        if (cancelledExports.delete(message.requestId)) return
        exportStream = { requestId: message.requestId, format: message.format, columns: message.columns, offset: 0, lastOrderId: -1, orderAlias: uniqueCsvHeader('__dc_hidden_export_order', message.columns.map((column) => column.source)), rowCount: count, bom: message.bom ?? false, first: true, source: 'cleaned' }
        send({ type: 'export-started', requestId: message.requestId, rowCount: count })
        await sendExportPage(message.requestId)
      }
      else if (message.type === 'export-removed-stream') {
        if (!activeConnection || largeVersions.length < 2) throw new Error('There is no large-file removal history to export.')
        exportPreparations.add(message.requestId); cancelledExports.delete(message.requestId)
        const versions = largeVersions.slice(0, largeHistoryCursor + 1).map((table, index) => ({ table, removedBy: largeVersionRules[index] ?? 'cleaning rule' }))
        const count = Number((await queryRows(activeConnection, 'SELECT COUNT(*) AS count FROM dataset_original o LEFT JOIN dataset c USING ("__dc_order") WHERE c."__dc_order" IS NULL'))[0]?.count ?? 0)
        exportPreparations.delete(message.requestId)
        if (cancelledExports.delete(message.requestId)) return
        const columns = originalLargeColumns.map((name) => ({ source: name, name }))
        exportStream = { requestId: message.requestId, format: 'csv', columns, offset: 0, lastOrderId: -1, orderAlias: uniqueCsvHeader('__dc_hidden_export_order', columns.map((column) => column.source)), rowCount: count, bom: false, first: true, source: 'removed', versions }
        send({ type: 'export-started', requestId: message.requestId, rowCount: count })
        await sendExportPage(message.requestId)
      }
      else if (message.type === 'download-all-large') {
        if (!activeConnection || !largeVersions.length) throw new Error('Large-file bundle export requires an active local DuckDB session.')
        if (!message.columns.length) throw new Error('Choose at least one column to include in the bundle.')
        exportPreparations.add(message.requestId); cancelledExports.delete(message.requestId)
        send({ type: 'export-zip-progress', requestId: message.requestId, rowsProcessed: 0, rowCount: 0, percent: 0, stage: 'Preparing bundle' })
        const cleanRows = Number((await queryRows(activeConnection, 'SELECT COUNT(*) AS count FROM dataset'))[0]?.count ?? 0)
        if (cancelledExports.has(message.requestId)) { exportPreparations.delete(message.requestId); cancelledExports.delete(message.requestId); return }
        const originalNameById = new Map([...originalLargeStableIds].map(([name, id]) => [id, name]))
        const compareColumns = message.columns.flatMap((column) => {
          const stableId = largeStableIds.get(column.source)
          const original = stableId ? originalNameById.get(stableId) : undefined
          return original ? [{ original, cleaned: column.source, display: column.name }] : []
        })
        const changedCells = Number((await queryRows(activeConnection, buildDuckDbCompareCountSql(compareColumns)))[0]?.count ?? 0)
        exportPreparations.delete(message.requestId)
        if (cancelledExports.delete(message.requestId)) return
        exportStream = null
        largeZipStream = new DuckDbBundleSession({ requestId: message.requestId, format: message.format, columns: message.columns,
          fileName: message.fileName, report: message.report, recipe: message.recipe, ruleByColumn: message.ruleByColumn,
          stepByColumn: message.stepByColumn, bom: message.bom ?? false, cleanRows, changedCells, compareColumns })
        send({ type: 'export-zip-progress', requestId: message.requestId, rowsProcessed: 0, rowCount: cleanRows + changedCells, percent: 0, stage: 'Writing cleaned data' })
        await sendLargeZipPage(message.requestId)
      }
      else if (message.type === 'recommend-imputation') {
        let rows = message.rows
        if (!rows && activeConnection) {
          const features = message.featureColumns.slice(0, 16)
          const columns = [...new Set([...message.columns, ...features])].filter((name) => largeColumns.includes(name))
          const sampled = await queryRows(activeConnection, buildDuckDbImputationSampleSql(columns))
          rows = sampled as DataRow[]
        }
        if (!rows) throw new Error('Local model recommendations need an active in-browser dataset.')
        const results = recommendMissingValues(rows, message.columns, message.featureColumns.slice(0, 16), message.seed, message.missingPercentByColumn, message.targetTypes, message.maxTrainingRows)
        send({ type: 'imputation-recommendations', requestId: message.requestId, sampleRows: rows.length, results })
      }
      else if (message.type === 'dry-run-risky' || message.type === 'apply-risky') {
        const decision = resolveDecisionColumns(message.decision, message.profile)
        if (activeConnection) {
          await executeDuckDbRisky(decision, message.protectedColumns, message.type === 'apply-risky')
          return
        }
        if (!message.rows) throw new Error('The current in-memory dataset is unavailable. Upload it again before reviewing this decision.')
        const dryRun = message.type === 'dry-run-risky'
        const execution = executeRiskyDecision(message.rows, decision, message.protectedColumns, dryRun, inMemoryRowOrderKey)
        if (dryRun) send({ type: 'risky-dry-run', result: execution.result })
        else {
          const columns = Object.keys(execution.rows[0] ?? Object.fromEntries(message.profile.columns.map((column) => [column.name, null]))).filter((name) => name !== inMemoryRowOrderKey)
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
          for (const table of duckDbEstimateTables) await activeConnection.query(`DROP TABLE IF EXISTS ${sqlIdentifier(table)}`).catch(() => undefined)
          duckDbEstimateTables.clear(); duckDbEstimateRuns.clear()
          await activeConnection.query('DROP TABLE IF EXISTS dataset_smart_clean')
          largeVersions = ['dataset_original']
          largeVersionRules = ['Original']
          largeHistoryCursor = 0
          await cleanLargeDataset(message.profile, message.protectedColumns, message.rules)
        }
        else {
          if (!message.rows) throw new Error('This dataset is no longer available in the browser worker.')
          const result = runSmartClean(message.rows, message.profile, message.protectedColumns, (progress) => send({ type: 'clean-progress', ...progress }), message.rules, message.excelDateRows, inMemoryRowOrderKey)
          const columns = Object.keys(result.rows[0] ?? Object.fromEntries(message.profile.columns.map((column) => [column.name, null]))).filter((name) => name !== inMemoryRowOrderKey)
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
        const rowOrderKey = addInMemoryRowOrder(result.rows, result.columns)
        const profile = profileDataset(result.rows, result.columns)
        if (result.raggedRows) profile.datasetIssues.push({ code: 'ragged-rows', severity: 'warning', message: 'Rows have a different number of fields from the header.', count: result.raggedRows })
        send({ type: 'complete', format: pendingWorkbookFormat, columns: result.columns, rowCount: result.rows.length, rows: result.rows, preview: result.rows.slice(0, 1000), profile, raggedRows: result.raggedRows, excelDateRows: result.excelDateRows, largeFileMode: false, rowOrderKey, note: 'Merged cells use the value from the top-left cell. Empty leading rows are preserved for header selection.' })
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
              largeVersions = ['dataset_original']; largeVersionRules = ['Original']; largeHistoryCursor = 0
            }
          }
        } catch { /* preserve and report the original clean failure below */ }
      }
      if (message.type === 'recommend-imputation') { send({ type: 'imputation-recommendation-failed', requestId: message.requestId, message: raw || 'The local recommendation failed.' }); return }
      if (message.type === 'compare-page') { send({ type: 'compare-page-failed', requestId: message.requestId, message: raw || 'The comparison query failed.' }); return }
      if (message.type === 'verify-export-file') { send({ type: 'verify-export-failed', requestId: message.requestId, message: raw || 'The generated file could not be verified.' }); return }
      if (message.type === 'export-stream' || message.type === 'export-removed-stream' || message.type === 'download-all-large') { exportPreparations.delete(message.requestId); cancelledExports.delete(message.requestId); exportStream = null; largeZipStream = null; send({ type: 'export-failed', requestId: message.requestId, message: raw || 'The local export failed.' }); return }
      if (message.type === 'dry-run-risky' || message.type === 'apply-risky') { send({ type: 'risky-failed', message: raw || 'The review action could not be completed.' }); return }
      const failureMessage = isMemoryError(error) ? 'This file needs more memory than the browser can provide. Close other tabs, split the file, or try CSV instead of XLSX.' : raw || 'We could not read this file.'
      send({ type: 'failed', message: failureMessage })
    }
  })()
}
