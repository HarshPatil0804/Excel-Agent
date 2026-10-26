import { describe, expect, it } from 'vitest'
import { predictFromTrainingSample, recommendMissingValues } from './localImputation'
import type { DataRow } from '../types'

describe('deterministic local imputation recommendations', () => {
  it('predicts numeric missing values repeatably from a bounded training sample', () => {
    const training: DataRow[] = [
      { group: 'a', signal: 0, amount: 10 },
      { group: 'a', signal: 1, amount: 20 },
      { group: 'b', signal: 2, amount: 30 },
    ]
    const targets: DataRow[] = [{ group: 'a', signal: 1.1, amount: null, __dc_order: 42 }]
    const first = predictFromTrainingSample(training, targets, 'amount', ['signal', 'group'], 'float')
    expect(first).toEqual(predictFromTrainingSample(training, targets, 'amount', ['signal', 'group'], 'float'))
    expect(first).toHaveLength(1)
    expect(first[0]?.sampleRow).toBe(42)
    expect(typeof first[0]?.value).toBe('number')
    expect(first[0]!.value as number).toBeGreaterThan(10)
    expect(first[0]!.value as number).toBeLessThan(30)
  })

  it('predicts categorical values with bounded disagreement uncertainty', () => {
    const training: DataRow[] = [
      { group: 'a', target: 'yes' },
      { group: 'a', target: 'yes' },
      { group: 'b', target: 'no' },
    ]
    const targets: DataRow[] = [{ group: 'a', target: null, __dc_order: 7 }]
    const estimates = predictFromTrainingSample(training, targets, 'target', ['group'], 'categorical')
    expect(estimates).toHaveLength(1)
    expect(estimates[0]).toMatchObject({ sampleRow: 7, value: 'yes' })
    expect(estimates[0]!.uncertainty).toBeGreaterThanOrEqual(0)
    expect(estimates[0]!.uncertainty).toBeLessThanOrEqual(1)
  })

  const rows: DataRow[] = Array.from({ length: 200 }, (_, index) => ({ x: index, value: index * 3 + 1, 'Customer ID': `C-${index}` }))
  for (let index = 0; index < rows.length; index += 7) rows[index]!.value = null

  it('recommends only when held-out error beats the baseline and never mutates source rows', () => {
    const before = structuredClone(rows)
    const [result] = recommendMissingValues(rows, ['value'], ['x', 'Customer ID'], 20261025)
    expect(result?.eligible).toBe(true)
    expect(result?.recommended).toBe(true)
    expect(result?.validation?.kind).toBe('numeric')
    if (result?.validation?.kind !== 'numeric') throw new Error('Expected numeric validation metrics')
    expect(result?.validation?.modelMae).toBeLessThan(result?.validation?.baselineMae ?? 0)
    expect(result?.validation).toMatchObject({ repeats: 3 })
    expect(result?.validation?.modelMape).not.toBeNull()
    expect(result?.validation?.baselineMape).not.toBeNull()
    expect(result?.estimates).toHaveLength(rows.filter((row) => row.value == null).length)
    expect(rows).toEqual(before)
  })

  it('is reproducible for a fixed seed and disables high-missing or ID columns', () => {
    const first = recommendMissingValues(rows, ['value'], ['x'], 17)
    const second = recommendMissingValues(rows, ['value'], ['x'], 17)
    expect(first).toEqual(second)
    const tooMissing = Array.from({ length: 20 }, (_, index) => ({ x: index, value: index < 10 ? null : index }))
    expect(recommendMissingValues(tooMissing, ['value'], ['x'])[0]).toMatchObject({ eligible: false, recommended: false, missingPercent: 50 })
    expect(recommendMissingValues(rows.slice(0, 40), ['value'], ['x'], 1, { value: 45 })[0]).toMatchObject({ eligible: false, missingPercent: 45 })
    expect(recommendMissingValues(rows, ['Customer ID'], ['x'])[0]?.reason).toMatch(/Identifier-like/)
    const tooFewObserved = Array.from({ length: 140 }, (_, index) => ({ x: index, value: index < 50 ? null : index }))
    expect(recommendMissingValues(tooFewObserved, ['value'], ['x'])[0]).toMatchObject({ eligible: false, reason: 'At least 100 observed numeric examples are required.' })
  })

  it('does not recommend a model that ties a zero-error baseline', () => {
    const constant = Array.from({ length: 120 }, (_, index) => ({ x: index, value: index < 10 ? null : 0 }))
    const [result] = recommendMissingValues(constant, ['value'], ['x'], 29)
    expect(result?.eligible).toBe(true)
    expect(result?.recommended).toBe(false)
    if (result?.validation?.kind !== 'numeric') throw new Error('Expected numeric validation metrics')
    expect(result?.validation?.modelMae).toBe(0)
    expect(result?.validation?.baselineMae).toBe(0)
    expect(result?.validation?.modelMape).toBeNull()
  })

  it('validates a categorical KNN classifier against a grouped most-frequent baseline', () => {
    const categorical: DataRow[] = Array.from({ length: 240 }, (_, index) => ({
      x: index,
      segment: index % 120 < 60 ? 'North' : 'South',
      region: index % 2 === 0 ? 'East' : 'West',
    }))
    for (let index = 0; index < categorical.length; index += 13) categorical[index]!.segment = null
    const original = structuredClone(categorical)
    const [result] = recommendMissingValues(categorical, ['segment'], ['x', 'region'], 20261025, {}, { segment: 'categorical' })
    expect(result?.eligible).toBe(true)
    expect(result?.recommended).toBe(true)
    expect(result?.validation).toMatchObject({ kind: 'categorical', repeats: 3, groupingColumn: 'region' })
    if (result?.validation?.kind !== 'categorical') throw new Error('Expected categorical validation metrics')
    expect(result.validation.modelAccuracy).toBeGreaterThanOrEqual(result.validation.baselineAccuracy + 0.1)
    expect(result.estimates).toHaveLength(categorical.filter((row) => row.segment == null).length)
    expect(result.estimates.every((estimate) => estimate.value === 'North' || estimate.value === 'South')).toBe(true)
    expect(categorical).toEqual(original)
  })

  it('uses bounded nominal predictors for numeric KNN regression', () => {
    const grouped: DataRow[] = Array.from({ length: 240 }, (_, index) => ({
      region: index % 2 === 0 ? 'East' : 'West',
      revenue: index % 2 === 0 ? 10 : 100,
    }))
    for (let index = 0; index < grouped.length; index += 13) grouped[index]!.revenue = null
    const [result] = recommendMissingValues(grouped, ['revenue'], ['region'], 88)
    expect(result?.eligible).toBe(true)
    expect(result?.recommended).toBe(true)
    if (result?.validation?.kind !== 'numeric') throw new Error('Expected numeric validation metrics')
    expect(result.validation.modelMae).toBeLessThan(result.validation.baselineMae)
    expect(result.estimates.length).toBeGreaterThan(0)
  })

  it('selects a seeded ridge regression when it beats KNN and the median baseline', () => {
    const linear: DataRow[] = Array.from({ length: 360 }, (_, index) => ({ x: index, amount: index < 360 && index % 11 === 0 ? null : index * 7 + 13 }))
    const [result] = recommendMissingValues(linear, ['amount'], ['x'], 531)
    expect(result?.recommended).toBe(true)
    expect(result?.validation).toMatchObject({ kind: 'numeric', model: 'ridge-regression' })
    expect(result?.estimates).toHaveLength(linear.filter((row) => row.amount == null).length)
    expect(result?.estimates.every((estimate, index) => typeof estimate.value === 'number' && Math.abs(estimate.value - (index * 11 * 7 + 13)) < 1)).toBe(true)
    const trainingRows = linear.map((row, index) => ({ ...row, __dc_order: index + 1 }))
    const largePathEstimates = predictFromTrainingSample(trainingRows, trainingRows, 'amount', ['x'], 'float', '__dc_order', 'ridge-regression')
    expect(largePathEstimates).toEqual(result?.estimates)
  })
})
