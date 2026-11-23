import { feedOf, isKeptPut, postItemEndpoint, putKept, refuseKeptFileWrite, withFeedLock } from './feeds'
import { checkUploadType, checkUtf8, fileType, servedType } from './filetypes'
import { header, HttpError, LIMITS, methodNotAllowed, readLimited, readQuery } from './http'
import { canReadPrivate, covers, isPrivate, parsePath, servable, writePrefixes } from './paths'
import { type Env, type Settings, store } from './settings'
import type { Grant } from './state'
import type { FileInfo, StoredFile } from './storage'

/** Storage key of a path: the path without its leading slash. */
export const keyOf = (path: string) => path.slice(1)

const invalidToken = (message: string) =>
  new HttpError(401, 'invalid_token', message, { 'WWW-Authenticate': 'Bearer error="invalid_token"' })

/**
 * Authenticates a bearer token from the Authorization header (never from the URL or the
 * body). With `write`, also counts the request against the per-grant write rate limit.
 */
export async function authenticate(req: Request, s: Settings, env: Env, write = false): Promise<Grant> {
  const auth = req.headers.get('authorization') ?? ''
  const m = auth.length <= LIMITS.header ? /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/i.exec(auth) : null
  if (!m) throw invalidToken('A bearer token is required')
  const r = await store(env).authenticate(m[1], write ? s.writesPerMinute : undefined)
  if (!r) throw invalidToken('The access token is invalid, expired or revoked')
  if (r.rateLimited) throw new HttpError(429, 'rate_limited', 'Too many writes; slow down', { 'Retry-After': '60' })
  return r.grant
}

export function requirePath(raw: string, s: Settings): string {
  const p = parsePath(raw, s)
  if ('error' in p) throw new HttpError(400, 'invalid_path', p.error)
  return p.path
}

export function requireScope(grant: Grant, path: string) {
  if (!writePrefixes(grant.scope).some(prefix => covers(prefix, path)))
    throw new HttpError(403, 'insufficient_scope', 'The path is outside the granted scope', {
      'WWW-Authenticate': 'Bearer error="insufficient_scope"',
    })
}

