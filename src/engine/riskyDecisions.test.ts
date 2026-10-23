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

  it('does not fill all-null columns with a synthetic mean', () => {
    const rows = [{ value: null }, { value: null }]
    const result = executeRiskyDecision(rows, decision('fill-missing', ['value'], { strategy: 'mean' }))
    expect(result.result.cellsChanged).toBe(0)
    expect(result.rows).toEqual(rows)
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
