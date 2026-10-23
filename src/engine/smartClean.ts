import type { CleaningGroup, CleaningRecipe, CleaningRule, ColumnProfile, DataRow, PlannedRule, ProfileResult, RecipeMatchReport, SmartCleanResult } from '../types'
import { isEmptyValue, isRuleApplicable, normalizeColumnName, transformRow } from '../cleaners/rules'

export const LOW_RISK_RULES: CleaningRule[] = [
  ...([
    ['trim-whitespace', 'Trim whitespace'], ['normalize-missing', 'Normalize missing values'], ['formatted-numbers', 'Convert formatted numbers'],
    ['fix-type-mismatches', 'Fix obvious type mismatches'], ['remove-empty-rows', 'Remove empty rows'], ['remove-empty-columns', 'Remove empty columns'], ['normalize-column-names', 'Normalize column names'],
  ] as const).map(([kind]) => ({ id: kind, kind, enabled: true, risk: 'low' as const, scope: { mode: 'all' as const }, options: {} })),
]

export const RISKY_RULES: CleaningRule[] = [
  ...([
    ['remove-duplicates', 'Remove duplicate rows'], ['fill-missing', 'Fill missing values'], ['handle-outliers', 'Handle outliers'], ['standardize-categories', 'Standardize categories'], ['resolve-ambiguous-dates', 'Resolve ambiguous dates'],
  ] as const).map(([kind]) => ({ id: kind, kind, enabled: false, risk: 'high' as const, scope: { mode: 'all' as const }, options: {} })),
]

export function countUnresolvedProposals(proposals: PlannedRule[], decisionStates: Record<string, 'pending' | 'later' | 'accepted' | 'skipped'>): number {
  return proposals.filter((proposal) => !['accepted', 'skipped'].includes(decisionStates[proposal.rule.id] ?? proposal.status ?? 'pending')).length
}

const issueCodeSet = (column: ColumnProfile) => new Set(column.issues.map((issue) => issue.code))
function scopeMatches(rule: CleaningRule, column: ColumnProfile): boolean {
  const { scope } = rule
  const excluded = scope.exclude?.includes(column.name) || scope.exclude?.includes(column.id) || scope.excludeIds?.includes(column.id)
  const included = !scope.include && !scope.includeIds || scope.include?.includes(column.name) || scope.include?.includes(column.id) || scope.includeIds?.includes(column.id)
  if (excluded) return false
  if (!included) return false
  if (scope.mode === 'explicit' && !scope.include?.includes(column.name) && !scope.include?.includes(column.id) && !scope.includeIds?.includes(column.id)) return false
  if (scope.mode === 'byType' && !scope.types?.includes(column.inferredType)) return false
  if (scope.mode === 'byIssue' && !scope.issues?.some((issue) => issueCodeSet(column).has(issue))) return false
  if (scope.mode === 'byNamePattern') {
    try { if (!scope.pattern || !new RegExp(scope.pattern, 'i').test(column.name)) return false } catch { return false }
  }
  return true
}

export function buildSmartCleanPlan(profile: ProfileResult, protectedColumns: string[] = [], rules: CleaningRule[] = [...LOW_RISK_RULES, ...RISKY_RULES]): PlannedRule[] {
  const protectedSet = new Set(protectedColumns)
  return rules.map((rule) => {
    const applicable = profile.columns.filter((column) => !protectedSet.has(column.name) && !protectedSet.has(column.id) && scopeMatches(rule, column) && isRuleApplicable(rule.kind, column))
    const deferred = rule.kind === 'fill-missing' ? applicable.filter((column) => column.nullPercent > Number(rule.options.maxMissingPercent ?? 15)) : []
    const selected = applicable.filter((column) => !deferred.includes(column) && (rule.kind !== 'remove-duplicates' || profile.summary.fullyDuplicateRows > 0))
    const columns = selected.map((column) => column.name)
    return { rule, columns, columnIds: selected.map((column) => column.id), ...(deferred.length ? { deferredColumns: deferred.map((column) => column.name) } : {}), proposed: rule.risk !== 'low' && columns.length > 0, ...(rule.risk !== 'low' && columns.length ? { status: 'pending' as const } : {}), reason: rule.risk === 'low' ? 'Deterministic and reversible in the original-preserving pipeline.' : 'Review this dataset-wide change before applying it.' }
  })
}

