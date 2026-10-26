import { describe, expect, it } from 'vitest'
import type { PlannedRule } from '../types'
import { countRemainingDecisions, countSelectedColumns, selectFillColumnsByType } from './reviewMetrics'

const proposal: PlannedRule = {
  rule: { id: 'duplicates', kind: 'remove-duplicates', enabled: false, risk: 'high', scope: { mode: 'all' }, options: {} },
  columns: ['id'], columnIds: ['column-1'], proposed: true, status: 'pending', reason: 'Duplicate rows found',
}

describe('review metrics', () => {
  it('counts distinct selected columns and never exceeds the dataset width', () => {
    expect(countSelectedColumns(['a', 'a', 'b'], 4)).toBe(2)
    expect(countSelectedColumns(['a', 'a', 'b', 'c'], 2)).toBe(2)
    expect(countSelectedColumns(['a'], 0)).toBe(0)
    expect(countSelectedColumns([], 4)).toBe(0)
  })

  it('keeps pending and decide-later proposals unresolved until an explicit decision', () => {
    expect(countRemainingDecisions([proposal], {})).toBe(1)
    expect(countRemainingDecisions([proposal], { duplicates: 'later' })).toBe(1)
    expect(countRemainingDecisions([proposal], { duplicates: 'accepted' })).toBe(0)
    expect(countRemainingDecisions([proposal], { duplicates: 'skipped' })).toBe(0)
  })

  it('selects numeric fill targets in bulk while excluding IDs, protected columns, and duplicates', () => {
    const columns = [
      { name: 'amount', inferredType: 'float' as const, issues: [] },
      { name: 'count', inferredType: 'integer' as const, issues: [] },
      { name: 'customer_id', inferredType: 'integer' as const, issues: [{ code: 'identifier-column' }] },
      { name: 'category', inferredType: 'categorical' as const, issues: [] },
    ]
    expect(selectFillColumnsByType(columns, ['amount', 'count', 'customer_id', 'amount'], ['integer', 'float'], ['count'])).toEqual(['amount'])
  })
})
