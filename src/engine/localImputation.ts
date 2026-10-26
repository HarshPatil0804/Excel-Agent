import type { DataRow, DataValue } from '../types'
import { parseFormattedNumber } from '../cleaners/rules'

export interface ImputationEstimate { sampleRow: number; value: DataValue; uncertainty: number }
export type ImputationValidation =
  | { kind: 'numeric'; sampleCount: number; repeats: 3; modelMae: number; baselineMae: number; modelMape: number | null; baselineMape: number | null; model: 'weighted-knn' | 'ridge-regression' }
  | { kind: 'categorical'; sampleCount: number; repeats: 3; modelAccuracy: number; baselineAccuracy: number; groupingColumn: string | null; model: 'weighted-knn-classifier' }
export interface ImputationRecommendation { column: string; eligible: boolean; reason: string; missingPercent: number; recommended: boolean; validation?: ImputationValidation; estimates: ImputationEstimate[] }

interface CategoricalFeature { name: string; numeric: boolean; values: Array<number | string | null>; mean?: number; spread?: number }

function recommendCategoricalColumn(rowsInput: DataRow[], column: string, featureColumns: string[], seed: number, missingPercentOverride?: number): ImputationRecommendation {
  const allMissing = rowsInput.filter((row) => isMissing(row[column])).length
  const missingPercent = missingPercentOverride ?? (rowsInput.length ? 100 * allMissing / rowsInput.length : 0)
  const rejected = (reason: string): ImputationRecommendation => ({ column, eligible: false, reason, missingPercent, recommended: false, estimates: [] })
  if (isIdentifier(column)) return rejected('Identifier-like columns are not eligible for local model estimates.')
  if (missingPercent > 40) return rejected('More than 40% of this column is missing; model estimates are disabled.')
  if (!allMissing) return rejected('This column has no missing values to estimate.')
  const rows = deterministicSample(rowsInput, 20_000, seed)
  const labels = rows.map((row) => isMissing(row[column] ?? null) ? null : String(row[column]).trim())
  const observed = labels.map((label, index) => label === null ? -1 : index).filter((index) => index >= 0)
  if (observed.length < 100) return rejected('At least 100 observed examples are required.')
  const candidates = featureColumns.filter((name) => name !== column && !isIdentifier(name)).slice(0, 16)
  const features: CategoricalFeature[] = []
  for (const name of candidates) {
    const raw = rows.map((row) => row[name] ?? null)
    const parsed = raw.map((value) => numeric(value))
    const numericValues = parsed.filter((value): value is number => value !== null)
    if (numericValues.length >= observed.length * 0.5 && new Set(numericValues).size > 1) {
      const mean = numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length
      const spread = Math.sqrt(numericValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / numericValues.length) || 1
      features.push({ name, numeric: true, values: parsed, mean, spread })
      continue
    }
    const categories = raw.map((value) => isMissing(value) ? null : String(value).trim())
    const counts = new Map<string, number>()
    for (const value of categories) if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1)
    if (counts.size < 2) continue
    const popular = new Set([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 19).map(([value]) => value))
    features.push({ name, numeric: false, values: categories.map((value) => value === null ? null : popular.has(value) ? value : '__OTHER__') })
  }
  if (!features.length) return rejected('No usable predictor columns were found.')
  const distance = (left: number, right: number): number => {
    let sum = 0; let common = 0
    for (const feature of features) {
      const a = feature.values[left]; const b = feature.values[right]
      if (a == null || b == null) continue
      const delta = feature.numeric ? ((Number(a) - Number(b)) / feature.spread!) : (a === b ? 0 : 1)
      sum += delta ** 2; common++
    }
    return common ? Math.sqrt(sum / common) : Number.POSITIVE_INFINITY
  }
  const sampleCount = Math.min(200, Math.max(5, Math.floor(observed.length * 0.2)))
  let modelCorrect = 0; let baselineCorrect = 0; let evaluated = 0
  const groupingColumn: string | null = features.find((feature) => !feature.numeric)?.name ?? null
  for (let repeat = 0; repeat < 3; repeat++) {
    const random = randomGenerator((seed ^ 0x85ebca6b) + repeat * 0xc2b2ae35)
    const shuffled = [...observed]
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!] }
    const validation = shuffled.slice(0, sampleCount)
    const heldOut = new Set(validation)
    const training = observed.filter((index) => !heldOut.has(index))
    const overall = new Map<string, number>()
    const grouped = new Map<string, Map<string, number>>()
    for (const index of training) {
      const label = labels[index]!
      overall.set(label, (overall.get(label) ?? 0) + 1)
      if (groupingColumn) {
        const feature = features.find((item) => item.name === groupingColumn)!
        const group = feature.values[index]
        if (group != null) {
          const votes = grouped.get(String(group)) ?? new Map<string, number>()
          votes.set(label, (votes.get(label) ?? 0) + 1)
          grouped.set(String(group), votes)
        }
      }
    }
    const bestLabel = (counts: Map<string, number>): string | null => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
    const globalBest = bestLabel(overall)
    for (const index of validation) {
      const nearest = training.map((candidate) => ({ candidate, distance: distance(index, candidate), label: labels[candidate]! }))
        .filter((item) => Number.isFinite(item.distance)).sort((a, b) => a.distance - b.distance || a.candidate - b.candidate).slice(0, 5)
      if (!nearest.length || !globalBest) continue
      const votes = new Map<string, number>()
      for (const item of nearest) votes.set(item.label, (votes.get(item.label) ?? 0) + 1 / Math.max(item.distance, 1e-6))
      const prediction = [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
      const group = groupingColumn ? features.find((feature) => feature.name === groupingColumn)?.values[index] : null
      const baseline = group == null ? globalBest : bestLabel(grouped.get(String(group)) ?? new Map()) ?? globalBest
      if (prediction === labels[index]) modelCorrect++
      if (baseline === labels[index]) baselineCorrect++
      evaluated++
    }
  }
  if (evaluated < 5) return rejected('There are not enough comparable validation rows for a reliable estimate.')
  const modelAccuracy = modelCorrect / evaluated
  const baselineAccuracy = baselineCorrect / evaluated
  const recommended = modelAccuracy >= baselineAccuracy + 0.1
  const validation: ImputationValidation = { kind: 'categorical', sampleCount: evaluated, repeats: 3, modelAccuracy, baselineAccuracy, groupingColumn, model: 'weighted-knn-classifier' }
  if (!recommended) return { column, eligible: true, reason: 'The local classifier did not beat the grouped most-frequent baseline by at least 10 percentage points across three seeded holdouts.', missingPercent, recommended: false, validation, estimates: [] }
  const known = new Map<string, number>()
  for (const index of observed) known.set(labels[index]!, (known.get(labels[index]!) ?? 0) + 1)
  const estimates: ImputationEstimate[] = []
  const estimateLimit = rows.length <= 5_000 ? Number.POSITIVE_INFINITY : 100
  for (let index = 0; index < rows.length && estimates.length < estimateLimit; index++) {
    if (labels[index] !== null) continue
    const nearest = observed.map((candidate) => ({ candidate, distance: distance(index, candidate), label: labels[candidate]! }))
      .filter((item) => Number.isFinite(item.distance)).sort((a, b) => a.distance - b.distance || a.candidate - b.candidate).slice(0, 5)
    if (!nearest.length) continue
    const votes = new Map<string, number>()
    for (const item of nearest) votes.set(item.label, (votes.get(item.label) ?? 0) + 1 / Math.max(item.distance, 1e-6))
    const predicted = [...votes].sort((a, b) => b[1] - a[1] || (known.get(b[0]) ?? 0) - (known.get(a[0]) ?? 0) || a[0].localeCompare(b[0]))[0]?.[0]
    if (predicted !== undefined) estimates.push({ sampleRow: index + 1, value: predicted, uncertainty: 1 - (votes.get(predicted) ?? 0) / [...votes.values()].reduce((sum, value) => sum + value, 0) })
  }
  return { column, eligible: true, reason: 'The weighted KNN classifier beat the grouped most-frequent baseline by at least 10 percentage points across three seeded holdouts.', missingPercent, recommended: true, validation, estimates }
}