/** Weak ETags (W/"…") are compared like strong ones: a CDN may weaken the ETag of a compressed response. */
const etagList = (v: string) => v.split(',').map(x => x.trim().replace(/^W\//, '')).filter(Boolean)
export const etagMatches = (header: string, etag: string) => etagList(header).some(x => x == '*' || x == etag)

/**
 * PUT or DELETE of a file. `rawPath` is percent-encoded and relative to storage_base
 * (starting with `/`). Shared by the direct API and the POST fallback.
 *
 * Bunny Storage has no conditional writes: preconditions are checked against the current
 * file (its ETag is the SHA-256 of its content), then the file is written.
 */
export async function write(req: Request, method: string, rawPath: string, s: Settings, env: Env): Promise<Response> {
  const grant = await authenticate(req, s, env, true)
  const path = requirePath(rawPath, s)
  requireScope(grant, path)
  const key = keyOf(path)
  const ifMatch = header(req, 'if-match')
  const ifNoneMatch = header(req, 'if-none-match')
  const files = env.files!
  const db = store(env)
  // The content (for its ETag) is read only when a precondition needs it.
  const current = (): Promise<StoredFile | FileInfo | null> => ifMatch || ifNoneMatch ? files.get(key) : files.stat(key)
  const etag = (f: StoredFile | FileInfo) => 'etag' in f ? f.etag : ''
  // Feed files and their archives are written under the feed's lock (RFC-7 "Kept feeds"); apps never write the
  // archives and comment feeds of a kept feed.
  const feed = feedOf(path, s)
  if (feed != path) await refuseKeptFileWrite(path, s, env)
  const locked = (fn: () => Promise<Response>) => feed ? withFeedLock(feed, fn) : fn()

  if (method == 'DELETE') return locked(async () => {
    const existing = await current()
    if (!existing) throw new HttpError(404, 'not_found', 'The file does not exist')
    if (ifMatch && !etagMatches(ifMatch, etag(existing))) throw new HttpError(412, 'precondition_failed', 'The file has changed')
    await files.delete(key)
    await db.reserveStorage(-existing.size, 0)
    return new Response(null, { status: 204 })
  })

  // PUT: check the type and size before storing a single byte.
  const type = checkUploadType(path, header(req, 'content-type'))
  const length = req.headers.get('content-length')
  if (length && Number(length) > s.maxUploadBytes) throw tooLarge(s)
  const body = await readLimited(req.body, s.maxUploadBytes)
  if (!body) throw tooLarge(s)
  checkUtf8(type, body)
  // A feed file with the marker is kept by the server (RFC-7 "Kept feeds").
  const kept = isKeptPut(path, body, s)

  return locked(async () => {
    const existing = await current()
    if (ifNoneMatch && (ifNoneMatch.trim() == '*' ? existing : existing && etagMatches(ifNoneMatch, etag(existing))))
      throw new HttpError(412, 'precondition_failed', 'The file already exists')
    if (ifMatch && (!existing || !etagMatches(ifMatch, etag(existing))))
      throw new HttpError(412, 'precondition_failed', existing ? 'The file has changed' : 'The file does not exist')
    if (kept != undefined) return putKept(path, rawPath, kept, !!existing, s, env)

    const delta = body.byteLength - (existing?.size ?? 0)
    if (!await db.reserveStorage(delta, s.maxStorageBytes)) throw new HttpError(507, 'insufficient_storage', 'The storage quota is reached')
    let newEtag: string
    try {
      newEtag = await files.put(key, body)
    } catch (e) {
      await db.reserveStorage(-delta, 0)
      throw e
    }
    const status = existing ? 200 : 201
    return new Response(null, {
      status,
      headers: { ETag: newEtag, ...status == 201 && { Location: s.storageBase + rawPath.slice(1) } },
    })
  })
}

/** A missing file. Never cached: the edge would keep answering 404, even to fresh reads, after the file is created. */
const notFound = () => new HttpError(404, 'not_found', 'Not found', { 'Cache-Control': 'no-cache', Vary: 'Authorization' })
const tooLarge = (s: Settings) => new HttpError(413, 'too_large', `Files may be at most ${s.maxUploadBytes} bytes`)

/** The upload API at storage_base: PUT, DELETE, and GET/HEAD (public, or fresh with a token). */
export async function filesEndpoint(req: Request, rawPath: string, s: Settings, env: Env): Promise<Response> {
  switch (req.method) {
    case 'PUT':
    case 'DELETE':
      return write(req, req.method, rawPath, s, env)
    case 'POST':
      // Items to a kept feed (RFC-7); a POST to any other file gets 405.
      return postItemEndpoint(req, rawPath, s, env)
    case 'GET':
    case 'HEAD':
      return serve(req, rawPath, s, env, true)
    default:
      throw methodNotAllowed('GET, HEAD, PUT, DELETE, OPTIONS')
  }
}

/**
 * Is a GET/HEAD a fresh read (RFC-6)? Only with a Bearer token, which must be valid but may have
 * any scope, `identify` included: it only makes caches pass the request on, and its use is
 * recorded like a write's. An invalid one gets 401, never a public read. Other schemes (e.g.
 * Basic from a password-protected site) are ignored.
 */
async function freshRead(req: Request, s: Settings, env: Env): Promise<boolean> {
  if (!/^Bearer(\s|$)/i.test(req.headers.get('authorization') ?? '')) return false
  await authenticate(req, s, env)
  return true
}

/** POST fallback for hosts that block PUT and DELETE. `method=POST` posts an item to a feed. */
export async function postEndpoint(req: Request, s: Settings, env: Env): Promise<Response> {
  if (req.method != 'POST') throw methodNotAllowed('POST, OPTIONS')
  const q = readQuery(req)
  const method = q.get('method')
  const path = q.get('path')
  if (method != 'PUT' && method != 'DELETE' && method != 'POST') throw new HttpError(400, 'invalid_request', 'method must be PUT, DELETE or POST')
  if (!path) throw new HttpError(400, 'invalid_path', 'path is required')
  // `path` was percent-decoded once by the query parser; re-encode so write() decodes it exactly once.
  const raw = path.split('/').map(encodeURIComponent).join('/')
  return method == 'POST' ? postItemEndpoint(req, raw, s, env) : write(req, method, raw, s, env)
}

/**
 * Headers on every uploaded file: they make sure an upload is always treated as data. A fresh
 * read must not be stored by any cache; a cache that stored a public response must not use it
 * for a fresh read (Vary; Bunny's pull zone ignores it, see README, "Fresh reads").
 */
export const fileHeaders = (contentType: string, fresh = false) => ({
  'Content-Type': contentType,
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': 'sandbox',
  'Cache-Control': fresh ? 'private, no-store' : 'no-cache',
  Vary: 'Authorization',
  'Accept-Ranges': 'bytes',
})

/** A single byte range (`bytes=a-b`, `bytes=a-`, `bytes=-n`) within `size`; null if unsatisfiable, undefined to send everything. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | undefined {
  const m = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || !m[1] && !m[2]) return
  if (!m[1]) {
    const n = Number(m[2])
    return n ? { start: Math.max(0, size - n), end: size - 1 } : null
  }
  const start = Number(m[1]), end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  return start < size && start <= end ? { start, end } : null
}

/** On every response for a private path, errors included: no cache may keep a private file, or a 404 that would hide it. */
const PRIVATE_HEADERS = { 'Cache-Control': 'no-store', Vary: 'Authorization' }

/**
 * May the request read the private file at `path`? Decided before anything tells whether the
 * file exists (RFC-6 "Private areas"): no bearer token 401, an invalid one 401, a token whose
 * `write:` or `read:` scopes don't cover the path 403.
 */
async function authorizePrivate(req: Request, path: string, s: Settings, env: Env) {
  if (!/^Bearer(\s|$)/i.test(req.headers.get('authorization') ?? ''))
    throw new HttpError(401, 'invalid_token', 'Private files can only be read with a bearer token', { 'WWW-Authenticate': 'Bearer' })
  const grant = await authenticate(req, s, env)
  if (!canReadPrivate(grant.scope, path))
    throw new HttpError(403, 'insufficient_scope', 'The private file is outside the granted scope', {
      'WWW-Authenticate': 'Bearer error="insufficient_scope"',
    })
}

/**
 * Read of an uploaded file, at storage_base or any other URL that maps to a stored file.
 * `rawPath` is percent-encoded and starts with `/`. Always from storage. At storage_base
 * (`atStorageBase`), a bearer token makes it a fresh read. A private file is served only with
 * a token whose scope covers it, whatever the URL, and is never stored by any cache.
 */
export async function serve(req: Request, rawPath: string, s: Settings, env: Env, atStorageBase = false): Promise<Response> {
  const p = parsePath(rawPath, s)
  const path = 'path' in p ? p.path : undefined
  if (!path || !isPrivate(path)) return serveFile(req, path, s, env, atStorageBase && await freshRead(req, s, env))
  try {
    await authorizePrivate(req, path, s, env)
    return await serveFile(req, path, s, env, true)
  } catch (e) {
    if (e instanceof HttpError) Object.assign(e.headers, PRIVATE_HEADERS)
    throw e
  }
}

/** Serves a normalized path (undefined if invalid); a `fresh` read must not be stored by any cache. */
async function serveFile(req: Request, path: string | undefined, s: Settings, env: Env, fresh: boolean): Promise<Response> {
  if (req.method != 'GET' && req.method != 'HEAD') throw methodNotAllowed('GET, HEAD, OPTIONS')
  // Uploads never contain JavaScript; refusing service worker scripts is defence in depth.
  if (req.headers.get('service-worker')?.toLowerCase() == 'script')
    throw new HttpError(403, 'forbidden', 'Uploaded files can never be service workers')
  // Only paths an app could have written: never the server's state under /_pups/.
  const type = path && servable(path, s) && fileType(path)
  if (!type || !path) throw notFound()
  // The whole file is read: its ETag is the hash of its content.
  const file = await env.files!.get(keyOf(path))
  if (!file) throw notFound()
  const headers = new Headers(fileHeaders(servedType(type), fresh))
  headers.set('ETag', file.etag)
  if (file.lastModified && !isNaN(+file.lastModified)) headers.set('Last-Modified', file.lastModified.toUTCString())

  const ifNoneMatch = req.headers.get('if-none-match'), ifMatch = req.headers.get('if-match')
  if (ifMatch && !etagMatches(ifMatch, file.etag)) return new Response(null, { status: 412, headers })
  if (ifNoneMatch && etagMatches(ifNoneMatch, file.etag)) return new Response(null, { status: 304, headers })

  const range = req.method == 'GET' ? parseRange(req.headers.get('range'), file.size) : undefined
  if (range === null) {
    headers.set('Content-Range', `bytes */${file.size}`)
    return new Response(null, { status: 416, headers })
  }
  if (range && (range.start || range.end < file.size - 1)) {
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`)
    return new Response(file.bytes.slice(range.start, range.end + 1), { status: 206, headers })
  }
  headers.set('Content-Length', String(file.size))
  return new Response(req.method == 'HEAD' ? null : file.bytes, { headers })
}