export function runSmartClean(rows: DataRow[], profile: ProfileResult, protectedColumns: string[] = [], onProgress?: (progress: { completed: number; total: number; rule: string }) => void, rules: CleaningRule[] = [...LOW_RISK_RULES, ...RISKY_RULES]): SmartCleanResult {
  let current = rows.map((row) => ({ ...row }))
  const groups: CleaningGroup[] = []
  const warnings: string[] = []
  const plan = buildSmartCleanPlan(profile, protectedColumns, rules)
  const activeRules = plan.filter((item) => !item.proposed && item.columns.length)
  const profileById = new Map(profile.columns.map((column) => [column.id, column]))
  const originalColumnNames = profile.columns.map((column) => column.name)
  let currentColumnNames = [...originalColumnNames]
  let completed = 0
  for (const item of activeRules) {
    const selected = new Set(item.columnIds.map((id) => profileById.get(id)?.name).filter((name): name is string => Boolean(name)))
    const beforeRows = current
    let affectedRows = 0
    let rowsRemoved = 0
    let cellsChanged = 0
    let columnsRemoved = 0
    let warning: string | undefined
    const samples: string[] = []
    if (item.rule.kind === 'remove-empty-rows') {
      const kept: DataRow[] = []
      for (const row of current) {
        if (originalColumnNames.every((column) => isEmptyValue(row[column] ?? null))) { rowsRemoved++; if (samples.length < 5) samples.push(JSON.stringify(row)); continue }
        kept.push(row)
      }
      if (rowsRemoved > current.length * 0.2 || rowsRemoved === current.length) {
        warning = `Safety guard: ${rowsRemoved} of ${current.length} rows would be removed (${current.length ? ((rowsRemoved / current.length) * 100).toFixed(1) : 0}%); the step was skipped. Review the sample rows before deciding.`
        warnings.push(warning); rowsRemoved = 0
      } else current = kept
    } else if (item.rule.kind === 'remove-empty-columns') {
      const removed = new Set(item.columns)
      columnsRemoved = [...removed].filter((name) => currentColumnNames.includes(name)).length
      if (columnsRemoved >= currentColumnNames.length) {
        warning = `Safety guard: removing ${columnsRemoved} of ${currentColumnNames.length} columns would leave no columns; the step was skipped.`
        samples.push(...[...removed].slice(0, 5).map((name) => `Would remove empty column: ${name}`))
        warnings.push(warning); columnsRemoved = 0
      } else if (columnsRemoved) {
        current = current.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !removed.has(key))))
        currentColumnNames = currentColumnNames.filter((name) => !removed.has(name))
      }
    } else if (item.rule.kind === 'normalize-column-names') {
      // Column labels are metadata. This plan step is logged here, but the actual
      // rekey happens after every data rule has finished using parse-time names.
    } else {
      const nextRows: DataRow[] = []
      for (const row of current) {
        const next = transformRow(item.rule.kind, row, selected)
        let rowChanged = false
        for (const column of item.columns) if (next[column] !== row[column]) {
          rowChanged = true
          cellsChanged++
          if (samples.length < 5) samples.push(`${column}: ${String(row[column] ?? '∅')} → ${String(next[column] ?? '∅')}`)
        }
        if (rowChanged) affectedRows++
        nextRows.push(next)
      }
      current = nextRows
    }
    const beforeCount = beforeRows.length
    const removedCount = beforeCount - current.length
    if (removedCount && (item.rule.kind !== 'remove-empty-rows' || removedCount !== rowsRemoved)) throw new Error(`Smart Clean safety check failed: ${item.rule.kind} changed the row count without a matching removal record. The entire run was rolled back.`)
    if (item.rule.kind !== 'normalize-missing' && item.rule.kind !== 'remove-empty-rows' && item.rule.kind !== 'remove-empty-columns') {
      for (let rowIndex = 0; rowIndex < current.length; rowIndex++) for (const name of currentColumnNames) {
        if (current[rowIndex]?.[name] === null && beforeRows[rowIndex]?.[name] != null && !isEmptyValue(beforeRows[rowIndex]?.[name] ?? null)) throw new Error(`Smart Clean safety check failed: ${item.rule.kind} converted a non-empty value to null. The entire run was rolled back.`)
      }
    }
    if (current.some((row) => Object.keys(row).length !== currentColumnNames.length)) throw new Error(`Smart Clean safety check failed: ${item.rule.kind} changed the column count unexpectedly (expected ${currentColumnNames.length}, saw ${Object.keys(current[0] ?? {}).join(',')}). The entire run was rolled back.`)
    groups.push({ ruleId: item.rule.id, category: item.rule.kind, label: warning ?? `${item.columns.length.toLocaleString()} columns: ${item.rule.kind.replaceAll('-', ' ')}`, columnCount: item.columns.length, columns: item.columns, columnIds: item.columnIds, affectedRows, samples, rowsRemoved, cellsChanged, warning, columnsRemoved })
    completed++
    onProgress?.({ completed, total: activeRules.length, rule: item.rule.id })
  }
  // Names are metadata: only rekey once all data rules have finished using the
  // parse-time column IDs and original physical names.
  const renameRule = activeRules.find((item) => item.rule.kind === 'normalize-column-names')
  const idBySource = new Map(profile.columns.map((column) => [column.name, column.id]))
  if (renameRule?.columns.length) {
    const renames = new Map<string, string>()
    const renameNames = renameRule.columns.filter((name) => currentColumnNames.includes(name))
    const selected = new Set(renameNames)
    const used = new Set(currentColumnNames.filter((name) => !selected.has(name)))
    for (const name of renameNames) {
      const base = normalizeColumnName(name); let next = base; let suffix = 2
      while (used.has(next)) next = `${base}_${suffix++}`
      used.add(next); renames.set(name, next)
      const id = idBySource.get(name)
      if (id) idBySource.set(next, id)
    }
    current = current.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [renames.get(key) ?? key, value])))
    const renamed = [...renames].filter(([before, after]) => before !== after)
    const renameGroup = groups.find((group) => group.ruleId === renameRule.rule.id)
    if (renameGroup) {
      renameGroup.columns = renamed.map(([, after]) => after)
      renameGroup.columnIds = renamed.map(([before]) => profile.columns.find((column) => column.name === before)?.id ?? `column:${before}`)
      renameGroup.columnCount = renamed.length
      renameGroup.columnsRenamed = renamed.length
      renameGroup.affectedRows = 0
      renameGroup.cellsChanged = 0
      renameGroup.label = `${renamed.length} columns renamed`
      renameGroup.samples = renamed.slice(0, 5).map(([before, after]) => `${before} → ${after}`)
    }
    currentColumnNames = currentColumnNames.map((name) => renames.get(name) ?? name)
  }
  const highMissingColumns = plan.find((item) => item.rule.kind === 'fill-missing')?.deferredColumns ?? []
  if (highMissingColumns.length) {
    const count = highMissingColumns.reduce((sum, name) => sum + (profile.columns.find((column) => column.name === name)?.nullCount ?? 0), 0)
    groups.push({ ruleId: 'fill-missing-deferred', category: 'fill-missing', label: `${highMissingColumns.length} high-missing columns left null`, columnCount: highMissingColumns.length, columns: highMissingColumns, columnIds: highMissingColumns.map((name) => profile.columns.find((column) => column.name === name)?.id ?? `column:${name}`), affectedRows: 0, cellsChanged: 0, rowsRemoved: 0, columnsRenamed: 0, cellsFlagged: count, samples: [] })
  }
  const stableColumnIds = Object.fromEntries(currentColumnNames.map((name) => [name, idBySource.get(name) ?? `column:${name}`]))
  const changeLog = groups.map((group) => ({ id: crypto.randomUUID(), ruleId: group.ruleId, description: group.label, affectedRows: group.affectedRows, rowsRemoved: group.rowsRemoved ?? 0, cellsChanged: group.cellsChanged ?? 0, columnsRenamed: group.columnsRenamed ?? 0, cellsFlagged: group.cellsFlagged ?? 0, timestamp: new Date().toISOString(), undone: false, columnIds: group.columnIds ?? [] }))
  return { rows: current, groups, proposed: plan.filter((item) => item.proposed), protectedColumns: [...protectedColumns], changeLog, stableColumnIds, ...(warnings.length ? { warnings } : {}) }
}

