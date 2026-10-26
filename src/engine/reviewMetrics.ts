import type { InferredType, PlannedRule } from '../types'
import { countUnresolvedProposals } from './smartClean'

/** Count unique selected column names, bounded by the current dataset width. */
export function countSelectedColumns(selected: readonly string[], columnCount: number): number {
  return Math.min(Math.max(0, columnCount), new Set(selected).size)
}

/** Return eligible distinct target names for a bulk fill scope, excluding IDs and protected columns. */
export function selectFillColumnsByType(
  columns: readonly { name: string; inferredType: InferredType; issues: readonly { code: string }[] }[],
  candidates: readonly string[],
  types: readonly InferredType[],
  protectedColumns: readonly string[] = [],
): string[] {
  const candidateSet = new Set(candidates)
  const protectedSet = new Set(protectedColumns)
  return [...new Set(columns
    .filter((column) => candidateSet.has(column.name) && types.includes(column.inferredType) && !protectedSet.has(column.name) && !column.issues.some((issue) => issue.code === 'identifier-column'))
    .map((column) => column.name))]
}

/** Pending and deferred proposals both remain unresolved until an explicit decision. */
export function countRemainingDecisions(
  proposals: readonly PlannedRule[],
  states: Record<string, 'pending' | 'later' | 'accepted' | 'skipped'>,
): number {
  return countUnresolvedProposals([...proposals], states)
}
