export function takeFullBatches<T>(pending: T[], batchSize: number): T[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError('Batch size must be a positive integer.')
  const batches: T[][] = []
  while (pending.length >= batchSize) batches.push(pending.splice(0, batchSize))
  return batches
}

export function* generateCsvRows(rowCount: number): Generator<string> {
  yield 'row_id,name,value\n'
  for (let index = 1; index <= rowCount; index += 1) yield `${index},record-${index},${index % 97}\n`
}
