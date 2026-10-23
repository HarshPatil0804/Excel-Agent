/* global process, performance, setInterval, clearInterval, console */
import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import Papa from 'papaparse'

const path = resolve(process.argv[2] ?? './large-test.csv')
let rows = 0
let raggedRows = 0
let peakRssBytes = process.memoryUsage().rss
const start = performance.now()
const sampler = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss) }, 10)

await new Promise((resolvePromise, reject) => {
  Papa.parse(createReadStream(path), {
    header: true,
    skipEmptyLines: false,
    step(result) {
      rows++
      raggedRows += result.errors.filter((error) => error.code === 'TooManyFields' || error.code === 'TooFewFields').length
    },
    complete: resolvePromise,
    error: reject,
  })
})
clearInterval(sampler)
console.log(JSON.stringify({ path, rows, raggedRows, elapsedSeconds: Number(((performance.now() - start) / 1000).toFixed(2)), peakRssBytes }))
