import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const scenarios = [
  'runs Smart Clean, accepts all risky groups',
  'validates and applies estimates to a 100k-row DuckDB dataset',
  'streams a generated 1M-row DuckDB bundle',
]

for (const scenario of scenarios) {
  process.stdout.write(`\n=== Scale scenario: ${scenario} ===\n`)
  const result = spawnSync(process.execPath, [vitest, 'run', 'src/engine/scale.test.ts', '--testNamePattern', scenario], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
