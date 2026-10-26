import { create } from 'zustand'
import type { ChangeStep, DataRow, Dataset, ProfileResult, SmartCleanResult } from '../types'

interface DatasetState {
  dataset: Dataset | null
  profile: ProfileResult | null
  previewRows: DataRow[]
  rows: DataRow[] | null
  originalRows: DataRow[] | null
  protectedColumns: string[]
  cleanResult: SmartCleanResult | null
  cleanProgress: { completed: number; total: number; rule: string } | null
  originalProfile: ProfileResult | null
  originalPreviewRows: DataRow[]
  historySnapshots: DataRow[][]
  historyProfiles: ProfileResult[]
  historyCursor: number
  changeSteps: ChangeStep[]
  decisionStates: Record<string, 'pending' | 'later' | 'accepted' | 'skipped'>
  setProtectedColumns: (columns: string[]) => void
  setCleanProgress: (progress: { completed: number; total: number; rule: string } | null) => void
  setCleanResult: (result: SmartCleanResult) => void
  applyDecision: (rows: DataRow[], profile: ProfileResult, step: ChangeStep, previewRows?: DataRow[]) => void
  undo: () => void
  redo: () => void
  setLargeHistoryCursor: (cursor: number) => void
  resetToOriginal: () => void
  setDecisionState: (id: string, state: 'pending' | 'later' | 'accepted' | 'skipped') => void
  setParsedDataset: (dataset: Dataset, profile: ProfileResult, previewRows: DataRow[], rows: DataRow[] | null) => void
  clear: () => void
}

