import { describe, expect, it } from 'vitest'
import { detectDateOrder, normalizeDateColumn, swapDateMonthAndDay } from './dateNormalization'

describe('deterministic date normalization', () => {
  it('detects day-first order from text evidence and converts common separators to ISO', () => {
    const rows = [{ date: '20-03-2026' }, { date: '04/05/2026' }, { date: '2026.08.20' }, { date: '2026-01-01' }]
    const result = normalizeDateColumn(rows, 'date')
    expect(result.order).toMatchObject({ order: 'day-first', firstPartOver12: 1, secondPartOver12: 0 })
    expect(result.rows.map((row) => row.date)).toEqual(['2026-03-20', '2026-05-04', '2026-08-20', '2026-01-01'])
    expect(result.order.message).toContain('1 text dates have day > 12, none have month > 12')
  })

  it('does not guess when dates have no order evidence', () => {
    const result = normalizeDateColumn([{ date: '03/04/2026' }, { date: '10-11-2026' }], 'date')
    expect(result.order.order).toBe('ambiguous')
    expect(result.ambiguous).toBe(2)
    expect(result.rows.map((row) => row.date)).toEqual(['03/04/2026', '10-11-2026'])
  })

  it('detects month-first order and validates calendar and leap-year dates', () => {
    expect(detectDateOrder(['01/25/2026', '12-31-2026']).order).toBe('month-first')
    const result = normalizeDateColumn([{ date: '29-02-2024' }, { date: '29-02-2026' }, { date: '31-02-2026' }, { date: '2026-08-20' }], 'date')
    expect(result.rows.map((row) => row.date)).toEqual(['2024-02-29', null, null, '2026-08-20'])
    expect(result.invalid.map((item) => item.original)).toEqual(['29-02-2026', '31-02-2026'])
  })

  it('swaps valid Excel date month/day components but leaves equal components unchanged', () => {
    const result = normalizeDateColumn([{ date: '2026-03-04' }, { date: '2026-03-03' }, { date: '2026-11-12' }, { date: '20-03-2026' }], 'date', [0, 1, 2])
    expect(result.rows.map((row) => row.date)).toEqual(['2026-04-03', '2026-03-03', '2026-12-11', '2026-03-20'])
    expect(result.converted).toBe(3)
    expect(result.swapped).toBe(2)
    expect(swapDateMonthAndDay('2026-03-04')).toBe('2026-04-03')
    expect(swapDateMonthAndDay('2026-03-03')).toBeNull()
  })
})
