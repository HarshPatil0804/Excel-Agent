import { describe, expect, it } from 'vitest'
import { buildRiskySelect } from './riskySql'
import type { RiskyDecision } from '../types'

const build = (kind: RiskyDecision['kind'], options: RiskyDecision['options'] = {}, columns = ['a', 'b']): string => buildRiskySelect({ kind, options, columns, }, ['a', 'b', '名前'], ['b'], 'source_version')

describe('DuckDB risky SQL plans', () => {
  it('keeps stable order and supports null-aware keyed duplicates with first or last retention', () => {
    const first = build('remove-duplicates', { keys: ['a'], keep: 'first' })
    const last = build('remove-duplicates', { keys: ['a'], keep: 'last' })
    expect(first).toContain('PARTITION BY "a" ORDER BY __dc_order ASC')
    expect(last).toContain('PARTITION BY "a" ORDER BY __dc_order DESC')
    expect(first).toContain('ORDER BY __dc_order')
  })

  it.each(['drop-rows', 'mean', 'median', 'mode', 'constant', 'forward-fill'])('builds missing-value SQL for %s', (strategy) => {
    const sql = build('fill-missing', { strategy, value: '空', ...(strategy === 'forward-fill' ? { orderedRows: true } : {}) })
    expect(sql).toContain('"a"')
    expect(sql).toContain('__dc_order')
    if (strategy === 'drop-rows') expect(sql).toContain("'n/a'")
    if (strategy === 'mean') expect(sql).toContain('AVG(TRY_CAST')
    if (strategy === 'median') expect(sql).toContain('MEDIAN(TRY_CAST')
    if (strategy === 'mode') expect(sql).toContain('ORDER BY COUNT(*) DESC')
    if (strategy === 'constant') expect(sql).toContain("'空'")
    if (strategy === 'forward-fill') expect(sql).toContain('IGNORE NULLS')
  })

  it('blocks forward fill SQL unless row ordering is explicitly confirmed', () => {
    expect(() => build('fill-missing', { strategy: 'forward-fill' })).toThrow(/ordered by time/i)
  })

  it.each(['group-median', 'group-mode'])('builds correlated SQL for %s', (strategy) => {
    const sql = build('fill-missing', { strategy, groupBy: '名前' }, ['a'])
    expect(sql).toContain('IS NOT DISTINCT FROM source_version."名前"')
    expect(sql).toContain('group_source')
    expect(sql).toContain(strategy === 'group-median' ? 'MEDIAN(TRY_CAST' : 'ORDER BY COUNT(*) DESC')
  })

  it.each(['flag', 'cap', 'remove'])('builds outlier SQL for %s', (action) => {
    const sql = build('handle-outliers', { action })
    expect(sql).toContain('__dc_order')
    if (action !== 'flag') expect(sql).toContain('QUANTILE_CONT')
    if (action === 'cap') expect(sql).toContain('GREATEST')
    if (action === 'remove') expect(sql).toContain('WHERE NOT')
  })

  it('escapes unicode and SQL punctuation in category mappings and identifiers', () => {
    const sql = build('standardize-categories', { mapping: '{"東京":"東京・東","O\'Brien":"O\'B"}' }, ['名前'])
    expect(sql).toContain('"名前"')
    expect(sql).toContain("'東京・東'")
    expect(sql).toContain("'O''B'")
  })

  it('resolves either ambiguous date order without changing non-date text', () => {
    expect(build('resolve-ambiguous-dates', { order: 'day-first' })).toContain('%d/%m/%Y')
    expect(build('resolve-ambiguous-dates', { order: 'month-first' })).toContain('%m/%d/%Y')
  })
})