export function createRecipe(name: string, rules: CleaningRule[], protectedColumns: string[], columns: ColumnProfile[]): CleaningRecipe {
  const idByName = new Map(columns.map((column) => [column.name, column.id]))
  const rulesWithIds = rules.map((rule) => ({ ...rule, scope: { ...rule.scope, includeIds: [...new Set([...(rule.scope.includeIds ?? []), ...(rule.scope.include ?? []).map((name) => idByName.get(name)).filter((id): id is string => Boolean(id))])], excludeIds: [...new Set([...(rule.scope.excludeIds ?? []), ...(rule.scope.exclude ?? []).map((name) => idByName.get(name)).filter((id): id is string => Boolean(id))])] } }))
  return { id: crypto.randomUUID(), version: 1, name, createdAt: new Date().toISOString(), rules: rulesWithIds, protectedColumns, protectedColumnIds: columns.filter((column) => protectedColumns.includes(column.name)).map((column) => column.id), stableColumnIds: Object.fromEntries(columns.map((column) => [column.name, column.id])), columnTypes: Object.fromEntries(columns.map((column) => [column.name, column.inferredType])) }
}

export function matchRecipe(recipe: CleaningRecipe, columns: ColumnProfile[]): RecipeMatchReport {
  const byName = new Map(columns.map((column) => [column.name.toLowerCase(), column.name]))
  const matches: Record<string, string[]> = {}
  const unmatched: string[] = []
  const ambiguous: string[] = []
  const protectedMatches: string[] = []
  const resolve = (source: string): string | null => {
    const exact = byName.get(source.toLowerCase())
    if (exact) return exact
    const type = recipe.columnTypes[source]
    const candidates = columns.filter((column) => column.inferredType === type)
    if (candidates.length === 1) return candidates[0]!.name
    if (candidates.length > 1) { ambiguous.push(source); return null }
    unmatched.push(source); return null
  }
  for (const source of recipe.protectedColumns) {
    const resolved = resolve(source)
    if (resolved) protectedMatches.push(resolved)
    else if (ambiguous.includes(source)) protectedMatches.push(...columns.filter((column) => column.inferredType === recipe.columnTypes[source]).map((column) => column.name))
  }
  for (const rule of recipe.rules) {
    const sourceNames = rule.scope.include ?? Object.keys(recipe.columnTypes)
    const found: string[] = []
    for (const source of sourceNames) {
      const target = resolve(source)
      if (target) found.push(target)
    }
    matches[rule.id] = found
  }
  return { rules: recipe.rules, matched: matches, protectedColumns: [...new Set(protectedMatches)], unmatched: [...new Set(unmatched)], ambiguous: [...new Set(ambiguous)] }
}