const isMissing = (value: DataValue): boolean => value == null || typeof value === 'string' && ['', 'n/a', 'na', 'null', 'none', '-'].includes(value.trim().toLowerCase())
const numeric = (value: DataValue | bigint): number | null => {
  if (typeof value === 'bigint') {
    const converted = Number(value)
    return Number.isSafeInteger(converted) ? converted : null
  }
  const parsed = parseFormattedNumber(value)
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null
}
const isIdentifier = (name: string): boolean => /(?:^|[ _-])(?:id|identifier|code)(?:$|[ _-])/i.test(name)

function randomGenerator(seed: number): () => number {
  let state = seed >>> 0
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x1_0000_0000 }
}

function deterministicSample(rows: DataRow[], maxRows: number, seed: number): DataRow[] {
  if (rows.length <= maxRows) return rows
  const random = randomGenerator(seed)
  const selected = new Set<number>()
  while (selected.size < maxRows) selected.add(Math.floor(random() * rows.length))
  return [...selected].sort((a, b) => a - b).map((index) => rows[index]!)
}

export function selectImputationTrainingSample(rows: DataRow[], seed: number, maxRows = 20_000): DataRow[] {
  return deterministicSample(rows, maxRows, seed)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

interface RidgeEncoder {
  dimension: number
  encodeIndex: (index: number) => number[]
  encodeRow: (row: DataRow) => number[]
}

/** Encode numeric predictors and bounded categorical one-hot features for a small ridge model. */
function createRidgeEncoder(features: CategoricalFeature[]): RidgeEncoder {
  const numericStats = new Map<string, { mean: number; spread: number }>()
  const descriptors: Array<{ feature: CategoricalFeature; level?: string }> = []
  for (const feature of features.filter((item) => item.numeric)) {
    const values = feature.values.filter((value): value is number => typeof value === 'number')
    const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
    const spread = values.length ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) || 1 : 1
    numericStats.set(feature.name, { mean, spread })
    descriptors.push({ feature })
  }
  for (const feature of features.filter((item) => !item.numeric)) {
    const levels = [...new Set(feature.values.filter((value): value is string => typeof value === 'string'))].sort().slice(0, Math.max(0, 32 - descriptors.length))
    for (const level of levels) descriptors.push({ feature, level })
    if (descriptors.length >= 32) break
  }
  const knownCategories = new Map(features.filter((feature) => !feature.numeric).map((feature) => [feature.name, new Set(feature.values.filter((value): value is string => typeof value === 'string'))]))
  const encode = (read: (feature: CategoricalFeature) => number | string | null): number[] => {
    const result = [1, ...new Array<number>(descriptors.length).fill(0)]
    descriptors.forEach((descriptor, index) => {
      const value = read(descriptor.feature)
      if (descriptor.level !== undefined) result[index + 1] = value === descriptor.level ? 1 : 0
      else if (typeof value === 'number') {
        const stats = numericStats.get(descriptor.feature.name)!
        result[index + 1] = (value - stats.mean) / stats.spread
      }
    })
    return result
  }
  return {
    dimension: descriptors.length + 1,
    encodeIndex: (index) => encode((feature) => feature.values[index] ?? null),
    encodeRow: (row) => encode((feature) => {
      const value = row[feature.name] ?? null
      if (feature.numeric) return numeric(value)
      if (isMissing(value)) return null
      const category = String(value).trim()
      const known = knownCategories.get(feature.name)!
      return known.has(category) ? category : known.has('__OTHER__') ? '__OTHER__' : category
    }),
  }
}

