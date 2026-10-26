import { buildDuckDbCompareAfterSql, type DuckDbCompareColumn } from './duckdbCompare'
import { buildDuckDbJsonExportProjection, normalizeDuckDbJsonValue } from './duckdbExport'
import { StreamingStoredZipWriter } from '../lib/zip'
import type { InferredType } from '../types'

export interface BundleColumn { source: string; name: string; type?: InferredType }
export interface DuckDbBundleOptions {
  requestId: string
  format: 'csv' | 'jsonl'
  columns: BundleColumn[]
  fileName: string
  report: string
  recipe: string
  ruleByColumn: Record<string, string>
  stepByColumn: Record<string, number>
  bom: boolean
  cleanRows: number
  changedCells: number
  compareColumns: DuckDbCompareColumn[]
}
export type BundleQuery = (sql: string) => Promise<Array<Record<string, unknown>>>
export interface DuckDbBundleChunk { bytes: Uint8Array; done: boolean; rowsProcessed: number; rowCount: number; stage: string }

interface BundleEntry { name: string; kind: 'clean' | 'changes' | 'static'; data?: string }

const escapeCsv = (value: unknown): string => {
  if (value == null || value === 'null' || value === 'undefined' || value === 'None' || value === 'NaN') return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** Pages DuckDB query results through a worker-friendly, uncompressed ZIP store writer. */
export class DuckDbBundleSession {
  readonly requestId: string
  readonly rowCount: number
  private readonly options: DuckDbBundleOptions
  private readonly zip = new StreamingStoredZipWriter()
  private readonly entries: BundleEntry[]
  private entryIndex = 0
  private entryState: 'header' | 'data' | 'end' = 'header'
  private offset = 0
  private rowsProcessed = 0
  private lastOrderId = -1
  private lastChangeRowId = -1
  private lastChangeColumn = ''
  private readonly orderAlias: string

  constructor(options: DuckDbBundleOptions) {
    this.options = options
    this.requestId = options.requestId
    this.rowCount = options.cleanRows + options.changedCells
    let orderAlias = '__dc_hidden_export_order'
    while (options.columns.some((column) => column.source === orderAlias || column.name === orderAlias)) orderAlias += '_'
    this.orderAlias = orderAlias
    this.entries = [
      { name: options.fileName, kind: 'clean' },
      { name: 'changes.csv', kind: 'changes' },
      { name: 'cleaning-report.md', kind: 'static', data: options.report },
      { name: 'recipe.json', kind: 'static', data: options.recipe },
    ]
  }

  async next(query: BundleQuery): Promise<DuckDbBundleChunk> {
    while (true) {
      const entry = this.entries[this.entryIndex]
      if (!entry) return { bytes: this.zip.finish(), done: true, rowsProcessed: this.rowsProcessed, rowCount: this.rowCount, stage: 'Finishing ZIP' }
      if (this.entryState === 'header') {
        this.entryState = 'data'
        return this.chunk(this.zip.beginEntry(entry.name), this.stageName(entry))
      }
      if (this.entryState === 'end') {
        const bytes = this.zip.endEntry()
        this.entryIndex += 1
        this.entryState = 'header'
        this.offset = 0
        this.lastOrderId = -1
        this.lastChangeRowId = -1
        this.lastChangeColumn = ''
        return this.chunk(bytes, this.stageName(this.entries[this.entryIndex]))
      }
      if (entry.kind === 'static') {
        const bytes = this.zip.write(entry.data ?? '')
        this.entryState = 'end'
        return this.chunk(bytes, `Writing ${entry.name}`)
      }
      if (entry.kind === 'clean') {
        if (this.offset >= this.options.cleanRows) { this.entryState = 'end'; continue }
        const columns = this.options.columns
        const rowBatch = Math.max(1, Math.min(5000, Math.floor(250_000 / Math.max(columns.length, 1))))
        const projection = this.options.format === 'jsonl' ? buildDuckDbJsonExportProjection(columns) : columns.map((column) => this.id(column.source)).join(', ')
        const page = await query(`SELECT ${projection}, "__dc_order" AS ${this.id(this.orderAlias)} FROM dataset WHERE "__dc_order" > ${this.lastOrderId} ORDER BY "__dc_order" LIMIT ${rowBatch}`)
        let text = ''
        if (this.offset === 0 && this.options.format === 'csv') text = `${this.options.bom ? '\uFEFF' : ''}${columns.map((column) => escapeCsv(column.name)).join(',')}\r\n`
        if (this.options.format === 'csv') text += page.map((row) => columns.map((column) => row[column.source]).map(escapeCsv).join(',')).join('\r\n') + (page.length ? '\r\n' : '')
        else text += page.map((row) => JSON.stringify(Object.fromEntries(columns.map((column) => [column.name, normalizeDuckDbJsonValue(row[column.source])])))).join('\n') + (page.length ? '\n' : '')
        this.offset += page.length
        if (page.length) this.lastOrderId = Number(page[page.length - 1]?.[this.orderAlias] ?? this.lastOrderId)
        this.rowsProcessed = Math.min(this.offset, this.options.cleanRows)
        if (!page.length || this.offset >= this.options.cleanRows) this.entryState = 'end'
        return this.chunk(this.zip.write(text), 'Writing cleaned data')
      }
      if (this.offset >= this.options.changedCells) { this.entryState = 'end'; continue }
      const cursor = this.lastChangeRowId < 0 ? undefined : { rowId: this.lastChangeRowId, column: this.lastChangeColumn }
      const page = await query(buildDuckDbCompareAfterSql(this.options.compareColumns, 5000, cursor))
      let text = ''
      if (this.offset === 0) text = 'row_id,column,before,after,rule,step\r\n'
      text += page.map((row) => [
        Number(row.row_id) + 1,
        row.column,
        row.before,
        row.after,
        this.options.ruleByColumn[String(row.column)] ?? 'cleaning rule',
        this.options.stepByColumn[String(row.column)] ?? 1,
      ].map(escapeCsv).join(',')).join('\r\n') + (page.length ? '\r\n' : '')
      this.offset += page.length
      if (page.length) {
        this.lastChangeRowId = Number(page[page.length - 1]?.row_id ?? this.lastChangeRowId)
        this.lastChangeColumn = String(page[page.length - 1]?.column ?? this.lastChangeColumn)
      }
      this.rowsProcessed = this.options.cleanRows + Math.min(this.offset, this.options.changedCells)
      if (!page.length || this.offset >= this.options.changedCells) this.entryState = 'end'
      return this.chunk(this.zip.write(text), 'Writing changes CSV')
    }
  }

  private chunk(bytes: Uint8Array, stage: string): DuckDbBundleChunk {
    return { bytes, done: false, rowsProcessed: this.rowsProcessed, rowCount: this.rowCount, stage }
  }

  private stageName(entry?: BundleEntry): string {
    if (!entry) return 'Finishing ZIP'
    if (entry.kind === 'clean') return 'Writing cleaned data'
    if (entry.kind === 'changes') return 'Writing changes CSV'
    return `Writing ${entry.name}`
  }

  private id(value: string): string { return `"${value.replaceAll('"', '""')}"` }
}
