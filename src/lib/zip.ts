export interface ZipEntry { name: string; data: string | Uint8Array | ArrayBuffer }

interface StreamEntry {
  name: Uint8Array
  offset: number
  size: number
  crc: number
}

/** A ZIP store writer that emits bounded byte chunks and keeps only the directory in memory. */
export class StreamingStoredZipWriter {
  private readonly encoder = new TextEncoder()
  private readonly entries: StreamEntry[] = []
  private active: StreamEntry | null = null
  private offset = 0

  beginEntry(name: string): Uint8Array {
    if (this.active) throw new Error('Finish the current ZIP entry before starting another.')
    if (this.entries.length >= 0xffff) throw new Error('This ZIP archive exceeds the supported entry count.')
    const encodedName = this.encoder.encode(name)
    if (encodedName.length > 0xffff) throw new Error('A ZIP entry name is too long.')
    const entry: StreamEntry = { name: encodedName, offset: this.offset, size: 0, crc: 0xffffffff }
    this.active = entry
    const header = new Uint8Array(30 + encodedName.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x0808, true)
    view.setUint16(8, 0, true); view.setUint16(10, 0, true); view.setUint16(12, 0, true)
    view.setUint32(14, 0, true); view.setUint32(18, 0, true); view.setUint32(22, 0, true)
    view.setUint16(26, encodedName.length, true); view.setUint16(28, 0, true); header.set(encodedName, 30)
    this.advance(header.length)
    return header
  }

  write(data: string | Uint8Array): Uint8Array {
    const entry = this.active
    if (!entry) throw new Error('Start a ZIP entry before writing data.')
    const bytes = typeof data === 'string' ? this.encoder.encode(data) : data
    entry.size += bytes.length
    this.assert32Bit(entry.size, 'A ZIP entry exceeds 4 GB; use the individual streamed export instead.')
    for (const byte of bytes) {
      entry.crc ^= byte
      for (let bit = 0; bit < 8; bit += 1) entry.crc = (entry.crc >>> 1) ^ (entry.crc & 1 ? 0xedb88320 : 0)
    }
    this.advance(bytes.length)
    return bytes
  }

  endEntry(): Uint8Array {
    const entry = this.active
    if (!entry) throw new Error('There is no active ZIP entry to finish.')
    entry.crc = (entry.crc ^ 0xffffffff) >>> 0
    this.active = null
    this.entries.push(entry)
    const descriptor = new Uint8Array(16)
    const view = new DataView(descriptor.buffer)
    view.setUint32(0, 0x08074b50, true); view.setUint32(4, entry.crc, true)
    view.setUint32(8, entry.size, true); view.setUint32(12, entry.size, true)
    this.advance(descriptor.length)
    return descriptor
  }

  finish(): Uint8Array {
    if (this.active) throw new Error('Finish the current ZIP entry before closing the archive.')
    const centralParts = this.entries.map((entry) => {
      const central = new Uint8Array(46 + entry.name.length)
      const view = new DataView(central.buffer)
      view.setUint32(0, 0x02014b50, true); view.setUint16(4, 20, true); view.setUint16(6, 20, true)
      view.setUint16(8, 0x0808, true); view.setUint16(10, 0, true); view.setUint16(12, 0, true); view.setUint16(14, 0, true)
      view.setUint32(16, entry.crc, true); view.setUint32(20, entry.size, true); view.setUint32(24, entry.size, true)
      view.setUint16(28, entry.name.length, true); view.setUint16(30, 0, true); view.setUint16(32, 0, true); view.setUint16(34, 0, true)
      view.setUint16(36, 0, true); view.setUint32(38, 0, true); view.setUint32(42, entry.offset, true); central.set(entry.name, 46)
      return central
    })
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
    this.assert32Bit(this.offset, 'This ZIP archive exceeds 4 GB; use the individual streamed export instead.')
    this.assert32Bit(centralSize, 'ZIP directory is too large.')
    const end = new Uint8Array(22)
    const view = new DataView(end.buffer)
    view.setUint32(0, 0x06054b50, true); view.setUint16(4, 0, true); view.setUint16(6, 0, true)
    view.setUint16(8, this.entries.length, true); view.setUint16(10, this.entries.length, true)
    view.setUint32(12, centralSize, true); view.setUint32(16, this.offset, true); view.setUint16(20, 0, true)
    const result = new Uint8Array(centralSize + end.length)
    let cursor = 0
    for (const part of centralParts) { result.set(part, cursor); cursor += part.length }
    result.set(end, cursor)
    return result
  }

  private advance(size: number): void {
    this.offset += size
    this.assert32Bit(this.offset, 'This ZIP archive exceeds 4 GB; use the individual streamed export instead.')
  }

  private assert32Bit(value: number, message: string): void {
    if (!Number.isSafeInteger(value) || value > 0xffffffff) throw new Error(message)
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function createStoredZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data)
    const crc = crc32(data)
    const local = new Uint8Array(30 + name.length + data.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true); localView.setUint16(4, 20, true); localView.setUint16(6, 0x0800, true)
    localView.setUint16(8, 0, true); localView.setUint16(10, 0, true); localView.setUint16(12, 0, true)
    localView.setUint32(14, crc, true); localView.setUint32(18, data.length, true); localView.setUint32(22, data.length, true)
    localView.setUint16(26, name.length, true); localView.setUint16(28, 0, true); local.set(name, 30); local.set(data, 30 + name.length)
    localParts.push(local)
    const central = new Uint8Array(46 + name.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true); centralView.setUint16(4, 20, true); centralView.setUint16(6, 20, true)
    centralView.setUint16(8, 0x0800, true); centralView.setUint16(10, 0, true); centralView.setUint16(12, 0, true); centralView.setUint16(14, 0, true)
    centralView.setUint32(16, crc, true); centralView.setUint32(20, data.length, true); centralView.setUint32(24, data.length, true)
    centralView.setUint16(28, name.length, true); centralView.setUint16(30, 0, true); centralView.setUint16(32, 0, true); centralView.setUint16(34, 0, true)
    centralView.setUint16(36, 0, true); centralView.setUint32(38, 0, true); centralView.setUint32(42, localOffset, true); central.set(name, 46)
    centralParts.push(central); localOffset += local.length
  }
  const centralLength = centralParts.reduce((total, part) => total + part.length, 0)
  const end = new Uint8Array(22); const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true); endView.setUint16(4, 0, true); endView.setUint16(6, 0, true)
  endView.setUint16(8, entries.length, true); endView.setUint16(10, entries.length, true); endView.setUint32(12, centralLength, true); endView.setUint32(16, localOffset, true); endView.setUint16(20, 0, true)
  const result = new Uint8Array(localOffset + centralLength + end.length)
  let offset = 0
  for (const part of localParts) { result.set(part, offset); offset += part.length }
  for (const part of centralParts) { result.set(part, offset); offset += part.length }
  result.set(end, offset)
  return result
}
