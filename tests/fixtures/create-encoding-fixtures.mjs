import { mkdirSync, writeFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = resolve(dirname(fileURLToPath(import.meta.url)))
mkdirSync(directory, { recursive: true })
const content = 'name,city\nAndré,Montréal\n'
const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')])
writeFileSync(resolve(directory, 'utf16.csv'), utf16)
const latin1 = Buffer.from([0x6e,0x61,0x6d,0x65,0x2c,0x63,0x69,0x74,0x79,0x0a,0x41,0x6e,0x64,0x72,0xe9,0x2c,0x4d,0x6f,0x6e,0x74,0x72,0xe9,0x61,0x6c,0x0a])
writeFileSync(resolve(directory, 'latin1.csv'), latin1)
const tiny = `id,name,note\n${Array.from({ length: 100 }, (_, i) => `${i + 1},person-${i + 1},a tiny local fixture`).join('\n')}\n`
writeFileSync(resolve(directory, 'tiny-kb.csv'), tiny)
