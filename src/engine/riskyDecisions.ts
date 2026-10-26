import type { ChangeStep, DataRow, DataValue, RiskyDecision, RiskyDryRun } from '../types'
import { swapDateMonthAndDay } from '../cleaners/dateNormalization'
import { parseFormattedNumber } from '../cleaners/rules'

const missing = (value: DataValue): boolean => value == null || typeof value === 'string' && ['', 'n/a', 'na', '-', 'null', 'none'].includes(value.trim().toLowerCase())
const numeric = (value: DataValue): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const parsed = parseFormattedNumber(value)
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null
}
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const center = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[center]! : (sorted[center - 1]! + sorted[center]!) / 2
}
const quantile = (values: number[], probability: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return 0
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}
const mode = (values: DataValue[]): DataValue => {
  const counts = new Map<string, { value: DataValue; count: number }>()
  for (const value of values.filter((item) => !missing(item))) {
    const key = String(value)
    const current = counts.get(key)
    counts.set(key, { value, count: (current?.count ?? 0) + 1 })
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || (String(a.value) < String(b.value) ? -1 : String(a.value) > String(b.value) ? 1 : 0))[0]?.value ?? null
}
const getString = (decision: RiskyDecision, key: string, fallback: string): string => typeof decision.options[key] === 'string' ? decision.options[key] as string : fallback
const getColumns = (decision: RiskyDecision, protectedColumns: string[]): string[] => decision.columns.filter((column) => !protectedColumns.includes(column))

function changedSamples(rows: DataRow[], next: DataRow[]): Array<{ before: DataRow; after: DataRow }> {
  const samples: Array<{ before: DataRow; after: DataRow }> = []
  const same = (left: DataRow, right: DataRow) => JSON.stringify(left) === JSON.stringify(right)
  if (rows.length > next.length) {
    const counts = new Map<string, number>()
    for (const row of next) { const key = JSON.stringify(row); counts.set(key, (counts.get(key) ?? 0) + 1) }
    for (const before of rows) {
      const key = JSON.stringify(before); const count = counts.get(key) ?? 0
      if (count) counts.set(key, count - 1)
      else if (samples.length < 10) samples.push({ before: { ...before }, after: {} })
    }
  } else {
    for (let index = 0; index < rows.length && samples.length < 10; index++) {
      const before = rows[index]!
      const after = next[index]
      if (!after || !same(before, after)) samples.push({ before: { ...before }, after: after ? { ...after } : {} })
    }
  }
  return samples
}

