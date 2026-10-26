import { describe, expect, it } from 'vitest'
import { profileDataset } from '../profiler/profile'
import { countUnresolvedProposals, matchRecipe, runSmartClean, createRecipe, buildSmartCleanPlan, LOW_RISK_RULES, rankRiskyProposals } from './smartClean'
import type { CleaningRule, ColumnProfile, DataRow, PlannedRule, ProfileResult } from '../types'
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

  it('records stable source row IDs for automatic empty-row removals', () => {
    const rows: DataRow[] = [
      { value: 'a', __dc_internal_row_order: 0 }, { value: 'b', __dc_internal_row_order: 1 },
      { value: 'c', __dc_internal_row_order: 2 }, { value: 'd', __dc_internal_row_order: 3 },
      { value: null, __dc_internal_row_order: 4 },
    ]
    const result = runSmartClean(rows, profileDataset(rows, ['value']), [], undefined, undefined, {}, '__dc_internal_row_order')
    expect(result.rows).toHaveLength(4)
    expect(result.groups.find((group) => group.ruleId === 'remove-empty-rows')).toMatchObject({ rowsRemoved: 1, removedRowIds: [4] })
  })

  it('repairs mojibake in ordinary text as a dataset-wide low-risk rule', () => {
    const rows: DataRow[] = [{ City: 'MontrÃ©al' }, { City: 'Zürich' }]
    const result = runSmartClean(rows, buildProfile(rows, ['City']))
    expect(result.rows.map((row) => row.city)).toEqual(['Montréal', 'Zürich'])
    expect(result.groups.find((group) => group.ruleId === 'repair-mojibake')?.cellsChanged).toBe(1)
  })

  it('requires a 90% parse rate before converting a mixed text column and records mixed currencies', () => {
    const lowRate: DataRow[] = [{ Revenue: '$1.00' }, { Revenue: 'not numeric' }, { Revenue: 'other text' }]
    const lowProfile = buildProfile(lowRate, ['Revenue'])
    expect(lowProfile.columns[0]?.currencySymbols).toEqual(['USD'])
    expect(runSmartClean(lowRate, lowProfile).rows).toEqual(lowRate.map((row) => ({ revenue: row.Revenue })))
    const mixed: DataRow[] = [{ Revenue: '$1.00' }, { Revenue: '€2.00' }, { Revenue: 'N/A' }]
    const profile = buildProfile(mixed, ['Revenue'])
    expect(profile.columns[0]?.currencySymbols).toEqual(['EUR', 'USD'])
    expect(profile.columns[0]?.issues.some((issue) => issue.code === 'mixed-currency')).toBe(true)
    const result = runSmartClean(mixed, profile)
    expect(result.rows.map((row) => row.revenue)).toEqual([1, 2, null])
  })

  it('canonicalizes punctuation and case using the most frequent spelling without fuzzy merging', () => {
    const rows: DataRow[] = [
      { Category: 'north-west' }, { Category: 'north-west' }, { Category: 'North West' },
      { Category: 'North West' }, { Category: 'North West' }, { Category: 'NORTH-WEST' },
      { Category: 'Northeast' },
    ]
    const result = runSmartClean(rows, buildProfile(rows, ['Category']))
    expect(result.rows.map((row) => row.category)).toEqual(['North West', 'North West', 'North West', 'North West', 'North West', 'North West', 'Northeast'])
    expect(result.groups.find((group) => group.ruleId === 'canonicalize-categories')).toMatchObject({ cellsChanged: 3, rowsRemoved: 0 })
    expect(result.proposed.some((item) => item.rule.kind === 'standardize-categories')).toBe(false)
  })

  it('keeps high-confidence fuzzy spelling suggestions as pending risky proposals', () => {
    const rows: DataRow[] = [{ Region: 'Californa' }, { Region: 'California' }, { Region: 'California' }]
    const result = runSmartClean(rows, buildProfile(rows, ['Region']))
    const proposal = result.proposed.find((item) => item.rule.kind === 'standardize-categories')
    expect(proposal?.columns).toEqual(['Region'])
    expect(proposal?.status).toBe('pending')
    expect(result.rows.map((row) => row.region)).toEqual(['Californa', 'California', 'California'])
  })

  it('proposes negative quantity/profit validation without changing data', () => {
    const rows: DataRow[] = [{ Quantity: '-2', Profit: '-3' }, { Quantity: '4', Profit: '8' }]
    const result = runSmartClean(rows, buildProfile(rows, ['Quantity', 'Profit']))
    expect(result.rows.map((row) => [row.quantity, row.profit])).toEqual([[-2, -3], [4, 8]])
    const proposal = result.proposed.find((item) => item.rule.kind === 'resolve-validation')
    expect(proposal?.columns).toEqual(['Quantity', 'Profit'])
    expect(proposal?.status).toBe('pending')
  })

  it('excludes identifier and free-text columns from default missing-value proposals', () => {
    const rows: DataRow[] = Array.from({ length: 20 }, (_, index) => ({
      Amount: index === 0 ? null : index,
      'Customer ID': index === 0 ? null : `C-${index}`,
      Description: index === 0 ? null : `unique description ${index}`,
    }))
    const profile = buildProfile(rows, ['Amount', 'Customer ID', 'Description'])
    const fillPlan = buildSmartCleanPlan(profile).find((item) => item.rule.kind === 'fill-missing')!
    expect(fillPlan.columns).toEqual(['Amount'])
    expect(fillPlan.excludedColumns).toEqual(expect.arrayContaining(['Customer ID', 'Description']))
    expect(fillPlan.deferredColumns).toBeUndefined()
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
    const rows = Array.from({ length: 100 }, (_, index) => ({ low_missing: index < 5 ? null : index % 2 ? 'north' : 'south', high_missing: index < 20 ? null : index % 2 ? 'north' : 'south' }))
    const profile = buildProfile(rows, ['low_missing', 'high_missing'])
    const plan = buildSmartCleanPlan(profile)
    const fill = plan.find((item) => item.rule.kind === 'fill-missing')
    expect(fill?.columns).toContain('low_missing')
    expect(fill?.columns).not.toContain('high_missing')
    expect(fill?.deferredColumns).toContain('high_missing')
    expect(fill?.proposed).toBe(true)
    expect(fill?.status).toBe('pending')
    const cleaned = runSmartClean(rows, profile)
    expect(cleaned.groups.find((group) => group.ruleId === 'fill-missing-deferred')).toMatchObject({ cellsFlagged: 20, cellsChanged: 0, rowsRemoved: 0 })
    expect(buildSmartCleanPlan(buildProfile([{ a: 'x' }, { a: 'y' }], ['a'])).some((item) => item.rule.kind === 'remove-duplicates' && item.proposed)).toBe(false)
    const onlyHighMissing = buildSmartCleanPlan(buildProfile(Array.from({ length: 100 }, (_, index) => ({ amount: index < 30 ? null : index })), ['amount']))
    expect(onlyHighMissing.find((item) => item.rule.kind === 'fill-missing')).toMatchObject({ columns: [], deferredColumns: ['amount'], proposed: true, status: 'pending' })
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

  it('ranks risky proposals by estimated affected-cell impact with stable ties', () => {
    const profile = buildProfile([
      { key: 'a', value: 1, missing: null }, { key: 'a', value: 1, missing: null },
      { key: 'b', value: 2, missing: null }, { key: 'b', value: 2, missing: null },
    ], ['key', 'value', 'missing'])
    const proposal = (id: string, kind: CleaningRule['kind'], columns: string[]): PlannedRule => ({
      rule: { id, kind, enabled: false, risk: 'high', scope: { mode: 'all' }, options: {} },
      columns, columnIds: columns.map((name) => profile.columns.find((column) => column.name === name)!.id), proposed: true, status: 'pending', reason: 'Issue found',
    })
    const fill = proposal('fill-missing', 'fill-missing', ['missing'])
    const duplicates = proposal('remove-duplicates', 'remove-duplicates', ['key', 'value'])
    expect(profile.summary.fullyDuplicateRows).toBe(2)
    expect(rankRiskyProposals([fill, duplicates], profile).map((item) => item.rule.id)).toEqual(['remove-duplicates', 'fill-missing'])
    expect(rankRiskyProposals([fill, duplicates], profile)).toEqual(rankRiskyProposals([fill, duplicates], profile))
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

  it('normalizes evidenced date values, flags impossible dates, and leaves ambiguous dates for one pending decision', () => {
    const rows: DataRow[] = [{ Order_Date: '20-03-2026' }, { Order_Date: '04/05/2026' }, { Order_Date: '31-02-2026' }, { Order_Date: '03/04/2026' }]
    const result = runSmartClean(rows, buildProfile(rows, ['Order_Date']))
    expect(result.rows.map((row) => row.order_date)).toEqual(['2026-03-20', '2026-05-04', null, '2026-04-03'])
    const dateGroup = result.groups.find((group) => group.ruleId === 'normalize-dates')!
    expect(dateGroup.cellsChanged).toBe(4)
    expect(dateGroup.cellsFlagged).toBe(1)
    expect(dateGroup.samples.some((sample) => sample.includes('31-02-2026'))).toBe(true)
    expect(dateGroup.samples.some((sample) => sample.includes('2 text dates have day > 12'))).toBe(true)
    expect(result.proposed.some((proposal) => proposal.rule.kind === 'resolve-ambiguous-dates')).toBe(false)

    const noEvidence: DataRow[] = [{ Order_Date: '03/04/2026' }, { Order_Date: '10-11-2026' }]
    const ambiguous = runSmartClean(noEvidence, buildProfile(noEvidence, ['Order_Date']))
    const proposal = ambiguous.proposed.find((item) => item.rule.kind === 'resolve-ambiguous-dates')
    expect(proposal?.status).toBe('pending')
    expect(ambiguous.rows.map((row) => row.order_date)).toEqual(['03/04/2026', '10-11-2026'])
  })

  it('proposes Excel month/day swaps only from day-first evidence and applies them only after accept', () => {
    const rows: DataRow[] = [{ Order_Date: '2026-03-04', Order_ID: 'A' }, { Order_Date: '2026-03-03', Order_ID: 'B' }, { Order_Date: '20-03-2026', Order_ID: 'C' }]
    const cleaned = runSmartClean(rows, buildProfile(rows, ['Order_Date', 'Order_ID']), [], undefined, undefined, { Order_Date: [0, 1] })
    expect(cleaned.rows.map((row) => row.order_date)).toEqual(['2026-03-04', '2026-03-03', '2026-03-20'])
    const proposal = cleaned.proposed.find((item) => item.rule.kind === 'swap-excel-date-components')!
    expect(proposal.status).toBe('pending')
    expect(proposal.rule.options.evidence).toContain('day/month')
    const decision = executeRiskyDecision(cleaned.rows, { kind: 'swap-excel-date-components', columns: proposal.columns, options: { rowSignatures: JSON.parse(String(proposal.rule.options.rowSignatures)) as string[] } })
    expect(decision.result.cellsChanged).toBe(1)
    expect(decision.rows.map((row) => row.order_date)).toEqual(['2026-04-03', '2026-03-03', '2026-03-20'])
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
