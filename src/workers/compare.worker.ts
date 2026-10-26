/// <reference lib="webworker" />
import { getChangedCells, serializeChangesCsv } from '../lib/exportData'
import type { DataRow } from '../types'

self.onmessage = (event: MessageEvent<{ type: 'diff'; original: DataRow[]; cleaned: DataRow[]; columns: Array<{ source: string; name: string; originalSource?: string }>; rules?: Record<string, string>; rowOrderKey?: string }>) => {
  const { original, cleaned, columns, rules, rowOrderKey } = event.data
  const changes = getChangedCells(original, cleaned, columns, rules, rowOrderKey)
  self.postMessage({ type: 'diff-complete', changes, csv: serializeChangesCsv(changes) })
}
