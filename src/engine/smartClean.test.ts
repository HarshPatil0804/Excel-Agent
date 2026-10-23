import { describe, expect, it } from 'vitest'
import { profileDataset } from '../profiler/profile'
import { countUnresolvedProposals, matchRecipe, runSmartClean, createRecipe, buildSmartCleanPlan, LOW_RISK_RULES } from './smartClean'
import type { CleaningRule, ColumnProfile, DataRow, ProfileResult } from '../types'
import { globalLibraryFixture, trainFixture } from '../../tests/fixtures/smartCleanRegression'
import { executeRiskyDecision } from './riskyDecisions'
import { useDatasetStore } from '../store/datasetStore'

const buildProfile = (rows: DataRow[], columns: string[], stableIds?: ReadonlyMap<string, string>): ProfileResult => profileDataset(rows, columns, stableIds)

describe('Smart Clean', () => {
  it('plans dataset-wide across 1,000 columns and preserves locked columns', () => {
    const columns = Array.from({ length: 1000 }, (_, index) => `field_${index}`)
    const input: DataRow = Object.fromEntries(columns.map((name) => [name, '  value  ']))
    input.field_0 = '  keep  '
    input.field_1 = '  clean  '
    input.field_2 = '  N/A  '
    const secondRow = Object.fromEntries(columns.map((name) => [name, 'value']))
    secondRow.field_0 = 'protected value'
    secondRow.field_1 = 'already clean'
    const profile = buildProfile([input, secondRow], columns)
    const plan = buildSmartCleanPlan(profile, ['field_0'])
    expect(plan.find((entry) => entry.rule.id === 'trim-whitespace')?.columns).toHaveLength(998)
    const result = runSmartClean([input, secondRow], profile, ['field_0'])
    expect(result.rows[0]?.field_0).toBe('  keep  ')
    expect(result.rows[0]?.field_1).toBe('clean')
    expect(result.rows[0]?.field_2).toBeNull()
    expect(result.groups.some((group) => group.columns.includes('field_0'))).toBe(false)
  })

  it('cleans a 219 × 7 Global Library shaped fixture without losing rows or profile identity', () => {
    const { rows, columns } = globalLibraryFixture()
    const profile = buildProfile(rows, columns)
    const result = runSmartClean(rows, profile)
    expect(result.rows).toHaveLength(219)
    expect(Object.keys(result.rows[0] ?? {})).toHaveLength(7)
    expect(result.rows[0]?.country).toBe('Country 0')
    expect(typeof result.rows[0]?.expenditures).toBe('number')
    expect(result.rows[0]?.region_name).toBeNull()
    const renamed = result.groups.find((group) => group.ruleId === 'normalize-column-names')
    expect(renamed?.columnsRenamed).toBe(7)
    expect(renamed?.affectedRows).toBe(0)
    expect(result.groups.find((group) => group.ruleId === 'formatted-numbers')?.cellsChanged).toBe(854)
    expect(result.groups.find((group) => group.ruleId === 'trim-whitespace')?.cellsChanged).toBe(1)
    expect(result.groups.find((group) => group.ruleId === 'normalize-missing')?.cellsChanged).toBe(29)
    expect(result.groups.find((group) => group.ruleId === 'remove-empty-rows')?.rowsRemoved).toBe(0)
    expect(result.groups.reduce((sum, group) => sum + (group.cellsFlagged ?? 0), 0)).toBe(0)
    expect(result.changeLog.find((entry) => entry.ruleId === 'formatted-numbers')).toMatchObject({ cellsChanged: 854, rowsRemoved: 0, columnsRenamed: 0, cellsFlagged: 0 })
    expect(result.changeLog.find((entry) => entry.ruleId === 'normalize-column-names')).toMatchObject({ cellsChanged: 0, rowsRemoved: 0, columnsRenamed: 7, cellsFlagged: 0 })
    const profileAfter = buildProfile(result.rows, Object.keys(result.stableColumnIds ?? {}), new Map(Object.entries(result.stableColumnIds ?? {})))
    expect(profileAfter.summary.rows).toBe(219)
    expect(profileAfter.summary.columns).toBe(7)
    expect(profileAfter.columns.find((column) => column.name === 'expenditures')?.uniqueCount).toBeGreaterThan(1)
    expect(profileAfter.columns.find((column) => column.name === 'expenditures')?.min).not.toBeNull()
    expect(profileAfter.columns.find((column) => column.name === 'expenditures')?.max).not.toBeNull()
    expect(profileAfter.columns.find((column) => column.name === 'country')?.id).toBe(profile.columns.find((column) => column.name === 'Country ')?.id)
    const store = useDatasetStore.getState()
    store.clear()
    const dataset = { id: 'global-regression', name: 'Global Library Data.xlsx', format: 'xlsx' as const, sizeBytes: 1, rowCount: rows.length, columnCount: columns.length, createdAt: new Date().toISOString(), largeFileMode: false }
    store.setParsedDataset(dataset, profile, rows.slice(0, 1000), rows)
    useDatasetStore.getState().setParsedDataset(dataset, profileAfter, result.rows.slice(0, 1000), result.rows)
    useDatasetStore.getState().setCleanResult(result)
    expect(useDatasetStore.getState().previewRows[0]?.expenditures).toBe(1)
    const firstRunLogId = useDatasetStore.getState().changeSteps[0]?.id
    expect(useDatasetStore.getState().changeSteps[0]).toMatchObject({ cellsChanged: 884, rowsRemoved: 0, columnsRenamed: 7, flaggedCells: 0 })
    const secondResult = runSmartClean(result.rows, profileAfter)
    expect(secondResult.groups.reduce((sum, group) => sum + (group.cellsChanged ?? 0), 0)).toBe(0)
    useDatasetStore.getState().setParsedDataset(dataset, profileAfter, result.rows.slice(0, 1000), result.rows)
    useDatasetStore.getState().setCleanResult(secondResult)
    expect(useDatasetStore.getState().changeSteps).toHaveLength(2)
    expect(useDatasetStore.getState().changeSteps[0]?.id).toBe(firstRunLogId)
    expect(useDatasetStore.getState().changeSteps[1]).toMatchObject({ cellsChanged: 0, rowsRemoved: 0, columnsRenamed: 0, flaggedCells: 0 })
    useDatasetStore.getState().undo()
    useDatasetStore.getState().undo()
    expect(useDatasetStore.getState().rows).toEqual(rows)
    useDatasetStore.getState().redo()
    useDatasetStore.getState().redo()
    expect(useDatasetStore.getState().profile?.summary.rows).toBe(219)
    useDatasetStore.getState().resetToOriginal()
    expect(useDatasetStore.getState().rows).toEqual(rows)
    expect(useDatasetStore.getState().previewRows).toEqual(rows.slice(0, 1000))
    store.clear()
  })

  it('keeps train.csv shaped duplicates as a proposal until the user accepts removal', () => {
    const { rows, columns } = trainFixture()
    const result = runSmartClean(rows, buildProfile(rows, columns))
    expect(result.rows).toHaveLength(119)
    const proposal = result.proposed.find((item) => item.rule.kind === 'remove-duplicates')
    expect(proposal).toBeDefined()
    const automatic = result.changeLog.find((entry) => entry.ruleId === 'normalize-column-names')
    expect(automatic).toMatchObject({ cellsChanged: 0, rowsRemoved: 0, columnsRenamed: 13, cellsFlagged: 0 })
    expect(result.changeLog.find((entry) => entry.ruleId === 'remove-duplicates')).toBeUndefined()
    expect(proposal?.status).toBe('pending')
    const accepted = executeRiskyDecision(result.rows, { kind: 'remove-duplicates', columns, options: { keys: [], keep: 'first' } })
    expect(accepted.result.rowsRemoved).toBe(17)
    expect(accepted.rows).toHaveLength(102)
  })

  it('creates risky proposals only for existing issues and defers high-missing columns', () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ low_missing: index < 5 ? null : `v${index}`, high_missing: index < 20 ? null : `v${index}` }))
    const profile = buildProfile(rows, ['low_missing', 'high_missing'])
    const plan = buildSmartCleanPlan(profile)
    const fill = plan.find((item) => item.rule.kind === 'fill-missing')
    expect(fill?.columns).toContain('low_missing')
    expect(fill?.columns).not.toContain('high_missing')
    expect(fill?.deferredColumns).toContain('high_missing')
    const cleaned = runSmartClean(rows, profile)
    expect(cleaned.groups.find((group) => group.ruleId === 'fill-missing-deferred')).toMatchObject({ cellsFlagged: 20, cellsChanged: 0, rowsRemoved: 0 })
    expect(buildSmartCleanPlan(buildProfile([{ a: 'x' }, { a: 'y' }], ['a'])).some((item) => item.rule.kind === 'remove-duplicates' && item.proposed)).toBe(false)
    const leftAlone = executeRiskyDecision(rows, { kind: 'fill-missing', columns: ['low_missing'], options: { strategy: 'leave-null' } })
    expect(leftAlone.result.cellsChanged).toBe(0)
    expect(leftAlone.rows).toEqual(rows)
  })

  it('keeps a risky proposal pending and counts it as unresolved until the user decides', () => {
    const { rows, columns } = trainFixture()
    const proposal = buildSmartCleanPlan(buildProfile(rows, columns)).find((item) => item.rule.kind === 'remove-duplicates')!
    expect(proposal.status).toBe('pending')
    expect(countUnresolvedProposals([proposal], {})).toBe(1)
    expect(countUnresolvedProposals([proposal], { [proposal.rule.id]: 'skipped' })).toBe(0)
    expect(countUnresolvedProposals([proposal], { [proposal.rule.id]: 'later' })).toBe(1)
    expect(countUnresolvedProposals([proposal], { [proposal.rule.id]: 'accepted' })).toBe(0)
  })

  it('blocks automatic row or column removal that exceeds the safety bounds', () => {
    const rows = [{ Name: 'valid', Empty: null }, { Name: 'also valid', Empty: null }, { Name: null, Empty: null }, { Name: 'N/A', Empty: null }, { Name: '', Empty: null }]
    const emptyProfile = buildProfile(rows, ['Name', 'Empty'])
    expect(emptyProfile.columns.find((column) => column.name === 'Empty')?.nullPercent).toBe(100)
    expect(buildSmartCleanPlan(emptyProfile).find((item) => item.rule.kind === 'remove-empty-columns')?.columns).toEqual(['Empty'])
    const result = runSmartClean(rows, emptyProfile)
    expect(result.rows).toHaveLength(rows.length)
    expect(result.groups.find((group) => group.ruleId === 'remove-empty-rows')?.warning).toMatch(/Safety guard: 3 of 5 rows/)
    expect(result.groups.find((group) => group.ruleId === 'remove-empty-rows')?.samples.length).toBeGreaterThan(0)
    const allEmpty = [{ left: null, right: null }, { left: '', right: 'N/A' }]
    const protectedResult = runSmartClean(allEmpty, buildProfile(allEmpty, ['left', 'right']))
    expect(protectedResult.rows).toHaveLength(2)
    expect(protectedResult.groups.find((group) => group.ruleId === 'remove-empty-columns')?.warning).toMatch(/leave no columns/)
  })

  it('never removes a non-empty row across seeded random messy inputs', () => {
    let seed = 41
    const random = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647 }
    for (let sample = 0; sample < 30; sample++) {
      const columns = ['a name', 'b (value)', 'select']
      const rows = Array.from({ length: 8 + Math.floor(random() * 20) }, () => Object.fromEntries(columns.map((column) => {
        const value = random()
        return [column, value < 0.25 ? null : value < 0.4 ? ' N/A ' : value < 0.55 ? '  ' : ` value-${Math.floor(random() * 9)} `]
      })))
      const nonEmptyRows = rows.filter((row) => Object.values(row).some((value) => value !== null && String(value).trim() !== '' && !['n/a', 'na', 'null', 'none', '-'].includes(String(value).trim().toLowerCase()))).length
      expect(runSmartClean(rows, buildProfile(rows, columns)).rows.length).toBeGreaterThanOrEqual(nonEmptyRows)
    }
  })

  it('builds scope-filtered plans from all columns without column-by-column rule input', () => {
    const columns = Array.from({ length: 1000 }, (_, index) => `field_${index}`)
    const row = Object.fromEntries(columns.map((name, index) => [name, index % 2 ? 'x ' : 'x']))
    const profile = buildProfile([row], columns)
    const plan = buildSmartCleanPlan(profile, [], LOW_RISK_RULES)
    expect(plan.find((entry) => entry.rule.id === 'trim-whitespace')?.columns.length).toBe(500)
  })

  it('honors byType, name-pattern, explicit include, and exclude scopes', () => {
    const profile = buildProfile([{ customer_name: ' Ada ', amount: '2 ', status: 'yes ' }], ['customer_name', 'amount', 'status'])
    const makeRule = (id: string, scope: CleaningRule['scope']): CleaningRule => ({ id, kind: 'trim-whitespace', enabled: true, risk: 'low', scope, options: {} })
    const rules: CleaningRule[] = [
      makeRule('type', { mode: 'byType', types: ['text'] }),
      makeRule('name', { mode: 'byNamePattern', pattern: '^amount$' }),
      makeRule('explicit', { mode: 'explicit', include: ['status', 'amount'], exclude: ['amount'] }),
    ]
    const plan = buildSmartCleanPlan(profile, [], rules)
    expect(plan.find((item) => item.rule.id === 'name')?.columns).toEqual(['amount'])
    expect(plan.find((item) => item.rule.id === 'explicit')?.columns).toEqual(['status'])
    expect(plan.find((item) => item.rule.id === 'type')?.columns).not.toContain('amount')
  })

  it('reapplies recipes by exact name and unique type, and reports missing or ambiguous matches', () => {
    const columns: ColumnProfile[] = [
      { ...buildProfile([{ amount: 1, missing: 'x' }], ['amount', 'missing']).columns[0]!, name: 'revenue', inferredType: 'float' },
      { ...buildProfile([{ amount: 1, missing: 'x' }], ['amount', 'missing']).columns[1]!, name: 'label', inferredType: 'text' },
    ]
    const recipe = createRecipe('test', LOW_RISK_RULES, [], [{ ...columns[0]!, name: 'amount' }, { ...columns[1]!, name: 'retired', inferredType: 'date' }])
    recipe.rules = recipe.rules.map((rule) => ({ ...rule, scope: { mode: 'explicit', include: ['amount', 'retired'] } }))
    const report = matchRecipe(recipe, columns)
    expect(report.matched['trim-whitespace']).toContain('revenue')
    expect(report.unmatched).toContain('retired')
    expect(report.ambiguous).toHaveLength(0)
  })

  it('reports ambiguous type fallbacks instead of guessing among columns', () => {
    const profile = buildProfile([{ a: 'x', b: 'y' }], ['a', 'b'])
    const recipe = createRecipe('test', LOW_RISK_RULES, [], [{ ...profile.columns[0]!, name: 'renamed' }])
    recipe.rules = recipe.rules.map((rule) => ({ ...rule, scope: { mode: 'explicit', include: ['renamed'] } }))
    const report = matchRecipe(recipe, profile.columns)
    expect(report.ambiguous).toContain('renamed')
  })
})
