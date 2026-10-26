import { useEffect, useMemo, useRef, useState } from 'react'
import { useDatasetStore } from '../../store/datasetStore'
import { serializeChangesCsv, verifyExport, type ChangedCell, type ExportColumn, type ExportFormat } from '../../lib/exportData'
import { buildCleaningReportMarkdown } from '../../lib/cleaningReport'
import { LOW_RISK_RULES, RISKY_RULES, createRecipe } from '../../engine/smartClean'
import { exportRecipeJson } from '../../recipes/recipeStore'

interface Props { worker: Worker | null; downloaded: () => void }
interface SaveHandle { createWritable(): Promise<{ write(data: string | ArrayBuffer | Uint8Array | Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>; getFile?(): Promise<File> }
interface SavePickerWindow extends Window { showSaveFilePicker?: (options: { suggestedName: string; types?: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<SaveHandle> }
interface ExportMessage { type: string; requestId?: string; chunk?: string; bytes?: ArrayBuffer; done?: boolean; rowsProcessed?: number; rowCount?: number; percent?: number; stage?: string; message?: string; changes?: ChangedCell[]; hasMore?: boolean; offset?: number; result?: ReturnType<typeof verifyExport> }

const valueText = (value: unknown): string => value == null || value === '' ? 'empty' : String(value)
const basename = (name: string): string => name.replace(/\.[^.]+$/, '') || 'data'
const buildRuleLabels = (groups: Array<{ columns: string[]; label: string }>, steps: Array<{ ruleId: string; label: string; scope: { include?: string[] }; estimateDetailsByColumn?: Record<string, string>; undone: boolean }>): Record<string, string> => {
  const labels = Object.fromEntries(groups.flatMap((group) => group.columns.map((name) => [name, group.label])))
  for (const step of steps) if (!step.undone && step.ruleId !== 'smart-clean') for (const name of step.scope.include ?? []) labels[name] = step.estimateDetailsByColumn?.[name] ? `${step.ruleId} · ${step.estimateDetailsByColumn[name]}` : step.label
  return labels
}
const saveBlob = (blob: Blob, name: string): void => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function PhaseFivePanel({ worker, downloaded }: Props) {
  const store = useDatasetStore()
  const { dataset, rows, originalRows, profile, originalProfile, changeSteps } = store
  const [tab, setTab] = useState<'download' | 'compare'>('download')
  const [format, setFormat] = useState<ExportFormat>('csv')
  const [includeAll, setIncludeAll] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const [columnSearch, setColumnSearch] = useState('')
  const [useOriginalNames, setUseOriginalNames] = useState(false)
  const [bom, setBom] = useState(false)
  const [busy, setBusy] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [progress, setProgress] = useState({ rows: 0, total: 0, percent: 0 })
  const [notice, setNotice] = useState('')
  const [generated, setGenerated] = useState<{ bytes: string | ArrayBuffer; format: ExportFormat; columns: ExportColumn[] } | null>(null)
  const [largeGenerated, setLargeGenerated] = useState<{ file: File; format: 'csv' | 'jsonl'; columns: ExportColumn[] } | null>(null)
  const [verification, setVerification] = useState<ReturnType<typeof verifyExport> | null>(null)
  const [diff, setDiff] = useState<ChangedCell[] | null>(null)
  const [diffQuery, setDiffQuery] = useState('')
  const [diffScroll, setDiffScroll] = useState(0)
  const [diffOffset, setDiffOffset] = useState(0)
  const [diffHasMore, setDiffHasMore] = useState(false)
  const [diffBusy, setDiffBusy] = useState(false)
  const [columnScroll, setColumnScroll] = useState(0)
  const [columnTypeFilter, setColumnTypeFilter] = useState('all')
  const [columnRuleFilter, setColumnRuleFilter] = useState('all')
  const [changedOnly, setChangedOnly] = useState(false)
  const [changeSearch, setChangeSearch] = useState('')
  const workerBuffers = useRef<string[]>([])
  const zipBuffers = useRef<Uint8Array[]>([])
  const writableRef = useRef<Awaited<ReturnType<SaveHandle['createWritable']>> | null>(null)
  const saveHandleRef = useRef<SaveHandle | null>(null)
  const localWorkerRef = useRef<Worker | null>(null)
  const requestIdRef = useRef('')
  const compareRequestRef = useRef('')
  const verifyRequestRef = useRef('')
  const pickerChosenRef = useRef(false)
  const cancelRef = useRef(false)
  const streamKindRef = useRef<'cleaned' | 'removed' | 'zip'>('cleaned')

  const columns = useMemo<ExportColumn[]>(() => (profile?.columns ?? []).map((column) => ({
    source: column.name,
    name: useOriginalNames ? originalProfile?.columns.find((item) => item.id === column.id)?.name ?? column.name : column.name,
    originalSource: originalProfile?.columns.find((item) => item.id === column.id)?.name ?? column.name,
    type: column.inferredType,
  })), [profile, originalProfile, useOriginalNames])
  const visibleColumns = columns.filter((column) => column.name.toLowerCase().includes(columnSearch.toLowerCase()))
  const selectedColumns = includeAll ? columns : columns.filter((column) => selected.includes(column.source))
  const activeSteps = changeSteps.filter((step) => !step.undone)
  const totals = activeSteps.reduce((sum, step) => ({ cells: sum.cells + step.cellsChanged, estimated: sum.estimated + (step.cellsEstimated ?? 0), rows: sum.rows + step.rowsRemoved, renamed: sum.renamed + step.columnsRenamed, flagged: sum.flagged + step.flaggedCells }), { cells: 0, estimated: 0, rows: 0, renamed: 0, flagged: 0 })
  const filledCells = activeSteps.filter((step) => step.ruleId === 'fill-missing').reduce((sum, step) => sum + step.cellsChanged - (step.cellsEstimated ?? 0), 0)
  const colDiff = (profile?.columns ?? []).map((column) => {
    const before = originalProfile?.columns.find((item) => item.id === column.id)
    const groups = store.cleanResult?.groups.filter((group) => group.columnIds?.includes(column.id) || group.columns.includes(column.name) || Boolean(before && group.columns.includes(before.name))) ?? []
    const rules = [...groups.map((group) => group.label), ...activeSteps.filter((step) => step.ruleId !== 'smart-clean' && step.samples.some((sample) => Object.hasOwn(sample.before, column.name))).map((step) => step.label)]
    return { id: column.id, original: before?.name ?? column.name, cleaned: column.name, beforeType: before?.inferredType ?? '—', afterType: column.inferredType, beforeNulls: before?.nullCount ?? 0, afterNulls: column.nullCount, rules: [...new Set(rules)], changed: groups.some((group) => (group.cellsChanged ?? group.affectedRows) > 0) || rules.length > 0 }
  }).filter((column) => `${column.original} ${column.cleaned} ${column.rules.join(' ')}`.toLowerCase().includes(changeSearch.toLowerCase()) && (columnTypeFilter === 'all' || column.afterType === columnTypeFilter) && (columnRuleFilter === 'all' || column.rules.includes(columnRuleFilter)) && (!changedOnly || column.changed))
  const columnStart = Math.max(0, Math.floor(columnScroll / 36) - 3)
  const columnVisible = Math.ceil(420 / 36) + 6
  const ruleOptions = [...new Set(colDiff.flatMap((column) => column.rules))]
  const visibleDiff = (diff ?? []).filter((change) => `${change.column} ${change.rule}`.toLowerCase().includes(diffQuery.toLowerCase()))
  const diffStart = Math.max(0, Math.floor(diffScroll / 36) - 3)
  const changedRows = Math.max(1, Math.ceil(420 / 36))
  const suggestedName = `${basename(dataset?.name ?? 'data')}_cleaned.${format === 'json' && dataset?.largeFileMode ? 'jsonl' : format}`

  useEffect(() => {
    if (!worker) return
    const onMessage = async (event: MessageEvent<ExportMessage>) => {
      const message = event.data
      if (message.requestId !== requestIdRef.current) return
      if (cancelRef.current) return
      if (message.type === 'export-zip-progress') {
        setProgress({ rows: message.rowsProcessed ?? 0, total: message.rowCount ?? 0, percent: message.percent ?? 0 })
        if (message.stage) setNotice(`${message.stage}…`)
      }
      if (message.type === 'export-zip-chunk' && message.bytes) {
        const bytes = new Uint8Array(message.bytes)
        try {
          if (writableRef.current) await writableRef.current.write(bytes)
          else zipBuffers.current.push(bytes)
        } catch (error) {
          worker.postMessage({ type: 'export-cancel', requestId: requestIdRef.current })
          if (writableRef.current) void writableRef.current.abort().catch(() => undefined)
          writableRef.current = null; saveHandleRef.current = null; zipBuffers.current = []; setBusy(false)
          setNotice(error instanceof Error ? error.message : 'Could not write the ZIP bundle; no partial file was kept.')
          return
        }
        setProgress({ rows: message.rowsProcessed ?? 0, total: message.rowCount ?? 0, percent: message.percent ?? 0 })
        if (message.done) {
          const fileName = `${basename(dataset?.name ?? 'data')}_cleaning_bundle.zip`
          if (writableRef.current) {
            try { await writableRef.current.close(); writableRef.current = null; saveHandleRef.current = null }
            catch (error) { setBusy(false); setNotice(error instanceof Error ? error.message : 'Could not finish writing the ZIP bundle.'); return }
          } else {
            const blob = new Blob(zipBuffers.current, { type: 'application/zip' })
            zipBuffers.current = []
            saveBlob(blob, fileName)
          }
          setBusy(false); setNotice('Download bundle ready and downloaded.'); downloaded()
        } else worker.postMessage({ type: 'export-next', requestId: requestIdRef.current })
        return
      }
      if (message.type === 'export-chunk') {
        setProgress({ rows: message.rowsProcessed ?? 0, total: message.rowCount ?? 0, percent: message.percent ?? 0 })
        if (message.chunk) {
          try {
            if (writableRef.current) await writableRef.current.write(message.chunk)
            else workerBuffers.current.push(message.chunk)
          } catch (error) {
            worker.postMessage({ type: 'export-cancel', requestId: requestIdRef.current })
            if (writableRef.current) void writableRef.current.abort().catch(() => undefined)
            writableRef.current = null; saveHandleRef.current = null; workerBuffers.current = []; setBusy(false)
            setNotice(error instanceof Error ? error.message : 'Could not write the export; no partial file was kept.')
            return
          }
        }
        if (message.done) {
          setBusy(false)
          const removedExport = streamKindRef.current === 'removed'
          if (writableRef.current) {
            try {
              await writableRef.current.close(); writableRef.current = null
              let canVerify = false
              if (!removedExport && saveHandleRef.current?.getFile) {
                try {
                  const file = await saveHandleRef.current.getFile()
                  setLargeGenerated({ file, format: format === 'json' ? 'jsonl' : 'csv', columns: selectedColumns })
                  canVerify = true
                } catch { /* the file is saved; this browser cannot reopen it for verification */ }
              }
              saveHandleRef.current = null
              setNotice(removedExport ? 'Removed rows export saved.' : canVerify ? 'Export saved. Use Verify download to compare it with DuckDB.' : 'Export saved. This browser does not allow reopening the saved file for verification.')
              if (!removedExport) downloaded()
            }
            catch (error) { setNotice(error instanceof Error ? error.message : 'Could not finish writing the file.') }
          } else {
            const content = workerBuffers.current.join('')
            workerBuffers.current = []
            const exportedFormat = removedExport ? 'csv' : format === 'json' && dataset?.largeFileMode ? 'jsonl' : format
            const name = removedExport ? `${basename(dataset?.name ?? 'data')}_removed_rows.csv` : suggestedName
            if (!removedExport && !dataset?.largeFileMode) setGenerated({ bytes: content, format, columns: selectedColumns })
            const blob = new Blob([content], { type: exportedFormat === 'csv' ? 'text/csv;charset=utf-8' : 'application/x-ndjson;charset=utf-8' })
            saveBlob(blob, name)
            if (!removedExport) setLargeGenerated({ file: new File([blob], name, { type: blob.type }), format: format === 'json' ? 'jsonl' : 'csv', columns: selectedColumns })
            setNotice(removedExport ? 'Removed rows downloaded. The Blob fallback used memory.' : 'Export ready and downloaded. Large-file fallback used memory; choose a browser that supports save location selection for the lowest memory use.')
            if (!removedExport) downloaded()
          }
        } else worker.postMessage({ type: 'export-next', requestId: requestIdRef.current })
      }
      if (message.type === 'export-failed') {
        const errorText = message.message ?? 'The export failed.'
        const friendlyText = /out of memory|allocation failed|memory access out of bounds|wasm.*memory/i.test(errorText)
          ? 'The browser ran out of memory while exporting. Close other tabs and try again, or download the cleaned CSV and report separately.'
          : errorText
        setBusy(false); setNotice(friendlyText)
        if (writableRef.current) void writableRef.current.abort().catch(() => undefined)
        writableRef.current = null; workerBuffers.current = []; zipBuffers.current = []; saveHandleRef.current = null
      }
      if (message.type === 'export-cancelled') { setBusy(false); setNotice('Export cancelled. No fallback file was downloaded.'); workerBuffers.current = []; zipBuffers.current = [] }
    }
    worker.addEventListener('message', onMessage)
    return () => worker.removeEventListener('message', onMessage)
  }, [worker, format, selectedColumns, downloaded, suggestedName, dataset?.name, dataset?.largeFileMode])

  useEffect(() => {
    if (!worker) return
    const onWorkerError = () => {
      if (writableRef.current) void writableRef.current.abort().catch(() => undefined)
      writableRef.current = null; saveHandleRef.current = null; workerBuffers.current = []; zipBuffers.current = []
      setBusy(false); setVerifying(false); setNotice('The local data worker stopped unexpectedly. No partial bundle was kept; retry the export or use CSV for a smaller file.')
    }
    worker.addEventListener('error', onWorkerError)
    return () => worker.removeEventListener('error', onWorkerError)
  }, [worker])

  useEffect(() => {
    if (!worker) return
    const onComparePage = (event: MessageEvent<ExportMessage>) => {
      const message = event.data
      if (message.requestId !== compareRequestRef.current) return
      if (message.type === 'compare-page') {
        const ruleByColumn = Object.fromEntries((store.cleanResult?.groups ?? []).flatMap((group) => group.columns.map((name) => [name, group.label])))
        setDiff((message.changes ?? []).map((change) => ({ ...change, rule: change.rule === 'cleaning rule' ? ruleByColumn[change.column] ?? change.rule : change.rule })))
        setDiffOffset(message.offset ?? 0); setDiffHasMore(message.hasMore ?? false); setDiffBusy(false); setDiffScroll(0)
      }
      if (message.type === 'compare-page-failed') { setNotice(message.message ?? 'The comparison query failed.'); setDiffBusy(false) }
    }
    worker.addEventListener('message', onComparePage)
    return () => worker.removeEventListener('message', onComparePage)
  }, [worker, store.cleanResult])

  useEffect(() => {
    if (!worker) return
    const onVerify = (event: MessageEvent<ExportMessage>) => {
      const message = event.data
      if (message.requestId !== verifyRequestRef.current) return
      if (message.type === 'verify-export-progress') setProgress({ rows: message.rowsProcessed ?? 0, total: message.rowCount ?? 0, percent: message.rowCount ? Math.min(100, Math.round((message.rowsProcessed ?? 0) / message.rowCount * 100)) : 100 })
      if (message.type === 'verify-export-complete' && message.result) { setBusy(false); setVerifying(false); setVerification(message.result); setNotice(message.result.pass ? 'The generated file matches the current DuckDB dataset.' : 'The generated file differs from the current DuckDB dataset.') }
      if (message.type === 'verify-export-failed') { setBusy(false); setVerifying(false); setNotice(message.message ?? 'The generated file could not be verified.') }
    }
    worker.addEventListener('message', onVerify)
    return () => worker.removeEventListener('message', onVerify)
  }, [worker])

  const download = async () => {
    if (!dataset || !selectedColumns.length) { setNotice('Choose at least one column to download.'); return }
    if (format === 'xlsx' && (dataset.rowCount + 1 > 1_048_576 || dataset.largeFileMode)) { setNotice('XLSX is limited to 1,048,576 rows and may use substantial memory. Choose CSV for large datasets.'); return }
    setNotice(''); setVerification(null); setLargeGenerated(null); setBusy(true); setVerifying(false); cancelRef.current = false; streamKindRef.current = 'cleaned'
    if (dataset.largeFileMode) {
      if (!worker) { setBusy(false); setNotice('The local DuckDB session is unavailable. Upload the file again to export.'); return }
      const pickerWindow = window as SavePickerWindow
      pickerChosenRef.current = Boolean(pickerWindow.showSaveFilePicker)
      if (pickerWindow.showSaveFilePicker) {
        try { const handle = await pickerWindow.showSaveFilePicker({ suggestedName, types: [{ description: format === 'csv' ? 'CSV file' : 'JSON Lines file', accept: { [format === 'csv' ? 'text/csv' : 'application/x-ndjson']: [format === 'csv' ? '.csv' : '.jsonl'] } }] }); saveHandleRef.current = handle; writableRef.current = await handle.createWritable() }
        catch { setBusy(false); setNotice('Save was cancelled. No file was created.'); return }
      } else setNotice('This browser will use a Blob fallback and may need substantial memory for a very large export.')
      workerBuffers.current = []; requestIdRef.current = crypto.randomUUID()
      worker.postMessage({ type: 'export-stream', requestId: requestIdRef.current, format: format === 'json' ? 'jsonl' : 'csv', columns: selectedColumns.map(({ source, name, type }) => ({ source, name, type })), bom })
      return
    }
    if (!rows) { setBusy(false); setNotice('The current in-memory data is unavailable.'); return }
    const exportWorker = new Worker(new URL('../../workers/export.worker.ts', import.meta.url), { type: 'module', name: 'datacleaner-export' })
    localWorkerRef.current = exportWorker
    exportWorker.onmessage = (event: MessageEvent<{ type: string; bytes?: string | ArrayBuffer; message?: string }>) => {
      exportWorker.terminate(); localWorkerRef.current = null; setBusy(false)
      if (event.data.type !== 'generated' || event.data.bytes === undefined) { setNotice(event.data.message ?? 'The export could not be generated.'); return }
      const bytes = event.data.bytes
      const blob = format === 'xlsx' ? new Blob([bytes as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }) : new Blob([bytes as string], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8' })
      saveBlob(blob, suggestedName); setGenerated({ bytes, format, columns: selectedColumns }); setNotice('Export ready and downloaded. Use Verify download to check the generated file against the cleaned dataset.'); downloaded()
    }
    exportWorker.onerror = () => { exportWorker.terminate(); localWorkerRef.current = null; setBusy(false); setNotice('The export worker stopped unexpectedly.') }
    exportWorker.postMessage({ type: 'generate', rows, columns: selectedColumns, format, bom })
  }
  const cancel = () => { if (verifying) return; cancelRef.current = true; localWorkerRef.current?.terminate(); localWorkerRef.current = null; if (worker && requestIdRef.current) worker.postMessage({ type: 'export-cancel', requestId: requestIdRef.current }); if (writableRef.current) void writableRef.current.abort().catch(() => undefined); writableRef.current = null; saveHandleRef.current = null; workerBuffers.current = []; zipBuffers.current = []; setBusy(false); setNotice('Export cancelled; any partial save was aborted.') }
  const downloadRemovedRows = async () => {
    if (!dataset) return
    if (!dataset.largeFileMode) {
      if (!originalRows) { setNotice('The original in-memory rows are unavailable.'); return }
      const removals = activeSteps.filter((step) => step.removedRowIds?.length).map((step) => ({ rowIds: step.removedRowIds!, rule: step.label }))
      const exportWorker = new Worker(new URL('../../workers/export.worker.ts', import.meta.url), { type: 'module', name: 'datacleaner-removed-row-export' })
      localWorkerRef.current = exportWorker; setBusy(true); setNotice('Preparing removed source rows in a worker…')
      exportWorker.onmessage = (event: MessageEvent<{ type: string; bytes?: string; rows?: number; message?: string }>) => {
        exportWorker.terminate(); localWorkerRef.current = null; setBusy(false)
        if (event.data.type !== 'generated-removed' || event.data.bytes === undefined) { setNotice(event.data.message ?? 'Removed rows could not be exported.'); return }
        saveBlob(new Blob([event.data.bytes], { type: 'text/csv;charset=utf-8' }), `${basename(dataset.name)}_removed_rows.csv`)
        setNotice(`${(event.data.rows ?? 0).toLocaleString()} removed rows downloaded with their rule labels.`)
      }
      exportWorker.onerror = () => { exportWorker.terminate(); localWorkerRef.current = null; setBusy(false); setNotice('The removed-row export worker stopped unexpectedly.') }
      exportWorker.postMessage({ type: 'generate-removed', originalRows, rowOrderKey: dataset.rowOrderKey, removals, originalColumns: originalProfile?.columns.map((column) => column.name) ?? [] })
      return
    }
    if (!worker) { setNotice('The local dataset worker is unavailable.'); return }
    setBusy(true); setProgress({ rows: 0, total: totals.rows, percent: 0 }); cancelRef.current = false; streamKindRef.current = 'removed'
    const pickerWindow = window as SavePickerWindow
    const suggestedRemovedName = `${basename(dataset.name)}_removed_rows.csv`
    if (pickerWindow.showSaveFilePicker) {
      try { const handle = await pickerWindow.showSaveFilePicker({ suggestedName: suggestedRemovedName, types: [{ description: 'CSV file', accept: { 'text/csv': ['.csv'] } }] }); saveHandleRef.current = handle; writableRef.current = await handle.createWritable() }
      catch { setBusy(false); setNotice('Save was cancelled. No file was created.'); return }
    }
    workerBuffers.current = []; requestIdRef.current = crypto.randomUUID()
    worker.postMessage({ type: 'export-removed-stream', requestId: requestIdRef.current })
  }
  const verifyGenerated = () => {
    if (largeGenerated && worker) {
      const requestId = crypto.randomUUID(); verifyRequestRef.current = requestId; setVerification(null); setProgress({ rows: 0, total: dataset?.rowCount ?? 0, percent: 0 }); setBusy(true); setVerifying(true); setNotice('Re-parsing the generated file in a worker and comparing it with DuckDB…')
      worker.postMessage({ type: 'verify-export-file', requestId, file: largeGenerated.file, format: largeGenerated.format, columns: largeGenerated.columns.map(({ source, name, type }) => ({ source, name, type })) })
      return
    }
    if (!generated || !rows) return
    const verifyWorker = new Worker(new URL('../../workers/export.worker.ts', import.meta.url), { type: 'module', name: 'datacleaner-verify-export' })
    setBusy(true); setVerifying(true)
    verifyWorker.onmessage = (event: MessageEvent<{ type: string; result?: ReturnType<typeof verifyExport> }>) => { verifyWorker.terminate(); setBusy(false); setVerifying(false); if (event.data.result) setVerification(event.data.result) }
    verifyWorker.onerror = () => { verifyWorker.terminate(); setBusy(false); setVerifying(false); setNotice('The verification worker stopped unexpectedly.') }
    verifyWorker.postMessage({ type: 'verify', bytes: generated.bytes, format: generated.format, rows, columns: generated.columns })
  }
  const runDiff = () => {
    if (dataset?.largeFileMode) {
      if (!worker) { setNotice('The local DuckDB session is unavailable.'); return }
      const requestId = crypto.randomUUID(); compareRequestRef.current = requestId; setDiffBusy(true); setNotice('Loading a changed-cell page from DuckDB…')
      const ruleByColumn = buildRuleLabels(store.cleanResult?.groups ?? [], activeSteps)
      worker.postMessage({ type: 'compare-page', requestId, offset: 0, limit: 1000, rules: ruleByColumn })
      return
    }
    if (!originalRows || !rows) { setNotice('Cell-level comparison is paged in DuckDB and will appear here when a large-file compare query is available.'); return }
    const compareWorker = new Worker(new URL('../../workers/compare.worker.ts', import.meta.url), { type: 'module', name: 'datacleaner-compare' })
    compareWorker.onmessage = (event: MessageEvent<{ type: string; changes: typeof diff }>) => { if (event.data.type === 'diff-complete') setDiff(event.data.changes); compareWorker.terminate() }
    compareWorker.onerror = () => { setNotice('Cell comparison stopped unexpectedly.'); compareWorker.terminate() }
    const ruleByColumn = buildRuleLabels(store.cleanResult?.groups ?? [], activeSteps)
    compareWorker.postMessage({ type: 'diff', original: originalRows, cleaned: rows, columns: columns.map(({ source, name, originalSource }) => ({ source, name, originalSource })), rules: ruleByColumn, rowOrderKey: dataset?.rowOrderKey })
  }
  const loadDiffPage = (offset: number) => {
    if (!worker || !dataset?.largeFileMode) return
    const requestId = crypto.randomUUID(); compareRequestRef.current = requestId; setDiffBusy(true)
    worker.postMessage({ type: 'compare-page', requestId, offset, limit: 1000 })
  }
  const reportText = () => buildCleaningReportMarkdown({
    datasetName: dataset?.name ?? 'Dataset', rowsBefore: originalProfile?.summary.rows ?? dataset?.rowCount ?? 0, rowsAfter: profile?.summary.rows ?? 0,
    columnsBefore: originalProfile?.summary.columns ?? dataset?.columnCount ?? 0, columnsAfter: profile?.summary.columns ?? 0,
    cellsChanged: totals.cells, cellsFilled: filledCells, cellsEstimated: totals.estimated, rowsRemoved: totals.rows, columnsRenamed: totals.renamed, cellsFlagged: totals.flagged,
    steps: activeSteps.map((step) => ({ ...step, cellsFlagged: step.flaggedCells })), decisions: Object.entries(store.decisionStates),
    flaggedUnchanged: profile?.columns.flatMap((column) => column.issues.map((issue) => ({ column: column.name, message: issue.message, count: issue.count ?? 0 }))) ?? [],
  })
  const makeReport = (formatKind: 'md' | 'html') => {
    const body = reportText()
    if (formatKind === 'md') saveBlob(new Blob([body], { type: 'text/markdown;charset=utf-8' }), `${basename(dataset?.name ?? 'data')}_cleaning_report.md`)
    else saveBlob(new Blob([`<!doctype html><html><head><meta charset="utf-8"><title>Cleaning report</title><style>body{font:16px/1.5 system-ui;max-width:900px;margin:40px auto;padding:0 24px}pre{white-space:pre-wrap}</style></head><body><pre>${body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre></body></html>`], { type: 'text/html;charset=utf-8' }), `${basename(dataset?.name ?? 'data')}_cleaning_report.html`)
  }
  const downloadAll = async () => {
    if (!dataset || !profile) return
    const recipe = createRecipe(`${dataset.name} Smart Clean`, [...LOW_RISK_RULES, ...RISKY_RULES], store.protectedColumns, profile.columns)
    const report = reportText()
    const ruleByColumn: Record<string, string> = {}
    for (const group of store.cleanResult?.groups ?? []) {
      for (const id of group.columnIds ?? []) {
        const column = profile.columns.find((item) => item.id === id)
        if (column) ruleByColumn[column.name] = group.label
      }
      for (const name of group.columns) {
        const column = profile.columns.find((item) => item.name === name) ?? profile.columns.find((item) => item.id === originalProfile?.columns.find((before) => before.name === name)?.id)
        if (column) ruleByColumn[column.name] = group.label
      }
    }
    for (const step of activeSteps) if (step.ruleId !== 'smart-clean') for (const name of step.scope.include ?? []) {
      const column = profile.columns.find((item) => item.name === name) ?? profile.columns.find((item) => item.id === originalProfile?.columns.find((before) => before.name === name)?.id)
      if (column) ruleByColumn[column.name] = step.estimateDetailsByColumn?.[name] ? `${step.ruleId} · ${step.estimateDetailsByColumn[name]}` : step.label
    }
    const stepByColumn: Record<string, number> = {}
    activeSteps.forEach((step, index) => step.samples.forEach((sample) => Object.keys(sample.before).forEach((name) => {
      const column = profile.columns.find((item) => item.name === name) ?? profile.columns.find((item) => item.id === originalProfile?.columns.find((before) => before.name === name)?.id)
      if (column) stepByColumn[column.name] ??= index + 1
    })))
    if (dataset.largeFileMode) {
      if (!worker) { setNotice('The local DuckDB session is unavailable. Upload the file again to build the ZIP bundle.'); return }
      if (format === 'xlsx') { setNotice('Large-file ZIP bundles use streamed CSV or JSON Lines. Choose CSV or JSON Lines, then try again.'); return }
      const pickerWindow = window as SavePickerWindow
      if (pickerWindow.showSaveFilePicker) {
        try { const handle = await pickerWindow.showSaveFilePicker({ suggestedName: `${basename(dataset.name)}_cleaning_bundle.zip`, types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }] }); saveHandleRef.current = handle; writableRef.current = await handle.createWritable() }
        catch { setNotice('Save was cancelled. No file was created.'); return }
      } else setNotice('Building the ZIP in worker batches. This browser will assemble a Blob and may use substantial memory.')
      for (const column of selectedColumns) {
        if (ruleByColumn[column.source]) ruleByColumn[column.name] = ruleByColumn[column.source]!
        if (stepByColumn[column.source]) stepByColumn[column.name] = stepByColumn[column.source]!
      }
      setBusy(true); setProgress({ rows: 0, total: 0, percent: 0 }); cancelRef.current = false; streamKindRef.current = 'zip'; zipBuffers.current = []; workerBuffers.current = []
      requestIdRef.current = crypto.randomUUID()
      worker.postMessage({ type: 'download-all-large', requestId: requestIdRef.current, format: format === 'json' ? 'jsonl' : 'csv', columns: selectedColumns.map(({ source, name, type }) => ({ source, name, type })), fileName: suggestedName, report, recipe: exportRecipeJson(recipe), ruleByColumn, stepByColumn, bom })
      return
    }
    if (!rows) { setNotice('The current in-memory data is unavailable for ZIP export.'); return }
    if (!originalRows) { setNotice('The original in-memory rows are unavailable for the changes report.'); return }
    const zipWorker = new Worker(new URL('../../workers/zip.worker.ts', import.meta.url), { type: 'module', name: 'datacleaner-zip-export' })
    setBusy(true); setNotice('Building ZIP locally in a worker…')
    zipWorker.onmessage = (event: MessageEvent<{ type: string; bytes?: ArrayBuffer; message?: string }>) => {
      zipWorker.terminate(); setBusy(false)
      if (event.data.type === 'zip-complete' && event.data.bytes) { saveBlob(new Blob([event.data.bytes], { type: 'application/zip' }), `${basename(dataset.name)}_cleaning_bundle.zip`); setNotice('Download bundle ready and downloaded.'); downloaded() }
      else setNotice(event.data.message ?? 'Could not build the download bundle.')
    }
    zipWorker.onerror = () => { zipWorker.terminate(); setBusy(false); setNotice('The ZIP worker stopped unexpectedly.') }
    zipWorker.postMessage({ rows, originalRows, rowOrderKey: dataset.rowOrderKey, columns: selectedColumns, format, report, recipe: exportRecipeJson(recipe), ruleByColumn, stepByColumn, suggestedName })
  }

  if (!dataset || !profile) return null
  return <section className="phase-five-panel" aria-label="Download and compare">
    <div className="segmented-control" role="tablist" aria-label="Download and compare"><button role="tab" aria-selected={tab === 'download'} className={tab === 'download' ? 'segment active' : 'segment'} onClick={() => setTab('download')}>Download</button><button role="tab" aria-selected={tab === 'compare'} className={tab === 'compare' ? 'segment active' : 'segment'} onClick={() => setTab('compare')}>What changed</button></div>
    {tab === 'download' ? <div className="phase-five-content"><div className="phase-five-head"><div><h2>Download cleaned data</h2><p>Export the current Cleaned view. Values stay on this device.</p></div><button className="browse-button" disabled={busy} onClick={() => void download()}>{busy ? 'Preparing…' : 'Download cleaned data'}</button></div>
      <div className="export-options"><label>Format<select disabled={busy} value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}><option value="csv">CSV</option><option value="xlsx">XLSX</option><option value="json">JSON{dataset.largeFileMode ? ' Lines' : ''}</option></select></label><label className="export-check"><input type="checkbox" disabled={busy} checked={includeAll} onChange={(event) => setIncludeAll(event.target.checked)} /> Include all columns</label><label className="export-check"><input type="checkbox" disabled={busy} checked={useOriginalNames} onChange={(event) => setUseOriginalNames(event.target.checked)} /> Use original column names</label>{format === 'csv' && <label className="export-check"><input type="checkbox" disabled={busy} checked={bom} onChange={(event) => setBom(event.target.checked)} /> Add UTF-8 BOM for Excel</label>}</div>
      {!includeAll && <><input className="export-search" disabled={busy} aria-label="Search export columns" placeholder="Search columns" value={columnSearch} onChange={(event) => setColumnSearch(event.target.value)} /><div className="export-column-list">{visibleColumns.slice(0, 80).map((column) => <label key={column.source}><input type="checkbox" disabled={busy} checked={selected.includes(column.source)} onChange={(event) => setSelected(event.target.checked ? [...new Set([...selected, column.source])] : selected.filter((name) => name !== column.source))} />{column.name}</label>)}{visibleColumns.length > 80 && <span>Showing the first 80 matches. Search to narrow the list.</span>}</div></>}
      {format === 'xlsx' && (dataset.largeFileMode || dataset.rowCount + 1 > 1_048_576) && <p className="warning-callout">XLSX has a 1,048,576-row worksheet limit and may use substantial memory. Choose CSV for this dataset.</p>}
      {dataset.largeFileMode && format === 'json' && <p className="note-callout">Large JSON exports use JSON Lines (.jsonl) and stream in DuckDB batches.</p>}
      {busy && <div className="export-progress"><div className="progress-track"><span style={{ width: `${progress.percent}%` }} /></div><span>{verifying ? 'Verifying' : streamKindRef.current === 'zip' ? 'Building download bundle' : 'Exporting'} · {progress.rows.toLocaleString()} / {progress.total.toLocaleString()} rows or changed cells</span><button className="secondary-button" disabled={verifying} onClick={cancel}>{verifying ? 'Verification running' : 'Cancel export'}</button></div>}
      {notice && <p role="status" className="export-notice">{notice}</p>}
      {(generated && rows || largeGenerated) && <button className="secondary-button" disabled={busy} onClick={verifyGenerated}>Verify download</button>}
      {verification && <div className={verification.pass ? 'verify-pass' : 'verify-fail'} role="status"><strong>{verification.pass ? 'Verification passed' : 'Verification failed'}</strong><span>{verification.rows.toLocaleString()} rows · {verification.columns} columns</span>{verification.mismatches.map((item) => <small key={item}>{item}</small>)}</div>}
      <div className="report-downloads"><button className="secondary-button" disabled={busy} onClick={() => void downloadAll()}>Download all (.zip)</button><button className="secondary-button" disabled={busy} onClick={() => makeReport('md')}>Download cleaning report (.md)</button><button className="secondary-button" disabled={busy} onClick={() => makeReport('html')}>Download printable report (.html)</button>{diff && <button className="secondary-button" disabled={busy} onClick={() => saveBlob(new Blob([serializeChangesCsv(diff)], { type: 'text/csv;charset=utf-8' }), `${basename(dataset.name)}_changes.csv`)}>{dataset.largeFileMode ? 'Download this page of changes CSV' : `Download changes CSV (${diff.length.toLocaleString()} cells)`}</button>}</div>
    </div> : <div className="phase-five-content"><div className="compare-summary"><h2>What changed</h2><div className="summary-cards"><Summary label="Rows" value={`${originalProfile?.summary.rows ?? dataset.rowCount} → ${profile.summary.rows}`} /><Summary label="Columns" value={`${originalProfile?.summary.columns ?? dataset.columnCount} → ${profile.summary.columns}`} /><Summary label="Cells changed" value={totals.cells.toLocaleString()} /><Summary label="Cells filled" value={filledCells.toLocaleString()} /><Summary label="Cells estimated" value={totals.estimated.toLocaleString()} /><Summary label="Rows removed" value={totals.rows.toLocaleString()} /><Summary label="Columns renamed" value={totals.renamed.toLocaleString()} /><Summary label="Cells flagged" value={totals.flagged.toLocaleString()} /></div><button className="secondary-button" disabled={diffBusy} onClick={runDiff}>{diffBusy ? 'Loading changed cells…' : dataset.largeFileMode ? 'Load changed cells from DuckDB' : 'Load changed cells'}</button>{dataset.largeFileMode && <small>Large-file comparison loads 1,000 changed cells at a time from local DuckDB.</small>}</div>{notice && <p role="status" className="export-notice">{notice}</p>}
      <div className="profile-filters"><input aria-label="Search changed columns" placeholder="Search columns" value={changeSearch} onChange={(event) => setChangeSearch(event.target.value)} /><select aria-label="Filter compare columns by type" value={columnTypeFilter} onChange={(event) => setColumnTypeFilter(event.target.value)}><option value="all">All types</option>{['integer', 'float', 'boolean', 'date', 'datetime', 'text', 'categorical'].map((type) => <option key={type}>{type}</option>)}</select><select aria-label="Filter compare columns by rule" value={columnRuleFilter} onChange={(event) => setColumnRuleFilter(event.target.value)}><option value="all">All rules</option>{ruleOptions.map((rule) => <option key={rule}>{rule}</option>)}</select><label className="export-check"><input type="checkbox" checked={changedOnly} onChange={(event) => setChangedOnly(event.target.checked)} /> Changed only</label><span>{colDiff.length.toLocaleString()} columns</span></div><div className="compare-table-wrap" onScroll={(event) => setColumnScroll(event.currentTarget.scrollTop)}><table className="compare-table"><thead><tr><th>Original → cleaned</th><th>Type</th><th>Nulls</th><th>Rules</th></tr></thead><tbody>{columnStart > 0 && <tr><td colSpan={4} style={{ height: columnStart * 36, padding: 0 }} /></tr>}{colDiff.slice(columnStart, columnStart + columnVisible).map((column) => <tr key={column.id} style={{ height: 36 }}><td>{column.original} → {column.cleaned}</td><td>{column.beforeType} → {column.afterType}</td><td>{column.beforeNulls.toLocaleString()} → {column.afterNulls.toLocaleString()}</td><td>{column.rules.join(', ') || '—'}</td></tr>)}{columnStart + columnVisible < colDiff.length && <tr><td colSpan={4} style={{ height: (colDiff.length - columnStart - columnVisible) * 36, padding: 0 }} /></tr>}</tbody></table></div>
      {diff && <><div className="profile-filters"><input aria-label="Filter changed cells" placeholder="Filter by column or rule" value={diffQuery} onChange={(event) => { setDiffQuery(event.target.value); setDiffScroll(0) }} /><span>{dataset.largeFileMode ? `Page ${Math.floor(diffOffset / 1000) + 1} · ` : ''}{visibleDiff.length.toLocaleString()} changed cells{dataset.largeFileMode ? ' on this page' : ''}</span>{dataset.largeFileMode && <><button className="secondary-button" disabled={diffOffset === 0 || diffBusy} onClick={() => loadDiffPage(Math.max(0, diffOffset - 1000))}>Previous page</button><button className="secondary-button" disabled={!diffHasMore || diffBusy} onClick={() => loadDiffPage(diffOffset + 1000)}>Next page</button></>}</div><div className="compare-table-wrap diff-virtual" onScroll={(event) => setDiffScroll(event.currentTarget.scrollTop)}><table className="compare-table"><thead><tr><th>Row</th><th>Column</th><th>Before</th><th>After</th><th>Rule</th></tr></thead><tbody>{diffStart > 0 && <tr><td colSpan={5} style={{ height: diffStart * 36, padding: 0 }} /></tr>}{visibleDiff.slice(diffStart, diffStart + changedRows).map((change, index) => <tr key={`${change.row_id}-${change.column}-${index}`}><td>{change.row_id}</td><td>{change.column}</td><td>{valueText(change.before)}</td><td>{valueText(change.after)}</td><td>{change.rule}</td></tr>)}{diffStart + changedRows < visibleDiff.length && <tr><td colSpan={5} style={{ height: (visibleDiff.length - diffStart - changedRows) * 36, padding: 0 }} /></tr>}</tbody></table></div></>}
      {activeSteps.some((step) => step.rowsRemoved > 0) && <details><summary>Removed rows ({totals.rows.toLocaleString()})</summary>{dataset.largeFileMode ? <><p>Rows are streamed from the immutable DuckDB original with the first removal rule recorded per row.</p><button className="secondary-button" disabled={busy} onClick={() => void downloadRemovedRows()}>{busy ? 'Preparing removed rows…' : 'Download removed rows CSV'}</button>{busy && <div className="export-progress"><div className="progress-track"><span style={{ width: `${progress.percent}%` }} /></div><span>{progress.rows.toLocaleString()} / {progress.total.toLocaleString()} removed rows</span><button className="secondary-button" onClick={cancel}>Cancel export</button></div>}</> : <><p>Removed source rows are retained separately with their removing rule.</p><button className="secondary-button" disabled={busy} onClick={() => void downloadRemovedRows()}>{busy ? 'Preparing removed rows…' : 'Download removed rows CSV'}</button>{busy && <div className="export-progress"><span>Building the removed-row CSV in a worker…</span><button className="secondary-button" onClick={cancel}>Cancel export</button></div>}</>}</details>}
    </div>}
  </section>
}

function Summary({ label, value }: { label: string; value: string }) { return <article className="summary-card"><p>{label}</p><strong>{value}</strong></article> }
