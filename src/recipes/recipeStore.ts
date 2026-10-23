import { z } from 'zod'
import type { CleaningRecipe } from '../types'

const recipeSchema = z.object({ id: z.string(), version: z.literal(1), name: z.string(), createdAt: z.string(), rules: z.array(z.object({ id: z.string(), kind: z.string(), enabled: z.boolean(), risk: z.enum(['low', 'medium', 'high']), scope: z.object({ mode: z.enum(['all', 'byType', 'byIssue', 'byNamePattern', 'explicit']), types: z.array(z.string()).optional(), issues: z.array(z.string()).optional(), pattern: z.string().optional(), include: z.array(z.string()).optional(), exclude: z.array(z.string()).optional(), includeIds: z.array(z.string()).optional(), excludeIds: z.array(z.string()).optional() }), options: z.record(z.union([z.string(), z.number(), z.boolean()])) })), protectedColumns: z.array(z.string()), columnTypes: z.record(z.string()), stableColumnIds: z.record(z.string()).optional(), protectedColumnIds: z.array(z.string()).optional() })
const DB_NAME = 'datacleaner-local-recipes'
const STORE_NAME = 'recipes'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('IndexedDB is unavailable in this browser.')); return }
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open local recipe storage.'))
  })
}

export async function saveRecipe(recipe: CleaningRecipe): Promise<void> {
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => { const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(recipe); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error) })
  db.close()
}

export async function listRecipes(): Promise<CleaningRecipe[]> {
  const db = await openDatabase()
  const result = await new Promise<CleaningRecipe[]>((resolve, reject) => { const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll(); request.onsuccess = () => resolve(request.result as CleaningRecipe[]); request.onerror = () => reject(request.error) })
  db.close()
  return result
}

export function exportRecipeJson(recipe: CleaningRecipe): string { return JSON.stringify(recipe, null, 2) }
export function importRecipeJson(json: string): CleaningRecipe { return recipeSchema.parse(JSON.parse(json)) as CleaningRecipe }