export function executeRiskyDecision(rows: DataRow[], decision: RiskyDecision, protectedColumns: string[] = [], dryRun = false, rowOrderKey?: string): { result: RiskyDryRun; rows: DataRow[] } {
  const columns = getColumns(decision, protectedColumns)
  let next = rows.map((row) => ({ ...row }))
  let rowsRemoved = 0
  let removedRowIds: number[] = []
  let cellsChanged = 0
  let cellsEstimated = 0
  let flaggedCells = 0
  let validationSamples: Array<{ before: DataRow; after: DataRow }> = []
  const action = getString(decision, 'action', decision.kind === 'handle-outliers' ? 'flag' : '')

  if (decision.kind === 'remove-duplicates') {
    const keysOption = decision.options.keys
    const keys = Array.isArray(keysOption) && keysOption.length ? keysOption as string[] : Object.keys(rows[0] ?? {}).filter((name) => name !== rowOrderKey)
    const keep = getString(decision, 'keep', 'first')
    const keyed = rows.map((row, index) => ({ row: { ...row }, index, key: JSON.stringify(keys.map((column) => row[column] ?? null)) }))
    const seen = new Set<string>()
    const filtered = keep === 'last' ? [...keyed].reverse().filter((item) => { if (seen.has(item.key)) return false; seen.add(item.key); return true }).reverse() : keyed.filter((item) => { if (seen.has(item.key)) return false; seen.add(item.key); return true })
    rowsRemoved = rows.length - filtered.length
    const retained = new Set(filtered.map((item) => item.index))
    removedRowIds = keyed.filter((item) => !retained.has(item.index)).map((item) => typeof item.row[rowOrderKey ?? ''] === 'number' ? item.row[rowOrderKey!] as number : item.index)
    next = filtered.map((item) => item.row)
  } else if (decision.kind === 'fill-missing') {
    const strategy = getString(decision, 'strategy', 'mode')
    const groupBy = getString(decision, 'groupBy', '')
    if (strategy === 'forward-fill' && decision.options.orderedRows !== true) throw new Error('Forward fill requires confirmation that rows are ordered by time or sequence.')
    const value = decision.options.value as DataValue
    if (strategy === 'drop-rows') {
      const keep = rows.map((row) => !columns.some((column) => missing(row[column])))
      removedRowIds = keep.flatMap((retained, index) => !retained ? [typeof rows[index]?.[rowOrderKey ?? ''] === 'number' ? rows[index]![rowOrderKey!] as number : index] : [])
      next = rows.filter((_, index) => keep[index])
      rowsRemoved = rows.length - next.length
    } else if (strategy === 'model-estimates') {
      const rawEstimates = getString(decision, 'estimatedValues', '{}')
      const parsedEstimates = JSON.parse(rawEstimates) as Record<string, Array<{ rowIndex: number; value: DataValue; uncertainty?: number }>>
      const estimatesByColumn = new Map(Object.entries(parsedEstimates).map(([column, values]) => [column, new Map(values.map((estimate) => [estimate.rowIndex, estimate]))]))
      for (const column of columns) {
        const estimates = estimatesByColumn.get(column)
        if (!estimates) continue
        const observed = rows.map((row) => numeric(row[column])).filter((item): item is number => item !== null)
        const minimum = observed.length ? observed.reduce((current, value) => Math.min(current, value), Number.POSITIVE_INFINITY) : Number.NEGATIVE_INFINITY
        const maximum = observed.length ? observed.reduce((current, value) => Math.max(current, value), Number.NEGATIVE_INFINITY) : Number.POSITIVE_INFINITY
        const integerTarget = decision.options.targetType === 'integer'
        const nonNegativeTarget = decision.options.nonNegative === true || observed.length > 0 && minimum >= 0
        next = next.map((row, rowIndex) => {
          const estimate = estimates.get(rowIndex)
          if (!estimate || !missing(row[column]) || estimate.value === null || typeof estimate.value === 'string' && missing(estimate.value)) return row
          let replacement = estimate.value
          if (typeof replacement === 'number') {
            if (!Number.isFinite(replacement)) return row
            replacement = Math.max(minimum, Math.min(maximum, replacement))
            if (integerTarget) replacement = Math.round(replacement)
            if (nonNegativeTarget) replacement = Math.max(0, replacement)
          }
          const changed = { ...row, [column]: replacement }
          cellsChanged++
          cellsEstimated++
          return changed
        })
      }
    } else if (strategy !== 'leave-null') {
      const stats = new Map<string, DataValue>()
      for (const column of columns) {
        const values = rows.map((row) => row[column]).filter((item) => !missing(item))
        if (strategy === 'constant') stats.set(column, value ?? '')
        else if (strategy === 'mean') { const nums = values.map(numeric).filter((item): item is number => item !== null); if (nums.length) stats.set(column, nums.reduce((sum, item) => sum + item, 0) / nums.length) }
        else if (strategy === 'median') { const nums = values.map(numeric).filter((item): item is number => item !== null); if (nums.length) stats.set(column, median(nums)) }
        else if (strategy === 'mode') stats.set(column, mode(values))
      }
      const groupedStats = new Map<string, Map<string, DataValue>>()
      if ((strategy === 'group-median' || strategy === 'group-mode') && groupBy && rows.some((row) => Object.hasOwn(row, groupBy))) {
        const grouped = new Map<string, DataRow[]>()
        for (const row of rows) {
          const key = JSON.stringify(row[groupBy] ?? null)
          const groupRows = grouped.get(key) ?? []
          groupRows.push(row)
          grouped.set(key, groupRows)
        }
        for (const [groupKey, groupRows] of grouped) {
          const byColumn = new Map<string, DataValue>()
          for (const column of columns) {
            if (column === groupBy) continue
            const present = groupRows.map((row) => row[column]).filter((item) => !missing(item))
            if (strategy === 'group-mode') {
              const replacement = mode(present)
              if (replacement !== null) byColumn.set(column, replacement)
            } else {
              const numbers = present.map(numeric).filter((item): item is number => item !== null)
              if (numbers.length) byColumn.set(column, median(numbers))
            }
          }
          groupedStats.set(groupKey, byColumn)
        }
      }
      const carried = new Map<string, DataValue>()
      next = rows.map((row) => {
        const changed = { ...row }
        for (const column of columns) {
          if (!missing(row[column])) { carried.set(column, row[column] ?? null); continue }
          const replacement = strategy === 'forward-fill' ? carried.get(column)
            : strategy === 'group-median' || strategy === 'group-mode' ? groupedStats.get(JSON.stringify(row[groupBy] ?? null))?.get(column)
              : stats.get(column)
          if (replacement !== undefined && replacement !== null) { changed[column] = replacement; cellsChanged++ }
        }
        return changed
      })
    }
    if (decision.options.addWasMissingIndicator === true) {
      const indicatorNames = new Map(columns.map((column) => {
        const base = `${column}__was_missing`
        let name = base; let suffix = 2
        while (Object.keys(rows[0] ?? {}).includes(name) || columns.includes(name)) name = `${base}_${suffix++}`
        return [column, name]
      }))
      next = next.map((row, index) => Object.fromEntries([...Object.entries(row), ...columns.map((column) => [indicatorNames.get(column)!, missing(rows[index]?.[column] ?? null)])]))
    }
  } else if (decision.kind === 'handle-outliers') {
    const actionKind = action || 'flag'
    const bounds = new Map<string, { low: number; high: number }>()
    const outlierRows = new Set<number>()
    for (const column of columns) {
      const values = rows.map((row) => numeric(row[column])).filter((item): item is number => item !== null)
      if (values.length < 4) continue
      const q1 = quantile(values, 0.25)
      const q3 = quantile(values, 0.75)
      const iqr = q3 - q1
      if (iqr === 0) continue
      const low = q1 - 1.5 * iqr; const high = q3 + 1.5 * iqr
      bounds.set(column, { low, high })
      rows.forEach((row, index) => { const number = numeric(row[column]); if (number !== null && (number < low || number > high)) outlierRows.add(index) })
    }
    flaggedCells = rows.reduce((sum, row) => sum + columns.filter((column) => { const number = numeric(row[column]); const bound = bounds.get(column); return number !== null && bound !== undefined && (number < bound.low || number > bound.high) }).length, 0)
    if (actionKind === 'remove') {
      removedRowIds = [...outlierRows].map((index) => typeof rows[index]?.[rowOrderKey ?? ''] === 'number' ? rows[index]![rowOrderKey!] as number : index)
      next = rows.filter((_, index) => !outlierRows.has(index)); rowsRemoved = rows.length - next.length
    } else if (actionKind === 'cap') {
      next = rows.map((row) => {
        const changed = { ...row }
        for (const [column, bound] of bounds) {
          const number = numeric(row[column])
          if (number !== null && (number < bound.low || number > bound.high)) { changed[column] = Math.max(bound.low, Math.min(bound.high, number)); cellsChanged++ }
        }
        return changed
      })
    }
  } else if (decision.kind === 'resolve-validation') {
    const selectedAction = getString(decision, 'action', 'leave')
    const flaggedIndices: number[] = []
    next = rows.map((row, rowIndex) => {
      const changed = { ...row }
      for (const column of columns) {
        const number = numeric(row[column] ?? null)
        if (number === null || number >= 0) continue
        flaggedCells += 1
        if (flaggedIndices.length < 10 && !flaggedIndices.includes(rowIndex)) flaggedIndices.push(rowIndex)
        if (selectedAction === 'empty') { changed[column] = null; cellsChanged += 1 }
        else if (selectedAction === 'absolute') { changed[column] = Math.abs(number); cellsChanged += 1 }
      }
      return changed
    })
    validationSamples = flaggedIndices.map((rowIndex) => ({ before: { ...rows[rowIndex]! }, after: { ...next[rowIndex]! } }))
  } else if (decision.kind === 'standardize-categories') {
    const raw = getString(decision, 'mapping', '{}')
    const mapping = JSON.parse(raw) as Record<string, string>
    const normalized = new Map<string, string>()
    for (const [source, target] of Object.entries(mapping)) {
      const key = source.trim().toLowerCase()
      const previous = normalized.get(key)
      if (previous !== undefined && previous !== target) throw new Error(`Conflicting category mappings for “${source.trim()}”.`)
      normalized.set(key, target)
    }
    next = rows.map((row) => {
      const changed = { ...row }
      for (const column of columns) {
        const current = row[column]
        if (typeof current !== 'string') continue
        const replacement = normalized.get(current.trim().toLowerCase())
        if (replacement !== undefined && replacement !== current) { changed[column] = replacement; cellsChanged++ }
      }
      return changed
    })
  } else if (decision.kind === 'resolve-ambiguous-dates') {
    const order = getString(decision, 'order', 'day-first')
    next = rows.map((row) => {
      const changed = { ...row }
      for (const column of columns) {
        const current = row[column]
        if (typeof current !== 'string') continue
        const match = current.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
        if (!match) continue
        const first = Number(match[1]); const second = Number(match[2]); const year = match[3]
        if (first > 12 || second > 12) continue
        const day = order === 'day-first' ? first : second; const month = order === 'day-first' ? second : first
        if (day < 1 || month < 1 || day > 31 || month > 12) continue
        const date = new Date(Date.UTC(Number(year), month - 1, day))
        if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) continue
        const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
        if (iso !== current) { changed[column] = iso; cellsChanged++ }
      }
      return changed
    })
  } else if (decision.kind === 'swap-excel-date-components') {
    const signaturesOption = decision.options.rowSignatures
    const signatures = new Set(Array.isArray(signaturesOption) ? signaturesOption : [])
    next = rows.map((row) => {
      const changed = { ...row }
      for (const column of columns) {
        if (!signatures.has(JSON.stringify({ column, row }))) continue
        const current = row[column]
        if (typeof current !== 'string') continue
        const swapped = swapDateMonthAndDay(current)
        if (swapped && swapped !== current) { changed[column] = swapped; cellsChanged++ }
      }
      return changed
    })
  }

  const samples = validationSamples.length ? validationSamples : changedSamples(rows, next)
  if (decision.kind === 'handle-outliers' && action === 'flag' && !samples.length) {
    const sampleBounds = new Map<string, { low: number; high: number }>()
    for (const column of columns) {
      const values = rows.map((item) => numeric(item[column])).filter((item): item is number => item !== null)
      if (values.length < 4) continue
      const lowQuartile = quantile(values, 0.25)
      const highQuartile = quantile(values, 0.75)
      const spread = highQuartile - lowQuartile
      if (spread > 0) sampleBounds.set(column, { low: lowQuartile - 1.5 * spread, high: highQuartile + 1.5 * spread })
    }
    for (const row of rows) {
      if (samples.length >= 10) break
      const isOutlier = columns.some((column) => {
        const number = numeric(row[column])
        const bound = sampleBounds.get(column)
        return number !== null && bound !== undefined && (number < bound.low || number > bound.high)
      })
      if (isOutlier) samples.push({ before: { ...row }, after: { ...row } })
    }
  }
  const result: RiskyDryRun = { decision, rowsBefore: rows.length, rowsAfter: next.length, rowsRemoved, ...(removedRowIds.length ? { removedRowIds } : {}), cellsChanged, cellsEstimated, flaggedCells, samples }
  return { result, rows: dryRun ? rows : next }
}

