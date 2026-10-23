export type DataValue = string | number | boolean | null
export type DataRow = Record<string, DataValue>
export type DataFormat = 'csv' | 'tsv' | 'xlsx' | 'xls' | 'json'
export type InferredType = 'integer' | 'float' | 'boolean' | 'date' | 'datetime' | 'text' | 'categorical'
export type IssueSeverity = 'info' | 'warning' | 'error'

export interface ColumnIssue {
  code: string
  severity: IssueSeverity
  message: string
  count?: number
}

export interface ColumnProfile {
  /** Stable parse-order identity; names may change after cleaning. */
  id: string
  name: string
  inferredType: InferredType
  nullCount: number
  nullPercent: number
  uniqueCount: number
  duplicateValueCount: number
  min: DataValue
  max: DataValue
  mean: number | null
  median: number | null
  topValues: Array<{ value: DataValue; count: number }>
  mixedTypeCount: number
  leadingWhitespaceCount: number
  trailingWhitespaceCount: number
  inconsistentCasingCount: number
  invalidEmailCount: number
  invalidPhoneCount: number
  invalidDateCount: number
  iqrOutlierCount: number
  issues: ColumnIssue[]
}

export interface DatasetSummary {
  rows: number
  columns: number
  fullyDuplicateRows: number
  fullyEmptyRows: number
  fullyEmptyColumns: number
  nullCells: number
  memoryEstimateBytes: number
}

export interface Dataset {
  id: string
  name: string
  format: DataFormat
  sizeBytes: number
  rowCount: number
  columnCount: number
  createdAt: string
  largeFileMode: boolean
  note?: string
}

export interface CleaningRule {
  id: string
  kind: CleaningRuleKind
  enabled: boolean
  risk: 'low' | 'medium' | 'high'
  scope: RuleScope
  options: Record<string, string | number | boolean>
}

export type CleaningRuleKind = 'trim-whitespace' | 'normalize-missing' | 'formatted-numbers' | 'normalize-column-names' | 'remove-empty-rows' | 'remove-empty-columns' | 'fix-type-mismatches' | 'remove-duplicates' | 'fill-missing' | 'handle-outliers' | 'standardize-categories' | 'merge-categories' | 'resolve-ambiguous-dates'
export type RuleScopeMode = 'all' | 'byType' | 'byIssue' | 'byNamePattern' | 'explicit'
export interface RuleScope { mode: RuleScopeMode; types?: InferredType[]; issues?: string[]; pattern?: string; include?: string[]; exclude?: string[]; includeIds?: string[]; excludeIds?: string[] }
export interface CleaningGroup { ruleId: string; category: string; label: string; columnCount: number; columns: string[]; columnIds?: string[]; affectedRows: number; samples: string[]; rowsRemoved?: number; cellsChanged?: number; cellsFlagged?: number; columnsRemoved?: number; columnsRenamed?: number; warning?: string }
export interface PlannedRule { rule: CleaningRule; columns: string[]; columnIds: string[]; deferredColumns?: string[]; proposed: boolean; status?: 'pending'; reason: string }
export interface SmartCleanResult { rows: DataRow[]; groups: CleaningGroup[]; proposed: PlannedRule[]; protectedColumns: string[]; changeLog: ChangeLogEntry[]; stableColumnIds?: Record<string, string>; warnings?: string[] }
export interface CleaningRecipe { id: string; version: 1; name: string; createdAt: string; rules: CleaningRule[]; protectedColumns: string[]; columnTypes: Record<string, InferredType>; stableColumnIds?: Record<string, string>; protectedColumnIds?: string[] }
export interface RecipeMatchReport { rules: CleaningRule[]; matched: Record<string, string[]>; protectedColumns: string[]; unmatched: string[]; ambiguous: string[] }
export type RiskyDecisionKind = 'remove-duplicates' | 'fill-missing' | 'handle-outliers' | 'standardize-categories' | 'resolve-ambiguous-dates'
export interface RiskyDecision { kind: RiskyDecisionKind; options: Record<string, string | number | boolean | string[]>; columns: string[]; columnIds?: string[] }
export interface RiskyDryRun { decision: RiskyDecision; rowsBefore: number; rowsAfter: number; rowsRemoved: number; cellsChanged: number; flaggedCells: number; samples: Array<{ before: DataRow; after: DataRow }> }
export interface ChangeStep { id: string; label: string; ruleId: string; scope: RuleScope; timestamp: string; rowsBefore: number; rowsAfter: number; rowsRemoved: number; cellsChanged: number; columnsRenamed: number; flaggedCells: number; samples: Array<{ before: DataRow; after: DataRow }>; undone: boolean }

export interface ChangeLogEntry {
  id: string
  ruleId: string
  description: string
  affectedRows: number
  rowsRemoved?: number
  cellsChanged?: number
  columnsRenamed?: number
  cellsFlagged?: number
  timestamp: string
  undone: boolean
  columnIds?: string[]
}

export interface ProfileResult {
  summary: DatasetSummary
  columns: ColumnProfile[]
  datasetIssues: ColumnIssue[]
}
