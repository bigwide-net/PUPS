import { createHash } from 'node:crypto'
import { vi } from 'vitest'

/**
 * Fakes of everything the script reaches with fetch(): the Bunny Storage HTTP API, DNS over
 * HTTPS, client metadata documents and an origin website.
 */

export const STORAGE_HOST = 'storage.test'
export const ZONE = 'pups-zone'
export const ACCESS_KEY = 'storage-password'

/** The fake storage zone: key → file. */
export const storage = new Map<string, { bytes: Uint8Array<ArrayBuffer>; changed: number }>()

/** Hosts that resolve to private addresses. Everything else resolves to a public one. */
export const privateHosts = new Set(['private.example'])

export const clientDocs = new Map<string, unknown>()
export const cimdFetches: string[] = []
export const originPages = new Map<string, string>()

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').toUpperCase()

/** The documented behaviour of https://{host}/{zone}/{path}: PUT, GET, DELETE (recursive for directories) and listings. */
async function fakeStorage(url: URL, init: RequestInit): Promise<Response> {
  if (new Headers(init.headers).get('accesskey') != ACCESS_KEY) return new Response('Unauthorized', { status: 401 })
  const [zone, ...rest] = url.pathname.slice(1).split('/')
  if (decodeURIComponent(zone) != ZONE) return new Response('Unauthorized', { status: 401 })
  const key = rest.map(decodeURIComponent).join('/')
  const method = init.method ?? 'GET'
  const isDir = key == '' || key.endsWith('/')
  if (method == 'PUT') {
    const bytes = new Uint8Array(await new Response(init.body).arrayBuffer())
    const checksum = new Headers(init.headers).get('checksum')
    if (checksum && checksum != sha(bytes)) return Response.json({ HttpCode: 400, Message: 'Checksum mismatch' }, { status: 400 })
    storage.set(key, { bytes, changed: Date.now() })
    return Response.json({ HttpCode: 201, Message: 'File uploaded.' }, { status: 201 })
  }
  if (method == 'DELETE') {
    const keys = isDir ? [...storage.keys()].filter(k => k.startsWith(key)) : storage.has(key) ? [key] : []
    keys.forEach(k => storage.delete(k))
    return keys.length ? Response.json({ HttpCode: 200, Message: 'File deleted successfuly.' }) : new Response('Not found', { status: 404 })
  }
  if (isDir) {
    const children = new Map<string, any>()
    for (const [k, f] of storage) {
      if (!k.startsWith(key)) continue
      const [name, ...sub] = k.slice(key.length).split('/')
      children.set(name, sub.length
        ? { ObjectName: name, IsDirectory: true, Length: 0, LastChanged: new Date(f.changed).toISOString().slice(0, -1) }
        : { ObjectName: name, IsDirectory: false, Length: f.bytes.byteLength, LastChanged: new Date(f.changed).toISOString().slice(0, -1), Checksum: sha(f.bytes) })
    }
    return Response.json([...children.values()])
  }
  const f = storage.get(key)
  return f
    ? new Response(f.bytes, { headers: { 'content-length': String(f.bytes.byteLength), 'last-modified': new Date(f.changed).toUTCString() } })
    : new Response('Not found', { status: 404 })
}

function fakeDoh(url: URL): Response {
  const name = url.searchParams.get('name')!, type = url.searchParams.get('type')
  const answer = type == 'A' ? [{ name, type: 1, data: privateHosts.has(name) ? '10.0.0.5' : '93.184.215.14' }] : []
  return Response.json({ Status: 0, Answer: answer })
}

/** Routes fetch() to the fakes. */
export function installFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const req = input instanceof Request ? input : undefined
    const url = new URL(req ? req.url : String(input))
    if (url.host == STORAGE_HOST) return fakeStorage(url, req ? { method: req.method, headers: req.headers, body: await req.arrayBuffer() } : init)
    if (url.host == 'cloudflare-dns.com') return fakeDoh(url)
    if (url.host == 'origin.test') {
      const page = originPages.get(url.pathname)
      return page ? new Response(page) : new Response('not found', { status: 404 })
    }
    cimdFetches.push(url.href)
    const doc = clientDocs.get(url.href)
    return doc ? Response.json(doc) : new Response('not found', { status: 404 })
  })
}
