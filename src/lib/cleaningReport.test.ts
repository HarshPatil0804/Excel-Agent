import { describe, expect, it } from 'vitest'
import { buildCleaningReportMarkdown } from './cleaningReport'

describe('cleaning report', () => {
  it('includes separate totals, ordered step metadata, at most ten samples, decisions, and unchanged flags', () => {
    const report = buildCleaningReportMarkdown({
      datasetName: 'sample.csv', rowsBefore: 12, rowsAfter: 10, columnsBefore: 3, columnsAfter: 2,
      cellsChanged: 8, cellsFilled: 2, cellsEstimated: 0, rowsRemoved: 2, columnsRenamed: 1, cellsFlagged: 4,
      steps: [{
        label: 'Fill missing values', ruleId: 'fill-missing', scope: { mode: 'byIssue' }, timestamp: '2026-10-26T00:00:00.000Z',
        cellsChanged: 2, cellsEstimated: 2, estimateDetailsByColumn: { Revenue: 'weighted-knn · MAE 1.200 / MAPE 2.10%' }, estimateUncertaintyByColumn: { Revenue: { '3': { value: 0.1, kind: 'numeric' } } }, rowsRemoved: 0, columnsRenamed: 0, cellsFlagged: 0,
        samples: Array.from({ length: 12 }, (_, index) => ({ before: { value: null }, after: { value: index } })),
      }, {
        label: 'Remove duplicates', ruleId: 'remove-duplicates', scope: { mode: 'explicit' },
        cellsChanged: 0, rowsRemoved: 2, columnsRenamed: 0, cellsFlagged: 0, samples: [],
      }],
      decisions: [['duplicate-group', 'accepted']],
      flaggedUnchanged: [{ column: 'amount', message: 'Outlier detected', count: 4 }],
    })
    expect(report).toContain('- Cells changed: 8')
    expect(report).toContain('- Cells filled: 0')
    expect(report).toContain('- Cells estimated: 0')
    expect(report).toContain('- Estimate validation for Revenue: weighted-knn · MAE 1.200 / MAPE 2.10%')
    expect(report).toContain('- Per-row estimate uncertainty for Revenue: {"3":{"value":0.1,"kind":"numeric"}}')
    expect(report).toContain('- Cells estimated: 2')
    expect(report.indexOf('### 1. Fill missing values')).toBeLessThan(report.indexOf('### 2. Remove duplicates'))
    expect(report).toContain('- Scope: byIssue')
    expect(report).toContain('- Timestamp: 2026-10-26T00:00:00.000Z')
    expect(report.match(/Before:/g)).toHaveLength(10)
    expect(report).toContain('- duplicate-group: accepted')
    expect(report).toContain('- amount: Outlier detected (4)')
  })
})
