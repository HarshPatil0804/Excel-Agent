import { describe, expect, it } from 'vitest'
import { buildCategoryMapping, formattedNumberParseRate, parseFormattedMoney, parseFormattedNumber, repairMojibake } from './rules'

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

  it('decodes Windows-1252 mojibake back to UTF-8, including rupee and euro', () => {
    expect(repairMojibake('â‚¹50000')).toBe('₹50000')
    expect(repairMojibake('â‚¬42')).toBe('€42')
    expect(repairMojibake('â€™')).toBe('’')
    expect(repairMojibake('MontrÃ©al')).toBe('Montréal')
    expect(repairMojibake('café')).toBe('café')
    expect(repairMojibake('₹1,200')).toBe('₹1,200')
    expect(parseFormattedNumber(repairMojibake('â‚¹50000'))).toBe(50000)
  })

  it.each([
    ['₹50,000', 50000, 'INR'],
    ['374814 INR', 374814, 'INR'],
    ['Rs 1,200', 1200, 'INR'],
    ['Rs. 12,34,567', 1234567, 'INR'],
    ['1,234,567', 1234567, null],
    ['$134,036.00', 134036, 'USD'],
    ['(1,200)', -1200, null],
    ['€1.234,56', 1234.56, 'EUR'],
    ['  12.5%  ', 0.125, null],
    ['plain text', 'plain text', null],
  ])('parses money value %s', (value, numeric, currency) => {
    expect(parseFormattedMoney(value)).toEqual({ numeric, currency })
  })

  it('measures numeric conversion eligibility while excluding missing tokens', () => {
    expect(formattedNumberParseRate(['$12', '€15', 'N/A', null])).toBe(1)
    expect(formattedNumberParseRate(['$12', 'not a number', 'plain text'])).toBeCloseTo(1 / 3)
  })

  it('uses Title Case as the deterministic tie break for category spelling', () => {
    expect(buildCategoryMapping([{ Category: 'alpha' }, { Category: 'Alpha' }], 'Category').get('alpha')).toBe('Alpha')
  })
})
