/// <reference lib="webworker" />
import { createRemovedRowsForExport, serializeCsv, serializeJson, serializeXlsx, verifyExport, type ExportColumn, type ExportFormat } from '../lib/exportData'
import type { DataRow } from '../types'

type Message =
  | { type: 'generate'; rows: DataRow[]; columns: ExportColumn[]; format: ExportFormat; bom?: boolean }
  | { type: 'generate-removed'; originalRows: DataRow[]; rowOrderKey?: string; removals: Array<{ rowIds: number[]; rule: string }>; originalColumns: string[] }
  | { type: 'verify'; bytes: string | ArrayBuffer; rows: DataRow[]; columns: ExportColumn[]; format: ExportFormat }

self.onmessage = (event: MessageEvent<Message>) => {
  try {
    const message = event.data
    if (message.type === 'verify') {
      self.postMessage({ type: 'verified', result: verifyExport(message.bytes, message.format, message.rows, message.columns) })
      return
    }
    if (message.type === 'generate-removed') {
      const removed = createRemovedRowsForExport(message.originalRows, message.rowOrderKey, message.removals, message.originalColumns)
      self.postMessage({ type: 'generated-removed', bytes: serializeCsv(removed.rows, removed.columns), rows: removed.rows.length })
      return
    }
    const bytes = message.format === 'csv' ? serializeCsv(message.rows, message.columns, message.bom) : message.format === 'json' ? serializeJson(message.rows, message.columns) : serializeXlsx(message.rows, message.columns)
    if (bytes instanceof ArrayBuffer) self.postMessage({ type: 'generated', bytes }, [bytes])
    else self.postMessage({ type: 'generated', bytes })
  } catch (error) { self.postMessage({ type: 'export-error', message: error instanceof Error ? error.message : String(error) }) }
}