export function makeChangeStep(dryRun: RiskyDryRun): ChangeStep {
  const model = typeof dryRun.decision.options.model === 'string' ? dryRun.decision.options.model : undefined
  let validationSummary = ''
  let uncertaintyKind: 'numeric' | 'categorical' = 'numeric'
  let validationDetails: Record<string, string> | undefined
  if (model && typeof dryRun.decision.options.validation === 'string') {
    try {
      const validation = JSON.parse(dryRun.decision.options.validation) as Record<string, unknown>
      if (validation.kind === 'numeric') validationSummary = ` · MAE ${Number(validation.modelMae).toFixed(3)} / MAPE ${validation.modelMape == null ? 'n/a' : `${Number(validation.modelMape).toFixed(2)}%`}`
      else if (validation.kind === 'categorical') { uncertaintyKind = 'categorical'; validationSummary = ` · accuracy ${(Number(validation.modelAccuracy) * 100).toFixed(1)}%` }
      validationDetails = Object.fromEntries(dryRun.decision.columns.map((column) => [column, `${model}${validationSummary}`]))
    } catch { validationSummary = '' }
  }
  let estimateUncertaintyByColumn: Record<string, Record<string, { value: number; kind: 'numeric' | 'categorical' }>> | undefined
  if (dryRun.cellsEstimated && typeof dryRun.decision.options.estimatedValues === 'string') {
    try {
      const values = JSON.parse(dryRun.decision.options.estimatedValues) as Record<string, Array<{ rowIndex: number; uncertainty?: number }>>
      estimateUncertaintyByColumn = Object.fromEntries(Object.entries(values).map(([column, estimates]) => [column, Object.fromEntries(estimates.filter((item) => Number.isInteger(item.rowIndex) && typeof item.uncertainty === 'number' && Number.isFinite(item.uncertainty)).map((item) => [String(item.rowIndex), { value: item.uncertainty!, kind: uncertaintyKind }]))]))
    } catch { estimateUncertaintyByColumn = undefined }
  }
  return { id: crypto.randomUUID(), label: model ? `${dryRun.decision.kind} · ${model}${validationSummary}` : dryRun.decision.kind, ruleId: dryRun.decision.kind, scope: { mode: 'explicit', include: [...dryRun.decision.columns] }, timestamp: new Date().toISOString(), rowsBefore: dryRun.rowsBefore, rowsAfter: dryRun.rowsAfter, rowsRemoved: dryRun.rowsRemoved, ...(dryRun.removedRowIds?.length ? { removedRowIds: dryRun.removedRowIds } : {}), cellsChanged: dryRun.cellsChanged, cellsEstimated: dryRun.cellsEstimated ?? 0, ...(validationDetails ? { estimateDetailsByColumn: validationDetails } : {}), ...(estimateUncertaintyByColumn ? { estimateUncertaintyByColumn } : {}), columnsRenamed: 0, flaggedCells: dryRun.flaggedCells, samples: dryRun.samples, undone: false }
}
