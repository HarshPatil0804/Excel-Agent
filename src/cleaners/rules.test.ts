import { describe, expect, it } from 'vitest'
import { buildCategoryMapping, formattedNumberParseRate, parseFormattedNumber, repairMojibake } from './rules'

describe('formatted number and text repair helpers', () => {
  it.each([
    ['₹12,34,567.50', 1234567.5],
    ['INR 1,250.75', 1250.75],
    ['€1.234,56', 1234.56],
    ['1,25 EUR', 1.25],
    ['($1,234.00)', -1234],
  ])('parses %s deterministically', (value, expected) => {
    expect(parseFormattedNumber(value)).toBe(expected)
  })

  it('repairs only recognizable mojibake without changing ordinary text', () => {
    expect(repairMojibake('FranÃ§ais')).toBe('Français')
    expect(repairMojibake('ordinary text')).toBe('ordinary text')
    expect(repairMojibake('Ã')).toBe('Ã')
  })

  it('measures numeric conversion eligibility while excluding missing tokens', () => {
    expect(formattedNumberParseRate(['$12', '€15', 'N/A', null])).toBe(1)
    expect(formattedNumberParseRate(['$12', 'not a number', 'plain text'])).toBeCloseTo(1 / 3)
  })

  it('uses Title Case as the deterministic tie break for category spelling', () => {
    expect(buildCategoryMapping([{ Category: 'alpha' }, { Category: 'Alpha' }], 'Category').get('alpha')).toBe('Alpha')
  })
})
