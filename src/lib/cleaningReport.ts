import type { DataRow, RuleScope } from '../types'

export interface CleaningReportStep {
  label: string
  ruleId: string
  scope: RuleScope
  timestamp?: string
  cellsChanged: number
  cellsEstimated?: number
  estimateDetailsByColumn?: Record<string, string>
  estimateUncertaintyByColumn?: Record<string, Record<string, { value: number; kind: 'numeric' | 'categorical' }>>
  rowsRemoved: number
  columnsRenamed: number
  cellsFlagged: number
  samples: Array<{ before: DataRow; after: DataRow }>
}

export interface CleaningReportData {
  datasetName: string
  rowsBefore: number
  rowsAfter: number
  columnsBefore: number
  columnsAfter: number
  cellsChanged: number
  cellsFilled: number
  cellsEstimated: number
  rowsRemoved: number
  columnsRenamed: number
  cellsFlagged: number
  steps: CleaningReportStep[]
  decisions: Array<[string, string]>
  flaggedUnchanged: Array<{ column: string; message: string; count: number }>
}

export function buildCleaningReportMarkdown(data: CleaningReportData): string {
  const lines = [
    `# Cleaning report: ${data.datasetName}`,
    '',
    `- Rows: ${data.rowsBefore} → ${data.rowsAfter}`,
    `- Columns: ${data.columnsBefore} → ${data.columnsAfter}`,
    `- Cells changed: ${data.cellsChanged}`,
    `- Cells filled: ${data.cellsFilled}`,
    `- Cells estimated: ${data.cellsEstimated}`,
    `- Rows removed: ${data.rowsRemoved}`,
    `- Columns renamed: ${data.columnsRenamed}`,
    `- Cells flagged: ${data.cellsFlagged}`,
    '',
    '## Steps',
  ]
  if (!data.steps.length) lines.push('- No cleaning steps have been applied.')
  data.steps.forEach((step, index) => {
    lines.push(
      '',
      `### ${index + 1}. ${step.label}`,
      '',
      `- Timestamp: ${step.timestamp ?? 'not recorded'}`,
      `- Scope: ${step.scope.mode} (${JSON.stringify(step.scope)})`,
      `- Cells changed: ${step.cellsChanged}`,
      `- Cells filled: ${step.ruleId === 'fill-missing' ? step.cellsChanged - (step.cellsEstimated ?? 0) : 0}`,
      `- Cells estimated: ${step.cellsEstimated ?? 0}`,
      `- Rows removed: ${step.rowsRemoved}`,
      `- Columns renamed: ${step.columnsRenamed}`,
      `- Cells flagged: ${step.cellsFlagged}`,
      ...Object.entries(step.estimateDetailsByColumn ?? {}).map(([column, detail]) => `- Estimate validation for ${column}: ${detail}`),
      ...Object.entries(step.estimateUncertaintyByColumn ?? {}).map(([column, values]) => `- Per-row estimate uncertainty for ${column}: ${JSON.stringify(values)}`),
      '',
      'Samples:',
    )
    const samples = step.samples.slice(0, 10)
    if (samples.length) for (const [sampleIndex, sample] of samples.entries()) lines.push(`${sampleIndex + 1}. Before: ${JSON.stringify(sample.before)} → After: ${JSON.stringify(sample.after)}`)
    else lines.push('- No sample changes recorded.')
  })
  lines.push('', '## Decisions')
  if (data.decisions.length) for (const [id, decision] of data.decisions) lines.push(`- ${id}: ${decision}`)
  else lines.push('- No risky decisions recorded.')
  lines.push('', '## Flagged but unchanged')
  if (data.flaggedUnchanged.length) for (const item of data.flaggedUnchanged) lines.push(`- ${item.column}: ${item.message} (${item.count})`)
  else lines.push('- No flagged issues.')
  return lines.join('\n')
}
