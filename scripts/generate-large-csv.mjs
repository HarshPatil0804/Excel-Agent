/* global process, console */
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}
const output = resolve(option('--output', './large-test.csv'))
const rows = Number(option('--rows', '500000'))
if (!Number.isSafeInteger(rows) || rows < 1) throw new Error('--rows must be a positive integer')

const stream = createWriteStream(output, { encoding: 'utf8' })
stream.write('id,name,amount,status,mixed_date,notes,duplicate_key,protected\n')
for (let start = 0; start < rows; start += 2000) {
  let batch = ''
  const end = Math.min(rows, start + 2000)
  for (let index = start; index < end; index++) {
    const source = index - index % 2
    const duplicateKey = Math.floor(source / 2)
    const amount = source > rows - 20 ? '$999999.00' : `$${(source % 50000) + 0.25}`
    const missing = source % 19 === 0 ? 'N/A' : ' ready  '
    const date = source % 4 ? `0${(source % 9) + 1}/12/2024` : `12/0${(source % 9) + 1}/2024`
    const note = `messy row ${source} ${'x'.repeat(96)}`
    const values = [String(source), ` Person ${source % 100} `, amount, missing, date, note, String(duplicateKey), `keep-${source}`]
    batch += `${values.map((value) => `"${value.replaceAll('"', '""')}"`).join(',')}\n`
  }
  if (!stream.write(batch)) await once(stream, 'drain')
}
stream.end()
await once(stream, 'finish')
console.log(`Wrote ${rows.toLocaleString()} rows to ${output}`)
