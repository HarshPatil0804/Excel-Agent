import { describe, expect, it } from 'vitest'
import { compareCsvExportPage, compareJsonlExportPage } from './streamVerification'
import type { DataRow } from '../types'

describe('incremental CSV export verification', () => {
  it('matches selected and renamed columns, empty nulls, numbers, and Unicode', () => {
    const expected: DataRow[] = [{ amount: 123.5, 'old name': null, note: 'café 😀, "quoted"' }]
    const actual = [{ Amount: '123.5', cleaned_name: '', note: 'café 😀, "quoted"' }]
    const columns = [{ source: 'amount', name: 'Amount' }, { source: 'old name', name: 'cleaned_name' }, { source: 'note', name: 'note' }]
    expect(compareCsvExportPage(actual, expected, columns, 8)).toEqual([])
  })

  it('reports mismatches with the dataset row number and column name', () => {
    expect(compareCsvExportPage([{ amount: '2' }], [{ amount: 1 }], [{ source: 'amount', name: 'amount' }], 20)).toEqual([
      'Row 21, “amount”: expected 1, got 2.',
    ])
  })

  it('preserves JSON number, boolean, empty-string, and null types', () => {
    const columns = [{ source: 'amount', name: 'amount', type: 'float' as const }, { source: 'active', name: 'active', type: 'boolean' as const }, { source: 'empty', name: 'empty', type: 'text' as const }, { source: 'missing', name: 'missing', type: 'text' as const }]
    const expected: DataRow[] = [{ amount: 4.5, active: true, empty: '', missing: null }]
    expect(compareJsonlExportPage([{ amount: 4.5, active: true, empty: '', missing: null }], expected, columns, 0)).toEqual([])
    expect(compareJsonlExportPage([{ amount: '4.5', active: true, empty: '', missing: null }], expected, columns, 0)).toHaveLength(1)
  })
})
