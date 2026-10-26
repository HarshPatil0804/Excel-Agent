import { quoteSqlIdentifier, quoteSqlString } from './riskySql'
import { predictFromTrainingSample } from './localImputation'
import type { DataRow, DataValue } from '../types'

const MAX_TRAINING_SAMPLE = 50_000
export interface DuckDbEstimate { rowOrder: number; value: DataValue; uncertainty: number }
export interface DuckDbEstimateBatchOptions {
  trainingRows: DataRow[]
  target: string
  features: string[]
  targetType: string
  model?: 'weighted-knn' | 'ridge-regression'
  min?: number
  max?: number
  integerTarget?: boolean
  nonNegative?: boolean
  insertBatch: (estimates: DuckDbEstimate[]) => Promise<void>
  onProgress?: (processedRows: number, estimatedCells: number) => void | Promise<void>
  isCancelled?: () => boolean
}

/** Consumes bounded DuckDB pages, predicts only missing cells, and persists each estimate page before continuing. */
export async function processDuckDbEstimateBatches(batches: AsyncIterable<DataRow[]>, options: DuckDbEstimateBatchOptions): Promise<{ processedRows: number; estimatedCells: number; cancelled: boolean }> {
  let processedRows = 0
  let estimatedCells = 0
  for await (const batch of batches) {
    if (options.isCancelled?.()) return { processedRows, estimatedCells, cancelled: true }
    const estimates = predictFromTrainingSample(options.trainingRows, batch, options.target, options.features, options.targetType, '__dc_order', options.model ?? 'weighted-knn')
      .map((estimate) => {
        let value = estimate.value
        if (typeof value === 'number') {
          value = Math.max(options.min ?? Number.NEGATIVE_INFINITY, Math.min(options.max ?? Number.POSITIVE_INFINITY, value))
          if (options.integerTarget) value = Math.round(value)
          if (options.nonNegative) value = Math.max(0, value)
        }
        return { rowOrder: estimate.sampleRow, value, uncertainty: estimate.uncertainty }
      })
    if (estimates.length) await options.insertBatch(estimates)
    processedRows += batch.length
    estimatedCells += estimates.length
    await options.onProgress?.(processedRows, estimatedCells)
  }
  return { processedRows, estimatedCells, cancelled: false }
}

/** Select a deterministic, well-distributed sample without dropping 99% of small tables. */
export function buildDuckDbImputationSampleSql(columns: string[], limit = MAX_TRAINING_SAMPLE, table = 'dataset'): string {
  if (!columns.length) throw new Error('At least one target or predictor column is required for local estimates.')
  const safeLimit = Math.min(MAX_TRAINING_SAMPLE, Math.max(1, Math.floor(limit)))
  const projection = [...new Set(columns)].map(quoteSqlIdentifier).join(', ')
  return `SELECT ${projection} FROM ${quoteSqlIdentifier(table)} ORDER BY HASH(${quoteSqlIdentifier('__dc_order')}), ${quoteSqlIdentifier('__dc_order')} LIMIT ${safeLimit}`
}

export function buildDuckDbImputationViewSql(source: string, table: string, columns: string[], target: string, indicator?: string, targetType = 'text'): string {
  if (!columns.includes(target)) throw new Error(`Imputation target “${target}” is not in the source schema.`)
  const sourceAlias = 'source_row'
  const estimateAlias = 'estimate_row'
  const castType = targetType === 'integer' ? 'BIGINT' : targetType === 'float' ? 'DOUBLE' : 'VARCHAR'
  const projection = columns.map((name) => name === target
    ? `CASE WHEN ${estimateAlias}."__dc_order" IS NOT NULL THEN CAST(${estimateAlias}."estimate_value" AS ${castType}) ELSE ${sourceAlias}.${quoteSqlIdentifier(name)} END AS ${quoteSqlIdentifier(name)}`
    : `${sourceAlias}.${quoteSqlIdentifier(name)}`)
  if (indicator) projection.push(`CASE WHEN ${estimateAlias}."__dc_order" IS NOT NULL THEN TRUE ELSE FALSE END AS ${quoteSqlIdentifier(indicator)}`)
  projection.push(`${sourceAlias}."__dc_order"`)
  return `SELECT ${projection.join(', ')} FROM ${quoteSqlIdentifier(source)} AS ${sourceAlias} LEFT JOIN ${quoteSqlIdentifier(table)} AS ${estimateAlias} ON ${estimateAlias}."__dc_order" = ${sourceAlias}."__dc_order" AND ${estimateAlias}."__dc_column" = ${quoteSqlString(target)}`
}
