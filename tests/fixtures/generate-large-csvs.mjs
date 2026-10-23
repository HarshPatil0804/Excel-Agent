import { createWriteStream, mkdirSync } from 'node:fs'
import { once } from 'node:events'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const outputDirectory = resolve(dirname(fileURLToPath(import.meta.url)), 'generated')
mkdirSync(outputDirectory, { recursive: true })

async function generate(name, count) {
  const output = createWriteStream(resolve(outputDirectory, name), { encoding: 'utf8' })
  output.write('row_id,name,amount,joined_on\n')
  for (let start = 1; start <= count; start += 10_000) {
    for (let row = start; row < Math.min(start + 10_000, count + 1); row += 1) {
      if (!output.write(`${row},person-${row},${row % 1007},2024-${String((row % 12) + 1).padStart(2, '0')}-15\n`)) await once(output, 'drain')
    }
  }
  output.end()
  await once(output, 'finish')
}

await generate('rows-100k.csv', 100_000)
await generate('rows-1m.csv', 1_000_000)
