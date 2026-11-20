import { b64url, sha256 } from './crypto'

/**
 * Bunny Storage through its HTTP API (https://{host}/{zone}/{path}, header AccessKey).
 *
 * The API has no ETags and no conditional writes, so the ETag of a file is the SHA-256 of
 * its content, computed by reading it. Preconditions are checked with a read before the
 * write; two writes in the same instant can both pass (see README, "Consistency").
 */

export interface FileInfo {
  size: number
  lastModified?: Date
}

export interface StoredFile extends FileInfo {
  bytes: Uint8Array<ArrayBuffer>
  /** `"<base64url SHA-256 of the content>"` */
  etag: string
}

export interface ListEntry {
  /** Name within the listed directory. */
  name: string
  size: number
  isDirectory: boolean
  /** ms since epoch, if the listing has it. */
  lastModified?: number
}

/** The ETag of a file: its SHA-256, base64url-encoded and quoted. */
export const etagOf = async (bytes: Uint8Array) => `"${b64url(await sha256(bytes))}"`

const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase()

export class StorageError extends Error {}

export class Files {
  private base: string

  constructor(host: string, zone: string, private accessKey: string) {
    this.base = `https://${host}/${encodeURIComponent(zone)}/`
  }

  private url = (key: string) => this.base + key.split('/').map(encodeURIComponent).join('/')

  private async request(method: string, key: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(this.url(key), {
      ...init, method, headers: { AccessKey: this.accessKey, ...init.headers as Record<string, string> },
    })
    if (res.ok || res.status == 404) return res
    await res.body?.cancel()
    throw new StorageError(`Bunny Storage: ${method} ${key} returned HTTP ${res.status}`)
  }

  private static info(res: Response): FileInfo {
    const lm = res.headers.get('last-modified')
    return { size: Number(res.headers.get('content-length')), ...lm && { lastModified: new Date(lm) } }
  }

  /** Reads a whole file and computes its ETag. Null if it doesn't exist. */
  async get(key: string): Promise<StoredFile | null> {
    const res = await this.request('GET', key)
    if (res.status == 404) return null
    const bytes = new Uint8Array(await res.arrayBuffer())
    return { ...Files.info(res), size: bytes.byteLength, bytes, etag: await etagOf(bytes) }
  }

  /** Size (and date, if available) of a file without reading its content. */
  async stat(key: string): Promise<FileInfo | null> {
    const res = await this.request('GET', key)
    if (res.status == 404) return null
    const info = Files.info(res)
    if (Number.isFinite(info.size) && res.headers.has('content-length')) {
      await res.body?.cancel()
      return info
    }
    return { ...info, size: (await res.arrayBuffer()).byteLength }
  }

  async getJson<T>(key: string): Promise<T | null> {
    const f = await this.get(key)
    return f && JSON.parse(new TextDecoder().decode(f.bytes)) as T
  }

  /** Stores a file (replacing any existing one) and returns its ETag. */
  async put(key: string, data: Uint8Array | string): Promise<string> {
    const bytes = typeof data == 'string' ? new TextEncoder().encode(data) : data
    await this.request('PUT', key, {
      body: bytes as Uint8Array<ArrayBuffer>,
      // Bunny Storage refuses the upload if the content doesn't match the checksum.
      headers: { 'content-type': 'application/octet-stream', Checksum: hex(await sha256(bytes)) },
    })
    return etagOf(bytes)
  }

  putJson = (key: string, value: unknown) => this.put(key, JSON.stringify(value))

  /** Deletes a file. False if it didn't exist. */
  async delete(key: string): Promise<boolean> {
    return (await this.request('DELETE', key)).status != 404
  }

  /** Deletes a directory with everything in it. `dir` ends with `/`. */
  async deleteDir(dir: string): Promise<void> {
    await this.request('DELETE', dir)
  }

  /** The entries of a directory (not recursive). `dir` ends with `/`. */
  async list(dir: string): Promise<ListEntry[]> {
    const res = await this.request('GET', dir, { headers: { accept: 'application/json' } })
    if (res.status == 404) return []
    const items = await res.json() as any[]
    return Array.isArray(items) ? items.map(i => ({
      name: String(i.ObjectName), size: Number(i.Length) || 0, isDirectory: !!i.IsDirectory,
      ...i.LastChanged && { lastModified: Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(i.LastChanged) ? i.LastChanged : i.LastChanged + 'Z') },
    })) : []
  }

  /** Every file below a directory, with its key relative to the storage root. One listing per directory. */
  async walk(dir: string): Promise<(ListEntry & { key: string })[]> {
    const out: (ListEntry & { key: string })[] = []
    for (const e of await this.list(dir)) {
      if (e.isDirectory) out.push(...await this.walk(`${dir}${e.name}/`))
      else out.push({ ...e, key: dir + e.name })
    }
    return out
  }
}
