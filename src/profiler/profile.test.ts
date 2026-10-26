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
})