function fitRidge(training: number[], targets: Array<number | null>, encoder: RidgeEncoder): { predict: (features: number[]) => number; uncertainty: number } | null {
  if (training.length < 2) return null
  const present = training.flatMap((index) => targets[index] == null ? [] : [targets[index]!])
  if (present.length < 2) return null
  const targetMean = present.reduce((sum, value) => sum + value, 0) / present.length
  const targetSpread = Math.sqrt(present.reduce((sum, value) => sum + (value - targetMean) ** 2, 0) / present.length) || 1
  const dimension = encoder.dimension
  const matrix = Array.from({ length: dimension }, () => new Array<number>(dimension).fill(0))
  const vector = new Array<number>(dimension).fill(0)
  for (const index of training) {
    const target = targets[index]
    if (target == null) continue
    const features = encoder.encodeIndex(index)
    const normalizedTarget = (target - targetMean) / targetSpread
    for (let row = 0; row < dimension; row++) {
      vector[row] += features[row]! * normalizedTarget
      for (let column = 0; column < dimension; column++) matrix[row]![column] += features[row]! * features[column]!
    }
  }
  const regularization = Math.max(1e-3, training.length * 1e-4)
  for (let index = 1; index < dimension; index++) matrix[index]![index] += regularization
  const coefficients = vector.slice()
  for (let pivot = 0; pivot < dimension; pivot++) {
    let best = pivot
    for (let row = pivot + 1; row < dimension; row++) if (Math.abs(matrix[row]![pivot]!) > Math.abs(matrix[best]![pivot]!)) best = row
    if (Math.abs(matrix[best]![pivot]!) < 1e-12) continue
    ;[matrix[pivot], matrix[best]] = [matrix[best]!, matrix[pivot]!]
    ;[coefficients[pivot], coefficients[best]] = [coefficients[best]!, coefficients[pivot]!]
    const scale = matrix[pivot]![pivot]!
    for (let column = pivot; column < dimension; column++) matrix[pivot]![column] /= scale
    coefficients[pivot] /= scale
    for (let row = 0; row < dimension; row++) {
      if (row === pivot) continue
      const factor = matrix[row]![pivot]!
      for (let column = pivot; column < dimension; column++) matrix[row]![column] -= factor * matrix[pivot]![column]!
      coefficients[row] -= factor * coefficients[pivot]!
    }
  }
  const predict = (features: number[]) => targetMean + features.reduce((sum, value, index) => sum + value * coefficients[index]!, 0) * targetSpread
  const residuals = training.flatMap((index) => targets[index] == null ? [] : [targets[index]! - predict(encoder.encodeIndex(index))])
  const uncertainty = Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / Math.max(1, residuals.length))
  return { predict, uncertainty }
}

