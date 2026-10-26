import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type UIEvent } from 'react'
import { useDatasetStore } from '../../store/datasetStore'
import { createRecipe, LOW_RISK_RULES, RISKY_RULES, matchRecipe } from '../../engine/smartClean'
import { countRemainingDecisions, countSelectedColumns, selectFillColumnsByType } from '../../engine/reviewMetrics'
import { exportRecipeJson, importRecipeJson, saveRecipe } from '../../recipes/recipeStore'
import { Skeleton } from '../ui'
import PhaseFivePanel from '../export/PhaseFivePanel'
import type { ImputationRecommendation } from '../../engine/localImputation'
import type { ChangeStep, CleaningGroup, CleaningRule, ColumnProfile, DataFormat, DataRow, Dataset, PlannedRule, ProfileResult, RecipeMatchReport, RiskyDecision, RiskyDryRun, SmartCleanResult } from '../../types'

type ParseState = 'idle' | 'parsing' | 'workbook' | 'done' | 'error'
interface WorkbookPreviewRow { row: number; values: string[] }
interface WorkerMessage {
  type: string
  format?: DataFormat
  largeFileMode?: boolean
  sizeBytes?: number
  sheets?: string[]
  sheet?: string
  headerRow?: number
  previewRows?: WorkbookPreviewRow[]
  rowsProcessed?: number
  estimatedSecondsRemaining?: number | null
  percent?: number
  totalRows?: number
  stage?: string
  message?: string
  columns?: string[]
  rowCount?: number
  rows?: DataRow[]
  preview?: DataRow[]
  profile?: ProfileResult
  raggedRows?: number
  delimiter?: string
  encoding?: string
  excelDateRows?: Record<string, number[]>
  note?: string
  groups?: CleaningGroup[]
  changeLog?: SmartCleanResult['changeLog']
  proposed?: PlannedRule[]
  protectedColumns?: string[]
  completed?: number
  total?: number
  rule?: string
  result?: RiskyDryRun
  decision?: RiskyDecision
  changeStep?: ChangeStep
  cursor?: number
  requestId?: string
  sampleRows?: number
  results?: ImputationRecommendation[]
  rowOrderKey?: string
}

const ACCEPTED = new Set(['csv', 'tsv', 'xlsx', 'xls', 'json'])
const LARGE_FILE_BYTES = 50 * 1024 * 1024
const VERY_LARGE_FILE_BYTES = 500 * 1024 * 1024
const formatBytes = (bytes: number): string => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
const formatEta = (seconds: number | null | undefined): string => {
  if (seconds == null) return 'Estimating remaining time…'
  if (seconds < 60) return `About ${seconds} sec remaining`
  return `About ${Math.ceil(seconds / 60)} min remaining`
}

function VirtualPreview({ rows, columns, originalRows, originalNameByCurrentName, uncertaintyByCell }: { rows: DataRow[]; columns: string[]; originalRows: DataRow[]; originalNameByCurrentName: Record<string, string>; uncertaintyByCell: Record<string, { value: number; kind: 'numeric' | 'categorical' }> }) {
  const [scrollTop, setScrollTop] = useState(0)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [height, setHeight] = useState(360)
  const rowHeight = 36
  const visibleCount = Math.ceil(height / rowHeight) + 8
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 4)
  const visible = rows.slice(start, start + visibleCount)
  const colWidth = 150
  const colStart = Math.max(0, Math.floor(scrollLeft / colWidth) - 2)
  const visibleColumns = columns.slice(colStart, colStart + Math.ceil(900 / colWidth) + 5)
  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop)
    setScrollLeft(event.currentTarget.scrollLeft)
    setHeight(event.currentTarget.clientHeight)
  }
  return <div className="preview-scroll" role="region" aria-label="Data preview" tabIndex={0} onScroll={handleScroll}>
    <table className="preview-table">
      <thead><tr><th className="row-number">#</th>{colStart > 0 && <th aria-hidden="true" style={{ width: colStart * colWidth, padding: 0, border: 0 }} />}{visibleColumns.map((column) => <th key={column}>{column}</th>)}{colStart + visibleColumns.length < columns.length && <th aria-hidden="true" style={{ width: (columns.length - colStart - visibleColumns.length) * colWidth, padding: 0, border: 0 }} />}</tr></thead>
      <tbody>
        {start > 0 && <tr aria-hidden="true"><td colSpan={visibleColumns.length + 3} style={{ height: start * rowHeight, padding: 0, border: 0 }} /></tr>}
        {visible.map((row, index) => <tr key={start + index}><td className="row-number">{start + index + 1}</td>{colStart > 0 && <td aria-hidden="true" style={{ width: colStart * colWidth, padding: 0, border: 0 }} />}{visibleColumns.map((column) => { const original = originalRows[start + index]?.[originalNameByCurrentName[column] ?? column]; const changed = originalRows.length > 0 && original !== row[column]; const uncertainty = uncertaintyByCell[`${start + index}:${column}`]; const uncertaintyText = uncertainty?.kind === 'categorical' ? `Class uncertainty ${Math.round(uncertainty.value * 100)}%` : uncertainty ? `Estimate error range ±${uncertainty.value.toFixed(3)}` : ''; const title = [changed ? `Original: ${original == null ? 'empty' : String(original)}` : '', uncertaintyText].filter(Boolean).join(' · '); return <td key={column} className={uncertainty === undefined ? undefined : 'estimated-cell'} title={title || undefined}>{row[column] == null || row[column] === '' ? <span className="null-cell">empty</span> : String(row[column])}</td> })}{colStart + visibleColumns.length < columns.length && <td aria-hidden="true" style={{ width: (columns.length - colStart - visibleColumns.length) * colWidth, padding: 0, border: 0 }} />}</tr>)}
        {start + visibleCount < rows.length && <tr aria-hidden="true"><td colSpan={visibleColumns.length + 3} style={{ height: Math.max(0, (rows.length - start - visibleCount) * rowHeight), padding: 0, border: 0 }} /></tr>}
      </tbody>
    </table>
  </div>
}

