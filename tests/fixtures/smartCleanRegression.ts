import type { DataRow } from '../../src/types'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseCsvText } from '../../src/parsers/csv'

export function globalLibraryFixture(): { rows: DataRow[]; columns: string[] } {
  const columns = ['Country ', 'Expenditures ($)', 'Population', 'Region Name', 'GDP (USD)', 'Year', 'Notes']
  const rows = Array.from({ length: 219 }, (_, index): DataRow => ({
    'Country ': `Country ${index % 11}${index === 0 ? ' ' : ''}`,
    'Expenditures ($)': index % 23 === 22 ? 'N/A' : `$${((index % 101) + 1).toLocaleString('en-US')}.00`,
    Population: String(10_000 + index * 125),
    'Region Name': index % 19 === 0 ? '' : `Region ${index % 5}`,
    'GDP (USD)': index % 17 === 0 ? null : `$${((index % 97) + 4) * 1000}.50`,
    Year: String(2000 + (index % 24)),
    Notes: index % 29 === 0 ? 'N/A' : `record ${index}`,
  }))
  return { rows, columns }
}

export function trainFixture(): { rows: DataRow[]; columns: string[] } {
  const parsed = parseCsvText(readFileSync(resolve(process.cwd(), 'tests/fixtures/train.csv'), 'utf8'))
  return { rows: parsed.rows, columns: parsed.columns }
}