function recommendColumn(rowsInput: DataRow[], column: string, featureColumns: string[], seed: number, missingPercentOverride?: number): ImputationRecommendation {
  const allMissing = rowsInput.filter((row) => isMissing(row[column])).length
  const missingPercent = missingPercentOverride ?? (rowsInput.length ? 100 * allMissing / rowsInput.length : 0)
  const rejected = (reason: string): ImputationRecommendation => ({ column, eligible: false, reason, missingPercent, recommended: false, estimates: [] })
  if (isIdentifier(column)) return rejected('Identifier-like columns are not eligible for local model estimates.')
  if (missingPercent > 40) return rejected('More than 40% of this column is missing; model estimates are disabled.')
  if (allMissing < 1) return rejected('This column has no missing values to estimate.')
  const rows = deterministicSample(rowsInput, 20_000, seed)
  const candidates = featureColumns.filter((name) => name !== column && !isIdentifier(name)).slice(0, 16)
  const parsedTarget = rows.map((row) => numeric(row[column] ?? null))
  const observed = parsedTarget.map((value, index) => value === null ? -1 : index).filter((index) => index >= 0)
  if (observed.length < 100) return rejected('At least 100 observed numeric examples are required.')
  const features: CategoricalFeature[] = []
  for (const name of candidates) {
    const raw = rows.map((row) => row[name] ?? null)
    const parsed = raw.map((value) => numeric(value))
    const presentNumbers = parsed.filter((value): value is number => value !== null)
    if (presentNumbers.length >= observed.length * 0.5 && new Set(presentNumbers).size > 1) {
      features.push({ name, numeric: true, values: parsed })
      continue
    }
    const categories = raw.map((value) => isMissing(value) ? null : String(value).trim())
    const counts = new Map<string, number>()
    for (const value of categories) if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1)
    if (categories.filter((value) => value !== null).length < observed.length * 0.5 || counts.size < 2) continue
    const popular = new Set([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 19).map(([value]) => value))
    features.push({ name, numeric: false, values: categories.map((value) => value === null ? null : popular.has(value) ? value : '__OTHER__') })
  }
  if (!features.length) return rejected('No usable numeric or categorical predictor columns were found.')
  const scaling = new Map<string, { mean: number; spread: number }>()
  for (const feature of features.filter((item) => item.numeric)) {
    const values = feature.values.filter((value): value is number => typeof value === 'number')
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    const spread = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) || 1
    scaling.set(feature.name, { mean, spread })
  }
  const distance = (left: number, right: number): number => {
    let sum = 0; let common = 0
    for (const feature of features) {
      const values = feature.values
      const a = values[left]; const b = values[right]
      if (a == null || b == null) continue
      if (feature.numeric) {
        const scale = scaling.get(feature.name)!.spread
        sum += ((Number(a) - Number(b)) / scale) ** 2
      } else sum += a === b ? 0 : 1
      common++
    }
    return common ? Math.sqrt(sum / common) : Number.POSITIVE_INFINITY
  }
  const predict = (targetIndex: number, training: number[]): { value: number; uncertainty: number } | null => {
    const nearest = training.map((index) => ({ index, distance: distance(targetIndex, index), target: parsedTarget[index]! }))
      .filter((item) => Number.isFinite(item.distance))
      .sort((a, b) => a.distance - b.distance || a.index - b.index).slice(0, 5)
    if (!nearest.length) return null
    const weights = nearest.map((item) => 1 / Math.max(item.distance, 1e-6))
    const totalWeight = weights.reduce((sum, value) => sum + value, 0)
    const value = nearest.reduce((sum, item, index) => sum + item.target * weights[index]!, 0) / totalWeight
    const variance = nearest.reduce((sum, item, index) => sum + weights[index]! * (item.target - value) ** 2, 0) / totalWeight
    return { value, uncertainty: Math.sqrt(variance) }
  }
  const ridgeEncoder = createRidgeEncoder(features)
  const sampleCount = Math.min(200, Math.max(5, Math.floor(observed.length * 0.2)))
  const errors = { 'weighted-knn': 0, 'ridge-regression': 0 }
  const percentErrors = { 'weighted-knn': 0, 'ridge-regression': 0 }
  let baselineError = 0; let baselinePercentError = 0
  let evaluated = 0; let nonZeroEvaluated = 0
  for (let repeat = 0; repeat < 3; repeat += 1) {
    const random = randomGenerator((seed ^ 0x9e3779b9) + repeat * 0x6d2b79f5)
    const shuffled = [...observed]
    for (let i = shuffled.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!] }
    const validationIndices = shuffled.slice(0, sampleCount)
    const heldOut = new Set(validationIndices)
    const training = observed.filter((index) => !heldOut.has(index))
    const baseline = median(training.map((index) => parsedTarget[index]!))
    const ridge = fitRidge(training, parsedTarget, ridgeEncoder)
    for (const index of validationIndices) {
      const prediction = predict(index, training)
      if (!prediction || !ridge) continue
      const actual = parsedTarget[index]!
      const ridgePrediction = ridge.predict(ridgeEncoder.encodeIndex(index))
      const modelErrors = {
        'weighted-knn': Math.abs(actual - prediction.value),
        'ridge-regression': Math.abs(actual - ridgePrediction),
      }
      const baselineAbsError = Math.abs(actual - baseline)
      for (const model of Object.keys(errors) as Array<keyof typeof errors>) errors[model] += modelErrors[model]
      baselineError += baselineAbsError
      if (actual !== 0) {
        for (const model of Object.keys(errors) as Array<keyof typeof errors>) percentErrors[model] += modelErrors[model] / Math.abs(actual) * 100
        baselinePercentError += baselineAbsError / Math.abs(actual) * 100
        nonZeroEvaluated += 1
      }
      evaluated += 1
    }
  }
  if (evaluated < 5) return rejected('There are not enough comparable validation rows for a reliable estimate.')
  const baselineMae = baselineError / evaluated
  const baselineMape = nonZeroEvaluated ? baselinePercentError / nonZeroEvaluated : null
  const modelMapes = { 'weighted-knn': nonZeroEvaluated ? percentErrors['weighted-knn'] / nonZeroEvaluated : null, 'ridge-regression': nonZeroEvaluated ? percentErrors['ridge-regression'] / nonZeroEvaluated : null }
  const candidatesByScore = (Object.keys(errors) as Array<keyof typeof errors>).map((model) => {
    const modelMae = errors[model] / evaluated
    const modelMape = modelMapes[model]
    const meetsMargin = baselineMae > 0 && modelMae <= baselineMae * 0.9 && (modelMape === null || baselineMape === null || baselineMape > 0 && modelMape <= baselineMape * 0.9)
    return { model, modelMae, modelMape, meetsMargin, score: baselineMae > 0 ? modelMae / baselineMae + (modelMape !== null && baselineMape !== null && baselineMape > 0 ? modelMape / baselineMape : 0) : Number.POSITIVE_INFINITY }
  }).sort((left, right) => left.score - right.score || (left.model === 'weighted-knn' ? -1 : 1))
  const selected = candidatesByScore.find((candidate) => candidate.meetsMargin) ?? candidatesByScore[0]!
  const recommended = candidatesByScore.some((candidate) => candidate.meetsMargin)
  const validation: ImputationValidation = { kind: 'numeric', sampleCount: evaluated, repeats: 3, modelMae: selected.modelMae, baselineMae, modelMape: selected.modelMape, baselineMape, model: selected.model }
  if (!recommended) return { column, eligible: true, reason: 'Neither local model beat the median baseline by at least 10% across three seeded holdouts; no estimates are recommended.', missingPercent, recommended: false, validation, estimates: [] }
  const estimates: ImputationEstimate[] = []
  const estimateLimit = rows.length <= 5_000 ? Number.POSITIVE_INFINITY : 100
  const ridge = selected.model === 'ridge-regression' ? fitRidge(observed, parsedTarget, ridgeEncoder) : null
  for (let index = 0; index < rows.length && estimates.length < estimateLimit; index += 1) {
    if (!isMissing(rows[index]?.[column] ?? null)) continue
    const estimate = selected.model === 'ridge-regression' && ridge
      ? { value: ridge.predict(ridgeEncoder.encodeIndex(index)), uncertainty: ridge.uncertainty }
      : predict(index, observed)
    if (estimate) estimates.push({ sampleRow: index + 1, ...estimate })
  }
  return { column, eligible: true, reason: `The ${selected.model === 'ridge-regression' ? 'ridge regression' : 'weighted nearest-neighbor model'} beat the median baseline by at least 10% across three seeded holdouts.`, missingPercent, recommended: true, validation, estimates }
}