function ProfileTable({ columns }: { columns: ColumnProfile[] }) {
  const [scrollTop, setScrollTop] = useState(0)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [issueFilter, setIssueFilter] = useState('all')
  const [nullFilter, setNullFilter] = useState('all')
  const rowHeight = 66
  const visibleCount = 11
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 2)
  const [sortKey, setSortKey] = useState<keyof ColumnProfile>('nullPercent')
  const [ascending, setAscending] = useState(false)
  const sorted = useMemo(() => columns.filter((column) => column.name.toLowerCase().includes(search.toLowerCase()) && (typeFilter === 'all' || column.inferredType === typeFilter) && (issueFilter === 'all' || column.issues.some((issue) => issue.code === issueFilter)) && (nullFilter === 'all' || (nullFilter === 'any' ? column.nullPercent > 0 : nullFilter === 'high' ? column.nullPercent >= 50 : column.nullPercent === 0))).sort((a, b) => {
    const left = a[sortKey]
    const right = b[sortKey]
    const comparison = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right))
    return ascending ? comparison : -comparison
  }), [columns, sortKey, ascending, search, typeFilter, issueFilter, nullFilter])
  const sortButton = (label: string, key: keyof ColumnProfile) => <button className="sort-button" onClick={() => { if (sortKey === key) setAscending(!ascending); else { setSortKey(key); setAscending(true) } }} aria-label={`Sort by ${label}`}>{label}{sortKey === key ? ascending ? ' ↑' : ' ↓' : ''}</button>
  return <><div className="profile-filters"><input aria-label="Search columns" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search columns" /><select aria-label="Filter by type" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="all">All types</option>{['integer', 'float', 'boolean', 'date', 'datetime', 'text', 'categorical'].map((type) => <option key={type}>{type}</option>)}</select><select aria-label="Filter by issue" value={issueFilter} onChange={(event) => setIssueFilter(event.target.value)}><option value="all">All issues</option>{[...new Set(columns.flatMap((column) => column.issues.map((issue) => issue.code)))].map((issue) => <option key={issue}>{issue}</option>)}</select><select aria-label="Filter by null percentage" value={nullFilter} onChange={(event) => setNullFilter(event.target.value)}><option value="all">Any null rate</option><option value="zero">No nulls</option><option value="any">Has nulls</option><option value="high">50%+ nulls</option></select><span>{sorted.length.toLocaleString()} shown</span></div><div className="profile-table-wrap profile-virtual" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}><table className="profile-table"><thead><tr><th>{sortButton('Column', 'name')}</th><th>{sortButton('Type', 'inferredType')}</th><th>{sortButton('Nulls', 'nullPercent')}</th><th>{sortButton('Unique', 'uniqueCount')}</th><th>{sortButton('Issues', 'issues')}</th><th>Range / average</th></tr></thead><tbody>
    {start > 0 && <tr aria-hidden="true"><td colSpan={6} style={{ height: start * rowHeight, padding: 0, border: 0 }} /></tr>}
    {sorted.slice(start, start + visibleCount).map((column) => <tr key={column.name} title={`Median: ${column.median ?? '—'} · Top values: ${column.topValues.map((item) => `${item.value} (${item.count})`).join(', ')}`}>
      <th scope="row"><span className="column-name">{column.name}</span></th>
      <td><span className={`type-chip type-${column.inferredType}`}>{column.inferredType}</span></td>
      <td><div className="null-cell-stat"><span>{column.nullCount.toLocaleString()} <small>({column.nullPercent.toFixed(1)}%)</small></span><span className="null-bar"><span style={{ width: `${Math.min(column.nullPercent, 100)}%` }} /></span></div></td>
      <td>{column.uniqueCount.toLocaleString()}<small className="table-substat">{column.duplicateValueCount.toLocaleString()} repeated</small></td>
      <td><div className="issue-badges">{column.issues.length ? column.issues.slice(0, 2).map((issue) => <span key={issue.code} className={`issue-pill issue-${issue.severity}`} title={issue.message}>{issue.count ?? 0} {issue.code.replaceAll('-', ' ')}</span>) : <span className="ok-pill">Clear</span>}{column.issues.length > 2 && <span className="issue-more">+{column.issues.length - 2}</span>}</div></td>
      <td className="range-stat">{column.min == null ? '—' : `${column.min} – ${column.max}`}<small>{column.mean == null ? '' : `Mean ${column.mean.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}</small></td>
    </tr>)}
    {start + visibleCount < sorted.length && <tr aria-hidden="true"><td colSpan={6} style={{ height: (sorted.length - start - visibleCount) * rowHeight, padding: 0, border: 0 }} /></tr>}
  </tbody></table></div></>
}

export default function DataWorkspace() {
  const inputRef = useRef<HTMLInputElement>(null)
  const workerRef = useRef<Worker | null>(null)
  const { dataset, profile, previewRows, rows, originalPreviewRows, originalProfile, protectedColumns, cleanResult, cleanProgress, setParsedDataset, setProtectedColumns, setCleanProgress, setCleanResult, clear } = useDatasetStore()
  const store = useDatasetStore()
  const [state, setState] = useState<ParseState>('idle')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<{ percent: number; rows: number; eta: number | null; stage: string; totalRows?: number }>({ percent: 0, rows: 0, eta: null, stage: 'Reading file' })
  const [sheets, setSheets] = useState<string[]>([])
  const [sheet, setSheet] = useState('')
  const [headerRow, setHeaderRow] = useState(1)
  const [sheetPreview, setSheetPreview] = useState<WorkbookPreviewRow[]>([])
  const [raggedRows, setRaggedRows] = useState(0)
  const [encoding, setEncoding] = useState('')
  const [delimiter, setDelimiter] = useState('')
  const [note, setNote] = useState('')
  const [protectSearch, setProtectSearch] = useState('')
  const [reviewQuery, setReviewQuery] = useState('')
  const [busyClean, setBusyClean] = useState(false)
  const [showProposals, setShowProposals] = useState(false)
  const [recipeRules, setRecipeRules] = useState<CleaningRule[] | null>(null)
  const [recipeReport, setRecipeReport] = useState<RecipeMatchReport | null>(null)
  const [selectedReviewColumns, setSelectedReviewColumns] = useState<string[]>([])
  const [excludedColumns, setExcludedColumns] = useState<string[]>([])
  const [decisionDialog, setDecisionDialog] = useState<'customize' | 'confirm' | null>(null)
  const [activeProposal, setActiveProposal] = useState<PlannedRule | null>(null)
  const [decisionDraft, setDecisionDraft] = useState<RiskyDecision | null>(null)
  const [dryRunResult, setDryRunResult] = useState<RiskyDryRun | null>(null)
  const [decisionError, setDecisionError] = useState('')
  const [excludeDraft, setExcludeDraft] = useState('')
  const [previewMode, setPreviewMode] = useState<'original' | 'cleaned'>('original')
  const [maxMissingPercent, setMaxMissingPercent] = useState(15)
  const [cleanedDownloadComplete, setCleanedDownloadComplete] = useState(false)
  const [imputationRecommendations, setImputationRecommendations] = useState<ImputationRecommendation[] | null>(null)
  const [imputationPending, setImputationPending] = useState(false)
  const [imputationSampleRows, setImputationSampleRows] = useState(0)
  const imputationRequestRef = useRef('')

  useEffect(() => {
    const hasUndownloadedChanges = cleanResult !== null && store.changeSteps.some((step) => !step.undone) && !cleanedDownloadComplete
    if (!hasUndownloadedChanges) return
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warnBeforeLeaving)
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving)
  }, [cleanResult, store.changeSteps, cleanedDownloadComplete])

  const requestWorkerCancellation = () => {
    try { workerRef.current?.postMessage({ type: 'cancel' }) }
    catch { workerRef.current?.terminate() }
    workerRef.current = null
  }

  const reset = () => {
    requestWorkerCancellation()
    clear()
    setFile(null); setError(''); setState('idle'); setProgress({ percent: 0, rows: 0, eta: null, stage: 'Reading file' })
    setSheets([]); setSheet(''); setHeaderRow(1); setSheetPreview([]); setRaggedRows(0); setEncoding(''); setDelimiter(''); setNote('')
    setRecipeRules(null); setRecipeReport(null); setExcludedColumns([]); setSelectedReviewColumns([]); setProtectSearch(''); setReviewQuery(''); setShowProposals(false); setBusyClean(false); setCleanedDownloadComplete(false)
    setDecisionDialog(null); setActiveProposal(null); setDecisionDraft(null); setDryRunResult(null); setDecisionError(''); setExcludeDraft('')
    setImputationRecommendations(null); setImputationPending(false); setImputationSampleRows(0); imputationRequestRef.current = ''
    if (inputRef.current) inputRef.current.value = ''
  }

  const startFile = (selected: File) => {
    const extension = selected.name.split('.').at(-1)?.toLowerCase() ?? ''
    if (!ACCEPTED.has(extension)) { setError('Choose a CSV, TSV, XLSX, XLS, or JSON file.'); setState('error'); return }
    requestWorkerCancellation()
    clear()
    setImputationRecommendations(null); setImputationPending(false); setImputationSampleRows(0); imputationRequestRef.current = ''
    setFile(selected); setError(''); setState('parsing'); setProgress({ percent: 2, rows: 0, eta: null, stage: 'Reading file' })
    let worker: Worker
    try { worker = new Worker(new URL('../../workers/parse.worker.ts', import.meta.url), { type: 'module', name: 'datacleaner-parser' }) }
    catch {
      setError('Your browser could not start local file processing. Try reloading the page or using a current browser.')
      setState('error')
      return
    }
    workerRef.current = worker
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data
      if (message.type === 'cancelled') { worker.terminate(); return }
      if (message.type === 'operation-cancelled') { setBusyClean(false); setDecisionError('Operation cancelled. No changes were applied.'); return }
      if (workerRef.current !== worker) return
      if (message.type === 'started') {
        if (message.largeFileMode) setProgress({ percent: 1, rows: 0, eta: null, stage: 'Starting large file mode' })
        else setProgress({ percent: 5, rows: 0, eta: null, stage: 'Parsing in a private browser worker' })
      }
      if (message.type === 'progress' || message.type === 'operation-progress') setProgress({ percent: message.percent ?? 0, rows: message.rowsProcessed ?? 0, totalRows: message.totalRows, eta: message.estimatedSecondsRemaining ?? null, stage: message.type === 'operation-progress' ? (message.stage ?? 'Applying review decision').replaceAll('-', ' ') : message.stage === 'profiling' ? 'Profiling columns' : 'Reading and loading data' })
      if (message.type === 'clean-progress') setCleanProgress({ completed: message.completed ?? 0, total: message.total ?? 0, rule: message.rule ?? '' })
      if (message.type === 'clean-complete' && message.profile && message.rowCount !== undefined) {
        setPreviewMode('cleaned')
        const next: SmartCleanResult = { rows: message.rows ?? [], groups: message.groups ?? [], proposed: message.proposed ?? [], protectedColumns: message.protectedColumns ?? protectedColumns, changeLog: message.changeLog ?? [] }
        const currentDataset = useDatasetStore.getState().dataset
        if (currentDataset) setParsedDataset({ ...currentDataset, rowCount: message.rowCount, columnCount: message.columns?.length ?? message.profile.summary.columns }, message.profile, message.preview ?? [], message.rows?.length ? message.rows : null)
        setCleanResult(next); setBusyClean(false)
      }
      if (message.type === 'risky-dry-run' && message.result) { setDryRunResult(message.result); setDecisionDraft(message.result.decision); setDecisionDialog('confirm'); setBusyClean(false) }
      if (message.type === 'risky-applied' && message.profile && message.changeStep && (message.rows || useDatasetStore.getState().dataset?.largeFileMode)) {
        setPreviewMode('cleaned')
        const currentDataset = useDatasetStore.getState().dataset
        const appliedRows = message.rows ?? []
        if (currentDataset) setParsedDataset({ ...currentDataset, rowCount: message.rowCount ?? appliedRows.length }, message.profile, message.preview ?? [], currentDataset.largeFileMode ? null : appliedRows)
        store.applyDecision(appliedRows, message.profile, message.changeStep, message.preview ?? [])
        if (message.decision) store.setDecisionState(message.decision.kind, 'accepted')
        setDecisionDialog(null); setDryRunResult(null); setDecisionError(''); setBusyClean(false)
      }
      if (message.type === 'risky-failed') { setDecisionError(message.message ?? 'The review action could not be completed.'); setDecisionDialog(null); setBusyClean(false) }
      if (message.type === 'imputation-recommendations' && message.requestId === imputationRequestRef.current) { setImputationRecommendations(message.results ?? []); setImputationSampleRows(message.sampleRows ?? 0); setImputationPending(false) }
      if (message.type === 'imputation-recommendation-failed' && message.requestId === imputationRequestRef.current) { setDecisionError(message.message ?? 'Local estimates could not be evaluated.'); setImputationPending(false) }
      if (message.type === 'history-moved' && message.profile && message.rowCount !== undefined) {
        const currentDataset = useDatasetStore.getState().dataset
        if (currentDataset) setParsedDataset({ ...currentDataset, rowCount: message.rowCount, columnCount: message.columns?.length ?? message.profile.summary.columns }, message.profile, message.preview ?? [], null)
        store.setLargeHistoryCursor(message.cursor ?? 0)
        setBusyClean(false)
      }
      if (message.type === 'workbook-inspected') {
        setSheets(message.sheets ?? []); setSheet(message.sheet ?? ''); setHeaderRow(message.headerRow ?? 1); setSheetPreview(message.previewRows ?? []); setState('workbook')
      }
      if (message.type === 'failed') { setError(message.message ?? 'We could not read this file.'); setState('error'); setBusyClean(false) }
      if (message.type === 'complete' && message.profile && message.format && message.rowCount !== undefined) {
        const detectedFormat = message.format
        const newDataset: Dataset = { id: crypto.randomUUID(), name: selected.name, format: detectedFormat, sizeBytes: selected.size, rowCount: message.rowCount, columnCount: message.columns?.length ?? message.profile.summary.columns, createdAt: new Date().toISOString(), largeFileMode: message.largeFileMode ?? false, rowOrderKey: message.rowOrderKey, note: message.note, ...(message.excelDateRows ? { excelDateRows: message.excelDateRows } : {}) }
        setParsedDataset(newDataset, message.profile, message.preview ?? [], message.rows ?? null)
        setRaggedRows(message.raggedRows ?? 0); setEncoding(message.encoding ?? ''); setDelimiter(message.delimiter === '\t' ? 'Tab' : message.delimiter ?? ''); setNote(message.note ?? '')
        setProgress({ percent: 100, rows: message.rowCount, eta: 0, stage: 'Complete' }); setState('done')
      }
    }
    worker.onerror = (event) => {
      event.preventDefault()
      requestWorkerCancellation()
      setError(/memory|allocation|wasm/i.test(event.message) ? 'This file needs more memory than the browser can provide. Close other tabs, split the file, or try CSV instead of XLSX.' : 'The parser stopped unexpectedly. Your original file is unchanged. Try again, or split the file into smaller parts.')
      setState('error')
      setBusyClean(false)
    }
    worker.postMessage({ type: 'parse', file: selected })
  }

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => { const selected = event.currentTarget.files?.[0]; if (selected) startFile(selected) }
  const dropFile = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); const selected = event.dataTransfer.files[0]; if (selected) startFile(selected) }
  const continueWorkbook = () => { setState('parsing'); setProgress({ percent: 40, rows: 0, eta: null, stage: 'Parsing selected worksheet' }); workerRef.current?.postMessage({ type: 'continue-xlsx', sheet, headerRow }) }
  const startSmartClean = () => {
    if (!profile || !workerRef.current) return
    setCleanedDownloadComplete(false)
    setBusyClean(true); setCleanProgress({ completed: 0, total: 7, rule: 'Starting Smart Clean' })
    const baseRules = recipeRules ?? [...LOW_RISK_RULES, ...RISKY_RULES]
    const rules = baseRules.map((rule) => ({ ...rule, options: rule.kind === 'fill-missing' ? { ...rule.options, maxMissingPercent } : rule.options, scope: { ...rule.scope, exclude: [...new Set([...(rule.scope.exclude ?? []), ...excludedColumns])] } }))
    workerRef.current.postMessage({ type: 'smart-clean', profile, protectedColumns, rules, ...(rows ? { rows } : {}), ...(dataset?.excelDateRows ? { excelDateRows: dataset.excelDateRows } : {}) })
  }
  const defaultDecision = (proposal: PlannedRule): RiskyDecision => {
    const kind = proposal.rule.kind === 'merge-categories' ? 'standardize-categories' : proposal.rule.kind as RiskyDecision['kind']
    const categoryValues = proposal.columns.flatMap((name) => profile?.columns.find((column) => column.name === name)?.topValues ?? []).filter((item) => typeof item.value === 'string')
    const variants = new Map<string, Map<string, number>>()
    for (const item of categoryValues) {
      const value = String(item.value)
      const key = value.trim().toLocaleLowerCase()
      const counts = variants.get(key) ?? new Map<string, number>()
      counts.set(value.trim(), (counts.get(value.trim()) ?? 0) + item.count)
      variants.set(key, counts)
    }
    const suggestedMapping: Record<string, string> = {}
    for (const counts of variants.values()) {
      const canonical = [...counts.entries()].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))[0]?.[0]
      if (canonical) for (const variant of counts.keys()) if (variant !== canonical) suggestedMapping[variant] = canonical
    }
    const options: RiskyDecision['options'] = kind === 'remove-duplicates' ? { keep: 'first', keys: [] }
      : kind === 'fill-missing' ? { strategy: 'leave-null', value: '', applyToAll: true, addWasMissingIndicator: false }
        : kind === 'handle-outliers' ? { action: 'flag' }
          : kind === 'resolve-validation' ? { action: 'leave' }
          : kind === 'standardize-categories' ? { mapping: JSON.stringify(suggestedMapping, null, 2) }
            : kind === 'swap-excel-date-components' ? { rowSignatures: (() => { try { return JSON.parse(String(proposal.rule.options.rowSignatures ?? '[]')) as string[] } catch { return [] } })(), evidence: String(proposal.rule.options.evidence ?? '') }
              : { order: 'day-first' }
    return { kind, columns: proposal.columns, columnIds: proposal.columnIds, options }
  }
  const startRiskyDecision = (proposal: PlannedRule, customize: boolean) => {
    setCleanedDownloadComplete(false)
    setImputationRecommendations(null)
    const decision = defaultDecision(proposal)
    setActiveProposal(proposal); setDecisionDraft(decision); setDryRunResult(null); setDecisionError('')
    setExcludeDraft('')
    if (customize) { setDecisionDialog('customize'); return }
    requestDryRun(decision)
  }
  const startDeferredFillDecision = (proposal: PlannedRule) => {
    const columns = proposal.deferredColumns ?? []
    const ids = new Map(profile?.columns.map((column) => [column.name, column.id]) ?? [])
    startRiskyDecision({ ...proposal, columns, columnIds: columns.map((name) => ids.get(name) ?? `column:${name}`), deferredColumns: [] }, true)
  }
  const requestDryRun = (decision: RiskyDecision) => {
    if (!workerRef.current || (!rows && !dataset?.largeFileMode)) { setDecisionError('This dataset is no longer available in the local worker. Upload it again before reviewing.'); return }
    setDecisionDraft(decision); setDecisionDialog(null); setBusyClean(true)
    workerRef.current.postMessage({ type: 'dry-run-risky', decision, ...(rows ? { rows } : {}), profile: profile!, protectedColumns })
  }
  const moveHistory = (action: 'undo' | 'redo' | 'reset') => {
    if (!workerRef.current || !dataset?.largeFileMode) return
    setBusyClean(true)
    workerRef.current.postMessage({ type: 'history', action })
  }
  const confirmRiskyDecision = () => {
    if (!workerRef.current || !decisionDraft || (!rows && !dataset?.largeFileMode)) return
    setBusyClean(true)
    workerRef.current.postMessage({ type: 'apply-risky', decision: decisionDraft, ...(rows ? { rows } : {}), profile: profile!, protectedColumns })
  }
  const setDecisionOption = (key: string, value: string | number | boolean | string[]) => setDecisionDraft((current) => current ? { ...current, options: { ...current.options, [key]: value } } : current)
  const requestImputationRecommendations = () => {
    if (!workerRef.current || decisionDraft?.kind !== 'fill-missing' || !profile) return
    const requestId = crypto.randomUUID(); imputationRequestRef.current = requestId
    setImputationRecommendations(null); setImputationPending(true); setDecisionError('')
    const featureColumns = profile.columns.filter((column) => ['integer', 'float', 'boolean', 'categorical'].includes(column.inferredType) && !protectedColumns.includes(column.name) && !column.issues.some((issue) => issue.code === 'identifier-column')).map((column) => column.name)
    const missingPercentByColumn = Object.fromEntries(decisionDraft.columns.map((name) => [name, profile.columns.find((column) => column.name === name)?.nullPercent ?? 0]))
    const targetTypes = Object.fromEntries(decisionDraft.columns.map((name) => [name, profile.columns.find((column) => column.name === name)?.inferredType ?? 'text']))
    workerRef.current.postMessage({ type: 'recommend-imputation', requestId, columns: decisionDraft.columns, featureColumns, seed: 20261025, maxTrainingRows: dataset?.largeFileMode ? 5_000 : 20_000, missingPercentByColumn, targetTypes, ...(rows ? { rows } : {}) })
  }
  const previewRecommendedEstimates = (item: ImputationRecommendation) => {
    const column = profile?.columns.find((candidate) => candidate.name === item.column)
    const largeFile = dataset?.largeFileMode === true
    if (!decisionDraft || !column || !item.recommended || (!largeFile && ((dataset?.rowCount ?? 0) > 5_000 || item.estimates.length !== column.nullCount))) return
    const estimates = largeFile ? undefined : JSON.stringify({ [item.column]: item.estimates.map((estimate) => ({ rowIndex: estimate.sampleRow - 1, value: estimate.value, uncertainty: estimate.uncertainty })) })
    const featureColumns = profile?.columns.filter((candidate) => ['integer', 'float', 'boolean', 'categorical'].includes(candidate.inferredType) && !protectedColumns.includes(candidate.name) && !candidate.issues.some((issue) => issue.code === 'identifier-column')).map((candidate) => candidate.name).slice(0, 16) ?? []
    const targetIndex = Math.max(0, decisionDraft.columns.indexOf(item.column))
    const seed = 20261025 + targetIndex * 997
    setCleanedDownloadComplete(false)
    requestDryRun({
      ...decisionDraft,
      columns: [item.column],
      columnIds: [column.id],
      options: { ...decisionDraft.options, strategy: 'model-estimates', ...(estimates ? { estimatedValues: estimates } : {}), featureColumns, seed, maxTrainingRows: dataset?.largeFileMode ? 5_000 : 20_000, model: item.validation?.model ?? 'weighted-knn', validation: JSON.stringify(item.validation ?? {}), targetType: column.inferredType, nonNegative: /(?:quantity|price|revenue|age|count)/i.test(column.name) },
    })
  }
  const updateDecisionColumns = (value: string) => setDecisionDraft((current) => current ? (() => { const columns = value.split(',').map((name) => name.trim()).filter((name) => name && !protectedColumns.includes(name)); const ids = new Map(profile?.columns.map((column) => [column.name, column.id]) ?? []); return { ...current, columns, columnIds: columns.map((name) => ids.get(name)).filter((id): id is string => Boolean(id)) } })() : current)
  const prepareDecisionPreview = () => {
    if (!decisionDraft || !activeProposal) return
    if (decisionDraft.kind === 'fill-missing' && decisionDraft.options.strategy === 'forward-fill' && decisionDraft.options.orderedRows !== true) {
      setDecisionError('Confirm that this file is ordered by time or sequence before forward fill.')
      return
    }
    const excluded = excludeDraft.split(',').map((name) => name.trim()).filter(Boolean)
    const selected = decisionDraft.options.applyToAll === false ? decisionDraft.columns : activeProposal.columns.filter((name) => !excluded.includes(name))
    const idsByName = new Map(activeProposal.columns.map((name, index) => [name, activeProposal.columnIds[index]]))
    requestDryRun({ ...decisionDraft, columns: selected, columnIds: selected.map((name) => idsByName.get(name)).filter((id): id is string => Boolean(id)) })
  }
  const applyNumericFillScope = () => {
    if (!activeProposal || !profile) return
    const columns = selectFillColumnsByType(profile.columns, activeProposal.columns, ['integer', 'float'], protectedColumns)
    const idsByName = new Map(profile.columns.map((column) => [column.name, column.id]))
    setDecisionDraft((current) => current ? { ...current, columns, columnIds: columns.map((name) => idsByName.get(name)).filter((id): id is string => Boolean(id)), options: { ...current.options, applyToAll: false } } : current)
  }
  const toggleProtected = (name: string) => setProtectedColumns(protectedColumns.includes(name) ? protectedColumns.filter((item) => item !== name) : [...protectedColumns, name])
  const exportCurrentRecipe = () => {
    if (!profile) return
    const recipe = createRecipe(`${dataset?.name ?? 'DataCleaner'} Smart Clean`, (recipeRules ?? [...LOW_RISK_RULES, ...RISKY_RULES]).map((rule) => ({ ...rule, scope: { ...rule.scope, exclude: [...new Set([...(rule.scope.exclude ?? []), ...excludedColumns])] } })), protectedColumns, profile.columns)
    void saveRecipe(recipe)
    const url = URL.createObjectURL(new Blob([exportRecipeJson(recipe)], { type: 'application/json' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${recipe.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`; anchor.click(); URL.revokeObjectURL(url)
  }
  const extension = file?.name.split('.').at(-1)?.toLowerCase()
  const isSpreadsheet = extension === 'xlsx' || extension === 'xls'
  const previewIsCleaned = Boolean(cleanResult && previewMode === 'cleaned')
  const displayedPreviewRows = previewIsCleaned ? previewRows : originalPreviewRows
  const displayedPreviewColumns = previewIsCleaned ? profile?.columns.map((column) => column.name) ?? [] : originalProfile?.columns.map((column) => column.name) ?? []
  const originalNameByCurrentName = Object.fromEntries((profile?.columns ?? []).map((column) => [column.name, originalProfile?.columns.find((original) => original.id === column.id)?.name ?? column.name]))
  const estimateUncertaintyByCell = Object.fromEntries(store.changeSteps.filter((step) => !step.undone).flatMap((step) => Object.entries(step.estimateUncertaintyByColumn ?? {}).flatMap(([column, values]) => Object.entries(values).map(([row, uncertainty]) => [`${row}:${column}`, uncertainty]))))
  const numericFillColumns = activeProposal?.rule.kind === 'fill-missing' && profile
    ? selectFillColumnsByType(profile.columns, activeProposal.columns, ['integer', 'float'], protectedColumns)
    : []
  const unresolvedCount = cleanResult ? countRemainingDecisions(cleanResult.proposed, store.decisionStates) : 0
  const selectedColumnCount = countSelectedColumns(selectedReviewColumns, profile?.columns.length ?? 0)

  return <section className="data-workspace">
    {state === 'idle' || state === 'error' ? <>
      <div className="eyebrow"><span className="status-dot" /> PRIVATE DATA WORKSPACE</div>
      <h1>Make messy data<br /><span>make sense.</span></h1>
      <p className="welcome-copy">A clear, calm space to prepare your data. Start with a file and take it from there.</p>
      <div className={`drop-card ${state === 'error' ? 'drop-error' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={dropFile}>
        <input ref={inputRef} className="visually-hidden" type="file" accept=".csv,.tsv,.xlsx,.xls,.json" onChange={chooseFile} aria-label="Choose a data file" />
        <div className="upload-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15.5v3A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg></div>
        <h2>{state === 'error' ? 'That file could not be opened' : 'Drop your file here'}</h2>
        <p>CSV, TSV, Excel, or JSON</p>
        <button className="browse-button" onClick={() => inputRef.current?.click()}>Choose a file</button>
        <span className="size-hint">Any size. KB to hundreds of MB.</span>
        {state === 'error' && <div className="error-message" role="alert">{error}</div>}
      </div>
      <div className="format-list"><span>CSV</span><i /><span>TSV</span><i /><span>XLSX</span><i /><span>XLS</span><i /><span>JSON</span></div>
    </> : null}

    {(state === 'parsing' || state === 'workbook') && file ? <div className="parsing-card" aria-live="polite">
      <div className="parsing-heading"><div className="upload-icon small-upload-icon"><span className="spinner" /></div><div><p className="eyebrow">{state === 'workbook' ? 'WORKSHEET OPTIONS' : 'WORKING LOCALLY'}</p><h1>{state === 'workbook' ? 'Choose what to parse' : 'Getting to know your data'}</h1></div></div>
      <div className="selected-file"><span className="file-symbol">▤</span><div><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></div></div>
      {file.size >= VERY_LARGE_FILE_BYTES && <div className="warning-callout" role="status"><strong>Very large file.</strong> Performance depends on your device’s available memory. You can continue; no size limit is enforced.</div>}
      {isSpreadsheet && file.size >= LARGE_FILE_BYTES && <div className="warning-callout" role="status"><strong>Excel files are not streamable.</strong> This workbook may use significant memory on a large file.</div>}
      {state === 'workbook' ? <div className="workbook-options">
        <label>Worksheet<select value={sheet} onChange={(event) => { const nextSheet = event.target.value; setSheet(nextSheet); workerRef.current?.postMessage({ type: 'inspect-xlsx-sheet', sheet: nextSheet }) }}>{sheets.map((name) => <option key={name}>{name}</option>)}</select></label>
        <label>Header row<select value={headerRow} onChange={(event) => setHeaderRow(Number(event.target.value))}>{sheetPreview.map((row) => <option key={row.row} value={row.row}>Row {row.row}{row.values.filter(Boolean).length ? `: ${row.values.filter(Boolean).slice(0, 4).join(', ')}` : ' (empty)'}</option>)}</select></label>
        <p>Merged cells use the value in their top-left cell. Empty leading rows are skipped automatically.</p>
        <button className="browse-button" onClick={continueWorkbook}>Parse worksheet</button>
      </div> : <>
        {file.size >= LARGE_FILE_BYTES && !isSpreadsheet ? <div className="progress-copy"><span>Large file mode · streamed locally in adaptive batches</span><strong>{progress.rows.toLocaleString()} rows</strong></div> : <div className="progress-copy"><span>{progress.stage}</span><strong>{progress.percent}%</strong></div>}
        <div className="progress-track" role="progressbar" aria-label="Parsing progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}><span style={{ width: `${progress.percent}%` }} /></div>
        <div className="profile-skeletons" aria-hidden="true"><Skeleton /><Skeleton width="76%" /><Skeleton width="54%" /></div>
        {file.size >= LARGE_FILE_BYTES && !isSpreadsheet && <p className="eta-copy">{formatEta(progress.eta)}</p>}
      </>}
      <div className="parsing-actions"><span>Private browser processing · Your file stays on this device</span><button className="cancel-button" onClick={reset}>Cancel</button></div>
    </div> : null}

    {state === 'done' && file && dataset && profile ? <div className="results-view">
      <div className="results-topline"><div><p className="eyebrow"><span className="status-dot" /> PROFILE READY</p><h1>{dataset.name}</h1><p className="results-subtitle">{formatBytes(dataset.sizeBytes)} <span>·</span> {dataset.format.toUpperCase()}{dataset.largeFileMode ? ' · Large file mode' : ''}</p></div><button className="start-over-button" onClick={reset}>Start over</button></div>
      {dataset.sizeBytes >= VERY_LARGE_FILE_BYTES && <div className="warning-callout" role="status">Performance depends on the device’s available memory. Profile results are ready; keep this tab open while the dataset is in use.</div>}
      {isSpreadsheet && dataset.sizeBytes >= LARGE_FILE_BYTES && <div className="warning-callout" role="status">Excel is not streamable, so the workbook was parsed in memory and may need significant device memory.</div>}
      {note && <div className="note-callout">{note}</div>}
      {raggedRows > 0 && <div className="warning-callout" role="status">{raggedRows.toLocaleString()} ragged row{raggedRows === 1 ? '' : 's'} did not match the header width; missing cells were left empty and extra cells were ignored.</div>}
      {encoding && <p className="parser-meta">Detected {encoding.toUpperCase()}{delimiter ? ` · Delimiter: ${delimiter}` : ''}</p>}
      <section className="summary-cards" aria-label="Dataset summary">
        <SummaryCard label="Rows" value={profile.summary.rows.toLocaleString()} detail="Records parsed" icon="↕" />
        <SummaryCard label="Columns" value={profile.summary.columns.toLocaleString()} detail="Fields detected" icon="▤" />
        <SummaryCard label="File size" value={formatBytes(dataset.sizeBytes)} detail="Original file" icon="◫" />
        <SummaryCard label="Duplicate rows" value={profile.summary.fullyDuplicateRows.toLocaleString()} detail="Beyond first occurrence" icon="⧉" tone={profile.summary.fullyDuplicateRows ? 'warning' : ''} />
        <SummaryCard label="Missing values" value={profile.summary.nullCells.toLocaleString()} detail="Empty, N/A, or dash" icon="◌" tone={profile.summary.nullCells ? 'warning' : ''} />
      </section>
      <section className="smart-clean-card" aria-label="Smart Clean"><div className="section-heading"><div><p className="eyebrow">AUTOMATED CLEANING</p><h2>Smart Clean</h2><p>Apply deterministic low-risk fixes across all matching columns in one run.</p><label className="missing-threshold">Maximum missing rate eligible for fill proposals <span className="percent-input"><input aria-label="Maximum missing rate for fill proposals" type="number" min="0" max="100" value={maxMissingPercent} onChange={(event) => setMaxMissingPercent(Math.max(0, Math.min(100, Number(event.target.value))))} /><span>%</span></span></label></div><div className="history-actions">{busyClean && dataset.largeFileMode && <button className="secondary-button" onClick={() => workerRef.current?.postMessage({ type: 'cancel' })}>Cancel operation</button>}<button className="browse-button" onClick={startSmartClean} disabled={busyClean || !rows && !dataset.largeFileMode}>{busyClean ? 'Cleaning…' : cleanResult ? 'Run again' : 'Review and clean'}</button></div></div>
        <div className="recipe-row"><label className="secondary-button">Apply recipe<input type="file" accept="application/json,.json" hidden onChange={(event) => { const recipeFile = event.currentTarget.files?.[0]; if (!recipeFile || !profile) return; const target = event.currentTarget; void recipeFile.text().then((json) => { const recipe = importRecipeJson(json); const report = matchRecipe(recipe, profile.columns); setRecipeReport(report); setProtectedColumns([...new Set([...protectedColumns, ...report.protectedColumns])]); setRecipeRules(recipe.rules.map((rule) => ({ ...rule, scope: { ...rule.scope, mode: 'explicit', include: report.matched[rule.id] ?? [], includeIds: [], excludeIds: [] } }))) }).catch(() => setError('This recipe file is invalid or unsupported.')); target.value = '' }} /></label><span>{recipeRules ? `${recipeRules.length} recipe rules loaded` : 'No recipe selected'}</span></div>
        {recipeReport && <p className="recipe-report" role="status">Recipe matching: {Object.values(recipeReport.matched).flat().length} column matches · {recipeReport.unmatched.length} missing · {recipeReport.ambiguous.length} ambiguous{recipeReport.unmatched.length ? ` · Missing: ${recipeReport.unmatched.slice(0, 12).join(', ')}` : ''}{recipeReport.ambiguous.length ? ` · Needs review: ${recipeReport.ambiguous.slice(0, 12).join(', ')}` : ''}.</p>}
        <div className="protect-row"><label htmlFor="protect-search">Protected columns</label><input id="protect-search" value={protectSearch} onChange={(event) => setProtectSearch(event.target.value)} placeholder="Search columns to protect" /><button className="secondary-button" disabled={!protectSearch.trim()} onClick={() => setProtectedColumns([...new Set([...protectedColumns, ...profile.columns.filter((column) => column.name.toLowerCase().includes(protectSearch.toLowerCase())).map((column) => column.name)])])}>Protect matching</button><span>{protectedColumns.length} locked</span></div>
        {protectedColumns.length > 0 && <div className="protected-chips">{protectedColumns.slice(0, 12).map((name) => <button key={name} onClick={() => toggleProtected(name)} title="Unlock column">{name} ×</button>)}{protectedColumns.length > 12 && <span>+{protectedColumns.length - 12} more</span>}</div>}
        {busyClean && <div className="clean-progress"><span>{cleanProgress?.rule.replaceAll('-', ' ') ?? 'Working'}</span><strong>{cleanProgress?.completed ?? 0}/{cleanProgress?.total ?? 0} rules</strong><div className="progress-track"><span style={{ width: `${cleanProgress?.total ? cleanProgress.completed / cleanProgress.total * 100 : 4}%` }} /></div></div>}
        {cleanResult && <><div className="review-toolbar"><div><strong>Grouped review</strong><span>{cleanResult.groups.length} automatic groups · {cleanResult.proposed.length} decisions</span></div><input value={reviewQuery} onChange={(event) => setReviewQuery(event.target.value)} placeholder="Search issue or column" aria-label="Search review groups" /><button className="secondary-button" onClick={exportCurrentRecipe}>Save and export recipe</button></div>{cleanResult.proposed.some((proposal) => proposal.rule.kind === 'fill-missing') && <button className="secondary-button" onClick={() => cleanResult.proposed.filter((proposal) => proposal.rule.kind === 'fill-missing').forEach((proposal) => store.setDecisionState(proposal.rule.id, 'skipped'))}>Keep all missing</button>}<div className="review-bulk"><span>{selectedColumnCount} columns selected</span><button className="secondary-button" onClick={() => setSelectedReviewColumns([...new Set(cleanResult.groups.flatMap((group) => group.columns))])}>Select all affected</button><button className="secondary-button" disabled={!selectedReviewColumns.length} onClick={() => setExcludedColumns([...new Set([...excludedColumns, ...selectedReviewColumns])])}>Exclude from next run</button><button className="secondary-button" disabled={!selectedReviewColumns.length} onClick={() => setProtectedColumns([...new Set([...protectedColumns, ...selectedReviewColumns])])}>Lock selected</button><button className="secondary-button" disabled={!selectedReviewColumns.length} onClick={() => setSelectedReviewColumns([])}>Clear selection</button></div><div className="clean-groups">{cleanResult.groups.filter((group) => `${group.category} ${group.columns.join(' ')}`.toLowerCase().includes(reviewQuery.toLowerCase())).map((group) => <details key={group.ruleId}><summary><input type="checkbox" aria-label={`Select all ${group.columns.length} columns for ${group.category}`} checked={group.columns.length > 0 && group.columns.every((name) => selectedReviewColumns.includes(name))} onClick={(event) => event.stopPropagation()} onChange={(event) => setSelectedReviewColumns(event.target.checked ? [...new Set([...selectedReviewColumns, ...group.columns])] : selectedReviewColumns.filter((name) => !group.columns.includes(name)))} /><strong>{group.label}</strong><span>{group.warning ? 'Skipped by safety guard' : group.rowsRemoved ? `${group.rowsRemoved.toLocaleString()} rows removed` : group.columnsRenamed ? `${group.columnsRenamed.toLocaleString()} columns renamed` : group.cellsFlagged ? `${group.cellsFlagged.toLocaleString()} cells flagged` : `${(group.cellsChanged ?? group.affectedRows).toLocaleString()} cells changed`}</span></summary><p>{group.columns.slice(0, 30).join(', ')}{group.columns.length > 30 ? ` and ${group.columns.length - 30} more` : ''}</p>{group.warning && <p role="alert">{group.warning}</p>}{group.samples.map((sample) => <small key={sample}>{sample}</small>)}</details>)}</div><button className="secondary-button proposal-toggle" onClick={() => setShowProposals(!showProposals)}>{showProposals ? 'Hide' : 'Review'} risky proposals ({cleanResult.proposed.length})</button>{showProposals && <div className="decision-cards">{cleanResult.proposed.map((proposal) => { const decisionState = store.decisionStates[proposal.rule.id] ?? 'pending'; return <article key={proposal.rule.id} className="decision-card"><div><strong>{proposal.rule.kind.replaceAll('-', ' ')}</strong><span>{proposal.columns.length.toLocaleString()} affected columns · {decisionState === 'later' ? 'decide later' : decisionState}{proposal.deferredColumns?.length ? ` · ${proposal.deferredColumns.length} high-missing columns left null` : ''}{proposal.excludedColumns?.length ? ` · ${proposal.excludedColumns.length} ID/text columns excluded` : ''}</span></div><div className="decision-actions">{proposal.columns.length > 0 && <><button className="secondary-button" disabled={decisionState === 'accepted'} onClick={() => startRiskyDecision(proposal, false)}>Accept</button><button className="secondary-button" disabled={decisionState === 'accepted'} onClick={() => startRiskyDecision(proposal, true)}>Customize</button></>}{proposal.rule.kind === 'fill-missing' && proposal.deferredColumns?.length ? <button className="secondary-button" onClick={() => startDeferredFillDecision(proposal)}>Review high-missing columns</button> : null}<button className="secondary-button" onClick={() => store.setDecisionState(proposal.rule.id, 'skipped')}>Skip</button><button className="secondary-button" onClick={() => store.setDecisionState(proposal.rule.id, 'later')}>Decide later</button></div></article> })}</div>}</>}
      </section>
      <PhaseFivePanel worker={workerRef.current} downloaded={() => setCleanedDownloadComplete(true)} />
      {cleanResult && <section className="change-log-section" aria-label="Change log"><div className="section-heading"><div><h2>Review progress</h2><p>{unresolvedCount} decisions remain · Decide later keeps the issue open.</p></div><span className="section-count">{(cleanResult.proposed.length - unresolvedCount)}/{cleanResult.proposed.length} resolved</span></div><div className="progress-track" role="progressbar" aria-label="Review decisions completed" aria-valuemin={0} aria-valuemax={cleanResult.proposed.length || 1} aria-valuenow={(cleanResult.proposed.length - unresolvedCount)}><span style={{ width: `${cleanResult.proposed.length ? (cleanResult.proposed.length - unresolvedCount) / cleanResult.proposed.length * 100 : 100}%` }} /></div><div className="review-totals"><span><strong>{store.changeSteps.filter((step) => !step.undone).reduce((sum, step) => sum + step.cellsChanged, 0).toLocaleString()}</strong> cells changed</span><span><strong>{store.changeSteps.filter((step) => !step.undone).reduce((sum, step) => sum + (step.cellsEstimated ?? 0), 0).toLocaleString()}</strong> cells estimated</span><span><strong>{store.changeSteps.filter((step) => !step.undone).reduce((sum, step) => sum + step.rowsRemoved, 0).toLocaleString()}</strong> rows removed</span><span><strong>{store.changeSteps.filter((step) => !step.undone).reduce((sum, step) => sum + step.flaggedCells, 0).toLocaleString()}</strong> cells flagged</span></div><div className="history-actions"><button className="secondary-button" disabled={busyClean || (dataset.largeFileMode ? store.historyCursor <= 0 : store.historyCursor <= 0)} onClick={() => dataset.largeFileMode ? moveHistory('undo') : store.undo()}>Undo</button><button className="secondary-button" disabled={busyClean || (dataset.largeFileMode ? store.historyCursor >= store.changeSteps.length : store.historyCursor >= store.historySnapshots.length - 1)} onClick={() => dataset.largeFileMode ? moveHistory('redo') : store.redo()}>Redo</button><button className="secondary-button" disabled={busyClean || (!store.originalRows && !dataset.largeFileMode)} onClick={() => dataset.largeFileMode ? moveHistory('reset') : store.resetToOriginal()}>Reset to original</button></div>{busyClean && <><p className="operation-progress" role="status">{progress.stage}: {progress.rows.toLocaleString()}{progress.totalRows ? ` of ${progress.totalRows.toLocaleString()}` : ''} rows processed · {progress.percent}%{progress.eta !== null ? ` · ${formatEta(progress.eta)}` : ''}</p><div className="progress-track" role="progressbar" aria-label="Review operation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}><span style={{ width: `${progress.percent}%` }} /></div></>}<ol className="change-log">{store.changeSteps.map((step, index) => <li key={step.id} className={step.undone ? 'step-undone' : ''}><div><strong>{index + 1}. {step.label}</strong><time>{new Date(step.timestamp).toLocaleString()}</time></div><p>{step.scope.mode} scope · {step.rowsRemoved.toLocaleString()} rows removed · {step.cellsChanged.toLocaleString()} cells changed · {(step.cellsEstimated ?? 0).toLocaleString()} cells estimated · {step.columnsRenamed.toLocaleString()} columns renamed · {step.flaggedCells.toLocaleString()} cells flagged {step.undone ? '· undone' : ''}</p>{step.samples.length > 0 && <details><summary>View {step.samples.length} sample changes</summary>{step.samples.map((sample, sampleIndex) => <pre key={sampleIndex}>{JSON.stringify({ before: sample.before, after: sample.after }, null, 2)}</pre>)}</details>}</li>)}</ol></section>}
      {decisionDialog && decisionDraft && <div className="decision-backdrop"><section className="decision-dialog" role="dialog" aria-modal="true" aria-labelledby="decision-title"><div className="decision-dialog-heading"><div><p className="eyebrow">{decisionDialog === 'customize' ? 'CUSTOMIZE DECISION' : 'CONFIRM CHANGE'}</p><h2 id="decision-title">{decisionDialog === 'customize' ? activeProposal?.rule.kind.replaceAll('-', ' ') : `Confirm ${activeProposal?.rule.kind.replaceAll('-', ' ')}`}</h2></div><button className="secondary-button" onClick={() => setDecisionDialog(null)}>Close</button></div>
        {decisionDialog === 'customize' && <div className="decision-form">
          {decisionDraft.kind === 'remove-duplicates' && <><label>Duplicate keys (comma-separated, blank means all selected columns)<input value={Array.isArray(decisionDraft.options.keys) ? decisionDraft.options.keys.join(', ') : ''} onChange={(event) => setDecisionOption('keys', event.target.value.split(',').map((value) => value.trim()).filter(Boolean))} /></label><label>Keep<select value={String(decisionDraft.options.keep ?? 'first')} onChange={(event) => setDecisionOption('keep', event.target.value)}><option value="first">First row</option><option value="last">Last row</option></select></label></>}
          {decisionDraft.kind === 'fill-missing' && <><label>Fill strategy<select value={String(decisionDraft.options.strategy ?? 'leave-null')} onChange={(event) => setDecisionOption('strategy', event.target.value)}><option value="leave-null">Leave null</option><option value="drop-rows">Drop rows with missing values</option><option value="mean">Mean</option><option value="median">Median</option><option value="mode">Mode</option><option value="group-median">Median within a group</option><option value="group-mode">Mode within a group</option><option value="constant">Constant value</option><option value="forward-fill">Forward fill</option></select></label>{(decisionDraft.options.strategy === 'group-median' || decisionDraft.options.strategy === 'group-mode') && <label>Group values by<select value={String(decisionDraft.options.groupBy ?? '')} onChange={(event) => setDecisionOption('groupBy', event.target.value)}><option value="">Choose a grouping column</option>{(profile?.columns ?? []).filter((column) => !decisionDraft.columns.includes(column.name)).map((column) => <option key={column.id} value={column.name}>{column.name} · {column.inferredType}</option>)}</select></label>}{decisionDraft.options.strategy === 'constant' && <label>Constant value<input value={String(decisionDraft.options.value ?? '')} onChange={(event) => setDecisionOption('value', event.target.value)} /></label>}{decisionDraft.options.strategy === 'forward-fill' && <label className="decision-check"><input type="checkbox" checked={decisionDraft.options.orderedRows === true} onChange={(event) => setDecisionOption('orderedRows', event.target.checked)} /> Confirm rows are ordered by time or sequence</label>}<label className="decision-check"><input type="checkbox" checked={decisionDraft.options.addWasMissingIndicator === true} onChange={(event) => setDecisionOption('addWasMissingIndicator', event.target.checked)} /> Add was-missing indicator columns</label><label className="decision-check"><input type="checkbox" checked={decisionDraft.options.applyToAll !== false} onChange={(event) => setDecisionOption('applyToAll', event.target.checked)} /> Apply to all affected columns</label><button className="secondary-button" onClick={applyNumericFillScope} disabled={!numericFillColumns.length}>Apply to all numeric columns ({numericFillColumns.length})</button><label>Exclude columns (comma-separated)<input value={excludeDraft} onChange={(event) => setExcludeDraft(event.target.value)} placeholder="Optional exclusions" /></label><button className="secondary-button" onClick={requestImputationRecommendations} disabled={imputationPending}>{imputationPending ? 'Evaluating local model…' : 'Evaluate deterministic local estimates'}</button>{imputationRecommendations && <div className="imputation-recommendations" role="status"><strong>Local validation results</strong><p>Evaluated in the browser worker using {imputationSampleRows.toLocaleString()} rows. Three seeded 20% holdouts are combined. Recommendations never apply or overwrite values.</p>{imputationRecommendations.map((item) => { const itemProfile = profile?.columns.find((column) => column.name === item.column); const canApply = item.recommended && (dataset?.largeFileMode || (dataset?.rowCount ?? 0) <= 5_000 && item.estimates.length === (itemProfile?.nullCount ?? -1)); return <div key={item.column}><p><b>{item.column}</b>: {item.recommended ? 'validated model beat its baseline by the required margin' : item.reason}</p>{item.validation?.kind === 'numeric' && <small>Seeded {item.validation.model === 'ridge-regression' ? 'ridge regression' : 'weighted KNN'} MAE {item.validation.modelMae.toFixed(3)} vs median baseline {item.validation.baselineMae.toFixed(3)}; MAPE {item.validation.modelMape == null ? 'n/a (zero-valued targets)' : `${item.validation.modelMape.toFixed(2)}%`} vs {item.validation.baselineMape == null ? 'n/a' : `${item.validation.baselineMape.toFixed(2)}%`} baseline across {item.validation.sampleCount} held-out predictions in {item.validation.repeats} repeats.</small>}{item.validation?.kind === 'categorical' && <small>Seeded weighted KNN classifier accuracy {(item.validation.modelAccuracy * 100).toFixed(1)}% vs {(item.validation.baselineAccuracy * 100).toFixed(1)}% grouped most-frequent baseline{item.validation.groupingColumn ? ` by ${item.validation.groupingColumn}` : ''}, across {item.validation.sampleCount} held-out predictions in {item.validation.repeats} repeats.</small>}{item.estimates.length > 0 && <ul>{item.estimates.slice(0, 5).map((estimate) => <li key={estimate.sampleRow}>Sample row {estimate.sampleRow}: estimate {typeof estimate.value === 'number' ? estimate.value.toFixed(3) : String(estimate.value)}{typeof estimate.value === 'number' ? ` ± ${estimate.uncertainty.toFixed(3)}` : ` (uncertainty ${Math.round(estimate.uncertainty * 100)}%)`}</li>)}</ul>}{item.recommended && <button className="secondary-button" disabled={!canApply || busyClean} onClick={() => previewRecommendedEstimates(item)}>{canApply ? `Preview and accept ${dataset?.largeFileMode ? (itemProfile?.nullCount ?? 0).toLocaleString() : item.estimates.length.toLocaleString()} estimates` : 'Apply estimates unavailable for this sample'}</button>}</div> })}</div>}</>}
          {decisionDraft.kind === 'handle-outliers' && <label>Outlier action<select value={String(decisionDraft.options.action ?? 'flag')} onChange={(event) => setDecisionOption('action', event.target.value)}><option value="flag">Flag only (default)</option><option value="cap">Cap to IQR bounds</option><option value="remove">Remove rows</option></select></label>}
          {decisionDraft.kind === 'resolve-validation' && <label>Negative value action<select value={String(decisionDraft.options.action ?? 'leave')} onChange={(event) => setDecisionOption('action', event.target.value)}><option value="leave">Leave and flag</option><option value="empty">Set flagged values empty</option><option value="absolute">Convert to absolute values</option></select></label>}
          {decisionDraft.kind === 'standardize-categories' && <label>Suggested mapping (edit JSON before applying)<textarea rows={7} value={String(decisionDraft.options.mapping ?? '{}')} onChange={(event) => setDecisionOption('mapping', event.target.value)} /></label>}
          {decisionDraft.kind === 'resolve-ambiguous-dates' && <label>Interpret dates as<select value={String(decisionDraft.options.order ?? 'day-first')} onChange={(event) => setDecisionOption('order', event.target.value)}><option value="day-first">dd/mm/yyyy</option><option value="month-first">mm/dd/yyyy</option></select></label>}
          {decisionDraft.kind !== 'remove-duplicates' && <label>Columns included (comma-separated)<input value={decisionDraft.columns.join(', ')} onChange={(event) => updateDecisionColumns(event.target.value)} /></label>}
          <button className="browse-button" onClick={prepareDecisionPreview}>Run dry run</button>
        </div>}
        {decisionDialog === 'confirm' && dryRunResult && <><div className="dry-run-counts"><strong>{dryRunResult.rowsRemoved.toLocaleString()} rows will be removed</strong><span>{dryRunResult.cellsChanged.toLocaleString()} cells will change · {(dryRunResult.cellsEstimated ?? 0).toLocaleString()} cells will be estimated · {dryRunResult.flaggedCells.toLocaleString()} cells will be flagged</span></div><p className="dry-run-note">Dry run completed. No data has changed yet. Review up to 10 before/after examples below.</p>{decisionDraft.kind === 'fill-missing' && <ul className="fill-column-summary">{decisionDraft.columns.map((name) => { const column = profile?.columns.find((item) => item.name === name); const strategy = String(decisionDraft.options.strategy ?? 'leave-null'); const groupBy = String(decisionDraft.options.groupBy ?? 'group'); const fillValue = strategy === 'median' ? column?.median : strategy === 'mean' ? column?.mean : strategy === 'mode' ? column?.topValues[0]?.value : strategy === 'group-median' ? `median within ${groupBy}` : strategy === 'group-mode' ? `mode within ${groupBy}` : strategy === 'constant' ? decisionDraft.options.value : strategy === 'forward-fill' ? 'previous non-empty value' : strategy === 'model-estimates' ? 'validated local model estimate' : 'left null'; return <li key={name}><strong>{name}</strong>: {column?.nullPercent.toFixed(1) ?? '0.0'}% missing · fill value {String(fillValue ?? 'unavailable')}{column && strategy === 'model-estimates' && column.nullPercent > 15 ? ' · Strong warning: model estimates are explicitly applied above the 15% default threshold' : column && column.nullPercent > 5 ? ' · Warning: more than 5% of rows would be filled' : ''}</li> })}</ul>}<div className="dry-run-samples">{dryRunResult.samples.length ? dryRunResult.samples.map((sample, index) => <details key={index} open={index === 0}><summary>Sample {index + 1}</summary><div><pre>Before{`\n`}{JSON.stringify(sample.before, null, 2)}</pre><pre>After{`\n`}{JSON.stringify(sample.after, null, 2)}</pre></div></details>) : <p>No rows or cells would change for these options.</p>}</div><div className="dialog-actions"><button className="secondary-button" onClick={() => setDecisionDialog('customize')}>Back to customize</button><button className="browse-button" onClick={confirmRiskyDecision} disabled={busyClean}>Confirm and apply</button></div></>}
        {decisionError && <p className="error-message" role="alert">{decisionError}</p>}
      </section></div>}
      <section className="profile-section"><div className="section-heading"><div><h2>Column profiles</h2><p>Types, completeness, ranges, and detected data quality issues.</p></div><span className="section-count">{profile.columns.length} columns</span></div><ProfileTable columns={profile.columns} /></section>
      {profile.datasetIssues.length > 0 && <section className="dataset-issues"><h2>Dataset notes</h2>{profile.datasetIssues.map((issue) => <p key={issue.code} className={`dataset-issue issue-${issue.severity}`}><span>{issue.count?.toLocaleString()}</span>{issue.message}</p>)}</section>}
      <section className="preview-section"><div className="section-heading"><div><h2>Data preview</h2><p>First {displayedPreviewRows.length.toLocaleString()} of {dataset.rowCount.toLocaleString()} rows · {previewIsCleaned ? 'Cleaned data' : 'Original data'}</p></div><div className="segmented-control" role="group" aria-label="Preview version"><button className={previewIsCleaned ? 'segment' : 'segment active'} aria-pressed={!previewIsCleaned} onClick={() => setPreviewMode('original')}>Original</button><button className={previewIsCleaned ? 'segment active' : 'segment'} aria-pressed={previewIsCleaned} disabled={!cleanResult} onClick={() => setPreviewMode('cleaned')}>Cleaned</button></div></div>{displayedPreviewRows.length ? <VirtualPreview rows={displayedPreviewRows} columns={displayedPreviewColumns} originalRows={previewIsCleaned ? originalPreviewRows : []} originalNameByCurrentName={originalNameByCurrentName} uncertaintyByCell={previewIsCleaned ? estimateUncertaintyByCell : {}} /> : <div className="preview-empty">No preview rows are available for this dataset.</div>}</section>
      <p className="memory-note">Estimated in-memory footprint: {formatBytes(profile.summary.memoryEstimateBytes)}{dataset.largeFileMode ? ' · Original large-file data remains in local DuckDB-WASM.' : ''}</p>
    </div> : null}
  </section>
}

function SummaryCard({ label, value, detail, icon, tone = '' }: { label: string; value: string; detail: string; icon: string; tone?: string }) {
  return <article className={`summary-card ${tone ? `summary-${tone}` : ''}`}><span className="summary-icon">{icon}</span><p>{label}</p><strong>{value}</strong><small>{detail}</small></article>
}
