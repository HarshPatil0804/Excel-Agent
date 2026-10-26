import { describe, expect, it } from 'vitest'
import { executeRiskyDecision, makeChangeStep } from './riskyDecisions'
import { profileDataset } from '../profiler/profile'
import { useDatasetStore } from '../store/datasetStore'
import type { DataRow, RiskyDecision } from '../types'

const decision = (kind: RiskyDecision['kind'], columns: string[], options: RiskyDecision['options'] = {}): RiskyDecision => ({ kind, columns, options })

describe('risky decision dry runs and application', () => {
  it('dry-runs duplicates by selected keys and keeps the requested last row', () => {
    const rows = [{ id: 1, label: 'old' }, { id: 1, label: 'new' }, { id: 2, label: 'other' }]
    const preview = executeRiskyDecision(rows, decision('remove-duplicates', ['id'], { keys: ['id'], keep: 'last' }), [], true)
    expect(preview.result.rowsRemoved).toBe(1)
    expect(preview.result.samples[0]?.after).toEqual({})
    expect(rows).toHaveLength(3)
    const applied = executeRiskyDecision(rows, decision('remove-duplicates', ['id'], { keys: ['id'], keep: 'last' }))
    expect(applied.rows.map((row) => row.label)).toEqual(['new', 'other'])
  })

  it('keeps internal row-order metadata out of all-column duplicate matching', () => {
    const rows: DataRow[] = [
      { __dc_internal_row_order: 0, id: 'a', value: 'same' },
      { __dc_internal_row_order: 1, id: 'b', value: 'same' },
      { __dc_internal_row_order: 2, id: 'a', value: 'same' },
    ]
    const result = executeRiskyDecision(rows, decision('remove-duplicates', ['id', 'value'], { keys: [], keep: 'first' }), [], false, '__dc_internal_row_order')
    expect(result.result.rowsRemoved).toBe(1)
    expect(result.result.removedRowIds).toEqual([2])
    expect(result.rows.map((row) => row.__dc_internal_row_order)).toEqual([0, 1])
  })

  it('does not fill all-null columns with a synthetic mean', () => {
    const rows = [{ value: null }, { value: null }]
    const result = executeRiskyDecision(rows, decision('fill-missing', ['value'], { strategy: 'mean' }))
    expect(result.result.cellsChanged).toBe(0)
    expect(result.rows).toEqual(rows)
  })

  it('fills missing values with deterministic median or mode within a chosen group', () => {
    const rows: DataRow[] = [
      { category: 'A', amount: '10', label: 'red' },
      { category: 'A', amount: null, label: null },
      { category: 'A', amount: '30', label: 'red' },
      { category: 'B', amount: '100', label: 'blue' },
      { category: 'B', amount: null, label: null },
      { category: 'B', amount: '200', label: 'green' },
    ]
    const medianResult = executeRiskyDecision(rows, decision('fill-missing', ['amount'], { strategy: 'group-median', groupBy: 'category' }))
    const modeResult = executeRiskyDecision(rows, decision('fill-missing', ['label'], { strategy: 'group-mode', groupBy: 'category' }))
    expect(medianResult.rows.map((row) => row.amount)).toEqual(['10', 20, '30', '100', 150, '200'])
    expect(modeResult.rows.map((row) => row.label)).toEqual(['red', 'red', 'red', 'blue', 'blue', 'green'])
    expect(medianResult.result.cellsChanged).toBe(2)
    expect(modeResult.result.cellsChanged).toBe(2)
    expect(rows[1]?.amount).toBeNull()
  })

  it('requires an explicit row-order assertion before forward fill', () => {
    const rows = [{ timestamp: '2026-01-01', value: 'seen' }, { timestamp: '2026-01-02', value: null }]
    expect(() => executeRiskyDecision(rows, decision('fill-missing', ['value'], { strategy: 'forward-fill' }))).toThrow(/ordered by time/i)
    expect(executeRiskyDecision(rows, decision('fill-missing', ['value'], { strategy: 'forward-fill', orderedRows: true })).rows[1]?.value).toBe('seen')
  })

  it('dry-runs and applies validated model estimates only to missing cells, records counts, and supports undo', () => {
    const original: DataRow[] = [{ revenue: 10 }, { revenue: null }, { revenue: null }, { revenue: null }]
    const estimates = JSON.stringify({ revenue: [{ rowIndex: 1, value: 80, uncertainty: 0.1 }, { rowIndex: 2, value: 5, uncertainty: 0.2 }] })
    const modelDecision = decision('fill-missing', ['revenue'], {
      strategy: 'model-estimates', estimatedValues: estimates, model: 'weighted-knn', validation: '{"kind":"numeric","modelMae":1.2}', targetType: 'integer', nonNegative: true,
    })
    const dry = executeRiskyDecision(original, modelDecision, [], true)
    expect(dry.result).toMatchObject({ cellsChanged: 2, cellsEstimated: 2, rowsRemoved: 0 })
    expect(dry.result.samples).toHaveLength(2)
    expect(dry.rows).toEqual(original)
    const applied = executeRiskyDecision(original, modelDecision)
    expect(applied.rows).toEqual([{ revenue: 10 }, { revenue: 10 }, { revenue: 10 }, { revenue: null }])
    const step = makeChangeStep(applied.result)
    expect(step).toMatchObject({ ruleId: 'fill-missing', label: expect.stringContaining('fill-missing · weighted-knn · MAE 1.200'), cellsChanged: 2, cellsEstimated: 2 })
    expect(step.estimateUncertaintyByColumn).toEqual({ revenue: { '1': { value: 0.1, kind: 'numeric' }, '2': { value: 0.2, kind: 'numeric' } } })

    const beforeProfile = profileDataset(original, ['revenue'])
    const afterProfile = profileDataset(applied.rows, ['revenue'])
    const store = useDatasetStore.getState()
    store.clear()
    store.setParsedDataset({ id: 'estimate-undo', name: 'estimate.csv', format: 'csv', sizeBytes: 50, rowCount: 4, columnCount: 1, createdAt: new Date().toISOString(), largeFileMode: false }, beforeProfile, original, original)
    store.setCleanResult({ rows: original, groups: [], proposed: [], protectedColumns: [], changeLog: [] })
    store.applyDecision(applied.rows, afterProfile, step)
    expect(useDatasetStore.getState().changeSteps.at(-1)?.cellsEstimated).toBe(2)
    useDatasetStore.getState().undo()
    expect(useDatasetStore.getState().rows).toEqual(original)
    useDatasetStore.getState().redo()
    expect(useDatasetStore.getState().rows).toEqual(applied.rows)
    useDatasetStore.getState().clear()
  })

  it('flags no outliers for zero-variance columns', () => {
    const rows = Array.from({ length: 10 }, () => ({ value: 7 }))
    const result = executeRiskyDecision(rows, decision('handle-outliers', ['value'], { action: 'flag' }))
    expect(result.result.flaggedCells).toBe(0)
    expect(result.result.cellsChanged).toBe(0)
  })

  it('rejects category mappings that conflict after case normalization', () => {
    const rows = [{ category: 'North' }]
    expect(() => executeRiskyDecision(rows, decision('standardize-categories', ['category'], { mapping: '{"North":"N"," north ":"Other"}' }))).toThrow(/Conflicting category mappings/)
  })

  it('dry-runs bulk negative-value validation without mutating source rows', () => {
    const rows: DataRow[] = [{ quantity: -2, profit: '-3' }, { quantity: 1, profit: '4' }]
    const dry = executeRiskyDecision(rows, decision('resolve-validation', ['quantity', 'profit'], { action: 'empty' }), [], true)
    expect(dry.result).toMatchObject({ cellsChanged: 2, flaggedCells: 2, rowsRemoved: 0 })
    expect(dry.result.samples).toHaveLength(1)
    expect(dry.rows).toEqual(rows)
    const empty = executeRiskyDecision(rows, decision('resolve-validation', ['quantity', 'profit'], { action: 'empty' }))
    expect(empty.rows).toEqual([{ quantity: null, profit: null }, { quantity: 1, profit: '4' }])
    const absolute = executeRiskyDecision(rows, decision('resolve-validation', ['quantity', 'profit'], { action: 'absolute' }))
    expect(absolute.rows).toEqual([{ quantity: 2, profit: 3 }, { quantity: 1, profit: '4' }])
  })

  it('restores the exact pre-decision rows when a risky step is undone', () => {
    const original: DataRow[] = [{ id: 1, name: 'A' }, { id: 1, name: 'A' }]
    const profile = profileDataset(original, ['id', 'name'])
    const store = useDatasetStore.getState()
    store.clear()
    store.setParsedDataset({ id: 'undo-test', name: 'test.csv', format: 'csv', sizeBytes: 10, rowCount: 2, columnCount: 2, createdAt: new Date().toISOString(), largeFileMode: false }, profile, original, original)
    store.setCleanResult({ rows: original, groups: [{ ruleId: 'test', category: 'test', label: 'test', columnCount: 0, columns: [], affectedRows: 0, samples: [] }], proposed: [], protectedColumns: [], changeLog: [] })
    const applied = executeRiskyDecision(original, decision('remove-duplicates', ['id', 'name'], { keys: ['id', 'name'], keep: 'first' }))
    useDatasetStore.getState().applyDecision(applied.rows, profile, makeChangeStep(applied.result))
    expect(useDatasetStore.getState().rows).toHaveLength(1)
    useDatasetStore.getState().undo()
    expect(useDatasetStore.getState().rows).toEqual(original)
    expect(useDatasetStore.getState().changeSteps.at(-1)?.undone).toBe(true)
    useDatasetStore.getState().clear()
  })
})