export function recommendMissingValues(rows: DataRow[], columns: string[], featureColumns: string[], seed = 1, missingPercentByColumn: Record<string, number> = {}, targetTypes: Record<string, string> = {}, maxTrainingRows = 20_000): ImputationRecommendation[] {
  return columns.map((column, index) => {
    const columnSeed = seed + index * 997
    const targetType = targetTypes[column]
    const sampledRows = maxTrainingRows === 20_000 ? rows : deterministicSample(rows, maxTrainingRows, columnSeed)
    if (targetType === 'categorical' || targetType === 'boolean') return recommendCategoricalColumn(sampledRows, column, featureColumns, columnSeed, missingPercentByColumn[column])
    return recommendColumn(sampledRows, column, featureColumns, columnSeed, missingPercentByColumn[column])
  })
}

/** Predict one bounded page of missing target cells using a fixed, seeded training sample. */
export function predictFromTrainingSample(
  trainingRows: DataRow[],
  targetRows: DataRow[],
  column: string,
  featureColumns: string[],
  targetType: string,
  rowOrderKey = '__dc_order',
  model: 'weighted-knn' | 'ridge-regression' = 'weighted-knn',
): ImputationEstimate[] {
  const observed = trainingRows.flatMap((row, index) => {
    const value = targetType === 'categorical' || targetType === 'boolean' ? (isMissing(row[column]) ? null : String(row[column]).trim()) : numeric(row[column])
    return value === null ? [] : [{ index, value }]
  })
  if (!observed.length) return []
  const candidates = featureColumns.filter((name) => name !== column && !isIdentifier(name)).slice(0, 16)
  const features: CategoricalFeature[] = []
  for (const name of candidates) {
    const raw = trainingRows.map((row) => row[name] ?? null)
    const parsed = raw.map(numeric)
    const numericValues = parsed.filter((value): value is number => value !== null)
    if (numericValues.length >= observed.length * 0.5 && new Set(numericValues).size > 1) {
      const mean = numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length
      const spread = Math.sqrt(numericValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / numericValues.length) || 1
      features.push({ name, numeric: true, values: parsed, mean, spread })
      continue
    }
    const categories = raw.map((value) => isMissing(value) ? null : String(value).trim())
    const counts = new Map<string, number>()
    for (const value of categories) if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1)
    if (counts.size < 2) continue
    const popular = new Set([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 19).map(([value]) => value))
    features.push({ name, numeric: false, values: categories.map((value) => value === null ? null : popular.has(value) ? value : '__OTHER__') })
  }
  if (!features.length) return []
  if (model === 'ridge-regression' && targetType !== 'categorical' && targetType !== 'boolean') {
    const encoder = createRidgeEncoder(features)
    const targets = trainingRows.map((row) => numeric(row[column] ?? null))
    const fit = fitRidge(observed.map((item) => item.index), targets, encoder)
    if (!fit) return []
    return targetRows.flatMap((row, index) => {
      if (!isMissing(row[column] ?? null)) return []
      const value = fit.predict(encoder.encodeRow(row))
      return Number.isFinite(value) ? [{ sampleRow: Number(row[rowOrderKey] ?? index), value, uncertainty: fit.uncertainty }] : []
    })
  }
  const categoricalLevels = new Map(features.filter((feature) => !feature.numeric).map((feature) => [feature.name, new Set(feature.values.filter((value): value is string => typeof value === 'string'))]))
  const nearestFor = (row: DataRow): Array<{ value: number | string; distance: number; index: number }> => {
    const values = features.map((feature) => {
      const raw = row[feature.name] ?? null
      if (raw == null || isMissing(raw)) return null
      if (feature.numeric) return numeric(raw)
      const value = String(raw).trim()
      const known = categoricalLevels.get(feature.name)!
      return known.has(value) ? value : '__OTHER__'
    })
    return observed.map(({ index, value }) => {
      let sum = 0; let common = 0
      features.forEach((feature, featureIndex) => {
        const left = values[featureIndex]
        const right = feature.values[index]
        if (left == null || right == null) return
        const delta = feature.numeric ? (Number(left) - Number(right)) / feature.spread! : left === right ? 0 : 1
        sum += delta * delta; common++
      })
      return { value, distance: common ? Math.sqrt(sum / common) : Number.POSITIVE_INFINITY, index }
    }).filter((item) => Number.isFinite(item.distance)).sort((a, b) => a.distance - b.distance || a.index - b.index).slice(0, 5)
  }
  const estimates: ImputationEstimate[] = []
  targetRows.forEach((row, index) => {
    if (!isMissing(row[column] ?? null)) return
    const nearest = nearestFor(row)
    if (!nearest.length) return
    const weights = nearest.map((item) => 1 / Math.max(item.distance, 1e-6))
    const total = weights.reduce((sum, weight) => sum + weight, 0)
    if (targetType === 'categorical' || targetType === 'boolean') {
      const votes = new Map<string, number>()
      nearest.forEach((item, itemIndex) => { const key = String(item.value); votes.set(key, (votes.get(key) ?? 0) + weights[itemIndex]!) })
      const prediction = [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
      if (!prediction) return
      estimates.push({ sampleRow: Number(row[rowOrderKey] ?? index), value: prediction[0], uncertainty: 1 - prediction[1] / total })
    } else {
      const prediction = nearest.reduce((sum, item, itemIndex) => sum + Number(item.value) * weights[itemIndex]!, 0) / total
      const variance = nearest.reduce((sum, item, itemIndex) => sum + weights[itemIndex]! * (Number(item.value) - prediction) ** 2, 0) / total
      if (Number.isFinite(prediction)) estimates.push({ sampleRow: Number(row[rowOrderKey] ?? index), value: prediction, uncertainty: Math.sqrt(variance) })
    }
  })
  return estimates
}