export const useDatasetStore = create<DatasetState>((set) => ({
  dataset: null,
  profile: null,
  previewRows: [],
  rows: null,
  originalRows: null,
  protectedColumns: [],
  cleanResult: null,
  cleanProgress: null,
  originalProfile: null,
  originalPreviewRows: [],
  historySnapshots: [],
  historyProfiles: [],
  historyCursor: 0,
  changeSteps: [],
  decisionStates: {},
  setProtectedColumns: (protectedColumns) => set({ protectedColumns }),
  setCleanProgress: (cleanProgress) => set({ cleanProgress }),
  setCleanResult: (cleanResult) => set((state) => {
    const initial = state.originalRows ?? state.rows
    const originalCount = initial?.length ?? state.originalProfile?.summary.rows ?? state.dataset?.rowCount ?? 0
    const resultCount = state.dataset?.largeFileMode ? state.profile?.summary.rows ?? state.dataset.rowCount : cleanResult.rows.length
    const historySnapshots = state.dataset?.largeFileMode || !initial ? [] : state.historySnapshots.length ? [...state.historySnapshots.slice(0, state.historyCursor + 1), cleanResult.rows] : [initial, cleanResult.rows]
    const historyProfiles = state.dataset?.largeFileMode || !state.originalProfile || !state.profile ? [] : state.historyProfiles.length ? [...state.historyProfiles.slice(0, state.historyCursor + 1), state.profile] : [state.originalProfile, state.profile]
    const rowsRemoved = cleanResult.groups.reduce((sum, group) => sum + (group.rowsRemoved ?? 0), 0)
    const cellsChanged = cleanResult.groups.reduce((sum, group) => sum + (group.cellsChanged ?? 0), 0)
    const cellsEstimated = cleanResult.groups.reduce((sum, group) => sum + (group.cellsEstimated ?? 0), 0)
    const columnsRenamed = cleanResult.groups.reduce((sum, group) => sum + (group.columnsRenamed ?? 0), 0)
    const flaggedCells = cleanResult.groups.reduce((sum, group) => sum + (group.cellsFlagged ?? 0), 0)
    const currentCount = state.changeSteps.length ? state.dataset?.largeFileMode ? state.dataset.rowCount : state.historySnapshots[state.historyCursor]?.length ?? state.profile?.summary.rows ?? originalCount : originalCount
    const removedRowIds = cleanResult.groups.flatMap((group) => group.removedRowIds ?? [])
    const newStep: ChangeStep = { id: crypto.randomUUID(), label: 'Smart Clean automatic rules', ruleId: 'smart-clean', scope: { mode: 'all' }, timestamp: new Date().toISOString(), rowsBefore: currentCount, rowsAfter: resultCount, rowsRemoved, ...(removedRowIds.length ? { removedRowIds } : {}), cellsChanged, cellsEstimated, columnsRenamed, flaggedCells, samples: [], undone: false }
    const changeSteps = [...state.changeSteps.slice(0, state.historyCursor || state.changeSteps.length), newStep]
    return { cleanResult, decisionStates: Object.fromEntries(cleanResult.proposed.map((proposal) => [proposal.rule.id, 'pending' as const])), dataset: state.dataset ? { ...state.dataset, rowCount: resultCount, columnCount: state.profile?.summary.columns ?? state.dataset.columnCount } : null, ...(state.dataset?.largeFileMode ? {} : { rows: cleanResult.rows, previewRows: cleanResult.rows.slice(0, 1000) }), historySnapshots, historyProfiles, historyCursor: state.dataset?.largeFileMode ? changeSteps.length : historySnapshots.length ? historySnapshots.length - 1 : 0, changeSteps, cleanProgress: null }
  }),
  applyDecision: (rows, profile, step, previewRows) => set((state) => {
    if (state.dataset?.largeFileMode) return { rows: null, profile, previewRows: previewRows ?? [], dataset: state.dataset ? { ...state.dataset, rowCount: profile.summary.rows, columnCount: profile.summary.columns } : null, historyCursor: state.historyCursor + 1, changeSteps: [...state.changeSteps.slice(0, state.historyCursor), step] }
    if (!state.historySnapshots.length) return { rows, profile, previewRows: previewRows ?? rows.slice(0, 1000), dataset: state.dataset ? { ...state.dataset, rowCount: rows.length, columnCount: profile.summary.columns } : null, changeSteps: [...state.changeSteps, step] }
    const snapshots = [...state.historySnapshots.slice(0, state.historyCursor + 1), rows]
    const profiles = [...state.historyProfiles.slice(0, state.historyCursor + 1), profile]
    return { rows, profile, previewRows: rows.slice(0, 1000), dataset: state.dataset ? { ...state.dataset, rowCount: rows.length, columnCount: profile.summary.columns } : null, historySnapshots: snapshots, historyProfiles: profiles, historyCursor: snapshots.length - 1, changeSteps: [...state.changeSteps.slice(0, state.historyCursor), step] }
  }),
  undo: () => set((state) => {
    if (state.dataset?.largeFileMode || state.historyCursor <= 0) return {}
    const cursor = state.historyCursor - 1
    const rows = state.historySnapshots[cursor]!
    const profile = state.historyProfiles[cursor] ?? state.originalProfile
    return { rows, previewRows: rows.slice(0, 1000), profile, dataset: state.dataset ? { ...state.dataset, rowCount: rows.length, columnCount: profile?.summary.columns ?? state.dataset.columnCount } : null, historyCursor: cursor, changeSteps: state.changeSteps.map((step, index) => ({ ...step, undone: index >= cursor })) }
  }),
  redo: () => set((state) => {
    if (state.dataset?.largeFileMode || state.historyCursor >= state.historySnapshots.length - 1) return {}
    const cursor = state.historyCursor + 1
    const rows = state.historySnapshots[cursor]!
    const profile = state.historyProfiles[cursor] ?? state.profile
    return { rows, previewRows: rows.slice(0, 1000), profile, dataset: state.dataset ? { ...state.dataset, rowCount: rows.length, columnCount: profile?.summary.columns ?? state.dataset.columnCount } : null, historyCursor: cursor, changeSteps: state.changeSteps.map((step, index) => ({ ...step, undone: index >= cursor })) }
  }),
  setLargeHistoryCursor: (historyCursor) => set((state) => ({ historyCursor, changeSteps: state.changeSteps.map((step, index) => ({ ...step, undone: index >= historyCursor })) })),
  resetToOriginal: () => set((state) => {
    if (!state.originalRows) return {}
    return { rows: state.originalRows, previewRows: state.originalPreviewRows, profile: state.originalProfile, dataset: state.dataset ? { ...state.dataset, rowCount: state.originalRows.length, columnCount: state.originalProfile?.summary.columns ?? state.dataset.columnCount } : null, historyCursor: 0, changeSteps: state.changeSteps.map((step) => ({ ...step, undone: true })) }
  }),
  setDecisionState: (id, decisionState) => set((state) => ({ decisionStates: { ...state.decisionStates, [id]: decisionState } })),
  setParsedDataset: (dataset, profile, previewRows, rows) => set((state) => ({ dataset, profile, previewRows, rows, originalRows: state.dataset?.id === dataset.id ? state.originalRows : rows, originalProfile: state.dataset?.id === dataset.id ? state.originalProfile : profile, originalPreviewRows: state.dataset?.id === dataset.id ? state.originalPreviewRows : previewRows })),
  clear: () => set({ dataset: null, profile: null, previewRows: [], rows: null, originalRows: null, originalProfile: null, originalPreviewRows: [], protectedColumns: [], cleanResult: null, cleanProgress: null, historySnapshots: [], historyProfiles: [], historyCursor: 0, changeSteps: [], decisionStates: {} }),
}))
