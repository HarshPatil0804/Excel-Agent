import { describe, expect, it } from 'vitest'
import { profileDataset } from './profile'

describe('domain issue profiling', () => {
  it('flags negative quantities and profits, IDs, and future dates without changing source rows', () => {
    const rows = [
      { 'Order Quantity': '-2', Profit: '-3', 'Customer ID': 'C001', 'Created Date': '2099-02-03' },
      { 'Order Quantity': '5', Profit: '9', 'Customer ID': 'C002', 'Created Date': '2020-01-01' },
      { 'Order Quantity': '0', Profit: '0', 'Customer ID': 'C003', 'Created Date': '2021-01-01' },
    ]
    const before = structuredClone(rows)
    const profile = profileDataset(rows, Object.keys(rows[0]!))
    expect(profile.columns.find((column) => column.name === 'Order Quantity')?.issues).toContainEqual(expect.objectContaining({ code: 'negative-quantity', count: 1 }))
    expect(profile.columns.find((column) => column.name === 'Profit')?.issues).toContainEqual(expect.objectContaining({ code: 'negative-profit', count: 1 }))
    expect(profile.columns.find((column) => column.name === 'Customer ID')?.issues).toContainEqual(expect.objectContaining({ code: 'identifier-column', count: 3 }))
    expect(profile.columns.find((column) => column.name === 'Created Date')?.issues).toContainEqual(expect.objectContaining({ code: 'future-date', count: 1 }))
    expect(rows).toEqual(before)
  })

  it('types currency text as numeric with parsed statistics and a review issue', () => {
    const rows = [{ Revenue: '₹1,200' }, { Revenue: '₹2,500' }, { Revenue: '₹300' }]
    const column = profileDataset(rows, ['Revenue']).columns[0]!
    expect(['integer', 'float']).toContain(column.inferredType)
    expect(column.min).toBe(300)
    expect(column.max).toBe(2500)
    expect(column.mean).toBeCloseTo(4000 / 3)
    expect(column.issues).toContainEqual(expect.objectContaining({ code: 'numeric-stored-as-text', count: 3 }))
    expect(rows[0]?.Revenue).toBe('₹1,200')
  })

  it('keeps a mostly-text column as text and reports the unparseable values', () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({ amount: index < 17 ? `$${index + 1}.00` : `bad value ${index}` }))
    const column = profileDataset(rows, ['amount']).columns[0]!
    expect(['text', 'categorical']).toContain(column.inferredType)
    expect(column.issues).toContainEqual(expect.objectContaining({ code: 'unparseable-numbers', count: 3 }))
  })
})
