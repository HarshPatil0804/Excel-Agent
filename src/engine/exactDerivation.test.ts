import { describe, expect, it } from 'vitest'
import { detectProductDerivations } from './exactDerivation'
import { executeRiskyDecision } from './riskyDecisions'
import type { DataRow, RiskyDecision } from '../types'

const makeRows = (): DataRow[] => Array.from({ length: 240 }, (_, index) => ({
  Quantity: index % 9 + 1,
  'Unit Price': index % 17 + 2,
  Revenue: index % 9 === 0 ? null : (index % 9 + 1) * (index % 17 + 2),
}))

describe('user-confirmed exact product derivation', () => {
  it('suggests only an exact, well-supported relation and returns its fill count', () => {
    const rows = makeRows()
    const [suggestion] = detectProductDerivations(rows, ['Revenue'], Object.keys(rows[0]!))
    expect(suggestion).toMatchObject({ target: 'Revenue', left: 'Quantity', right: 'Unit Price', observedRows: 213, fillableRows: 27, matchPercent: 100 })
    expect(suggestion?.samples[0]).toMatchObject({ before: null, after: 24 })
  })

  it('does not suggest a formula when observed values contradict the relation', () => {
    const rows = makeRows()
    rows[1]!.Revenue = 999
    expect(detectProductDerivations(rows, ['Revenue'], Object.keys(rows[0]!))).toEqual([])
  })

  it('dry-runs and applies only to missing targets without mutating observed cells', () => {
    const rows = makeRows()
    const decision: RiskyDecision = { kind: 'fill-missing', columns: ['Revenue'], options: { strategy: 'exact-derivation', formulaLeft: 'Quantity', formulaRight: 'Unit Price', applyToAll: false } }
    const preview = executeRiskyDecision(rows, decision, [], true)
    expect(preview.result).toMatchObject({ rowsRemoved: 0, cellsChanged: 27 })
    expect(preview.result.samples).toHaveLength(10)
    expect(preview.rows).toEqual(rows)
    const applied = executeRiskyDecision(rows, decision)
    expect(applied.rows.every((row, index) => row.Revenue === null || row.Revenue === rows[index]!.Revenue)).toBe(true)
    expect(applied.rows.filter((row) => row.Revenue === null)).toHaveLength(0)
    expect(applied.rows[0]?.Revenue).toBe(2 * 2)
  })
})
