/// <reference lib="webworker" />
import { createChangesCsv, serializeCsv, serializeJson, serializeXlsx, type ExportColumn, type ExportFormat } from '../lib/exportData'
import { createStoredZip } from '../lib/zip'
import type { DataRow } from '../types'

self.onmessage = (event: MessageEvent<{ rows: DataRow[]; originalRows: DataRow[]; rowOrderKey?: string; columns: ExportColumn[]; format: ExportFormat; report: string; recipe: string; ruleByColumn: Record<string, string>; stepByColumn: Record<string, number>; suggestedName: string }>) => {
  try {
    const { rows, originalRows, rowOrderKey, columns, format, report, recipe, ruleByColumn, stepByColumn, suggestedName } = event.data
    const clean = format === 'csv' ? serializeCsv(rows, columns) : format === 'json' ? serializeJson(rows, columns) : serializeXlsx(rows, columns)
    const data = typeof clean === 'string' ? clean : new Uint8Array(clean)
    const changes = createChangesCsv(originalRows, rows, columns, ruleByColumn, rowOrderKey, stepByColumn)
    const entries = [
      { name: suggestedName, data },
      { name: 'changes.csv', data: changes },
      { name: 'cleaning-report.md', data: report },
      { name: 'recipe.json', data: recipe },
    ]
    const zip = createStoredZip(entries)
    self.postMessage({ type: 'zip-complete', bytes: zip.buffer, size: zip.byteLength }, [zip.buffer])
  } catch (error) { self.postMessage({ type: 'zip-failed', message: error instanceof Error ? error.message : String(error) }) }
}
