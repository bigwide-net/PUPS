import { hashToken } from './crypto'
import { feedLinks } from './websub'
import { feedOf, isKeptPut, postItemEndpoint, putKept, refuseKeptFileWrite, withFeedLock } from './feeds'
import { checkUploadType, checkUtf8, fileType, servedType } from './filetypes'
import { header, HttpError, LIMITS, methodNotAllowed, readLimited, readQuery } from './http'
import { covers, isPrivate, parsePath, readPrefixes, writePrefixes } from './paths'
import { type Env, type Settings, store } from './settings'
import type { Grant } from './store'

/** R2 key of a storage path: the path without its leading slash. */
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
  const r = await store(env).authenticate(await hashToken(m[1]), write ? s.writesPerMinute : undefined)
  if (!r) throw invalidToken('The access token is invalid, expired or revoked')
  if (r.rateLimited) throw new HttpError(429, 'rate_limited', 'Too many writes; slow down', { 'Retry-After': '60' })
  return r.grant
}

export function requirePath(raw: string, s: Settings): string {
  const p = parsePath(raw, s)
  if ('error' in p) throw new HttpError(400, 'invalid_path', p.error)
  return p.path
}

/** Throws 403 unless a write prefix of the grant (or, with `read`, also a read prefix) covers the path. */
export function requireScope(grant: Grant, path: string, read = false) {
  if (!(read ? readPrefixes : writePrefixes)(grant.scope).some(prefix => covers(prefix, path)))
    throw new HttpError(403, 'insufficient_scope', 'The path is outside the granted scope', {
      'WWW-Authenticate': 'Bearer error="insufficient_scope"',
    })
}

/** Normalizes an If-Match / If-None-Match value for R2 (which expects quoted strong ETags). */
const etagList = (v: string) => v.split(',').map(x => x.trim().replace(/^W\//, '')).filter(Boolean)
const etagMatches = (header: string, etag: string) => etagList(header).some(x => x == '*' || x == etag)

/**
 * PUT or DELETE of a file. `rawPath` is percent-encoded and relative to storage_base
 * (starting with `/`). Shared by the direct API and the POST fallback.
 */
export async function write(req: Request, method: string, rawPath: string, s: Settings, env: Env): Promise<Response> {
  const grant = await authenticate(req, s, env, true)
  const path = requirePath(rawPath, s)
  requireScope(grant, path)
  const key = keyOf(path)
  const ifMatch = header(req, 'if-match')
  const ifNoneMatch = header(req, 'if-none-match')
  const db = store(env)
  // Feed files and their archives are written under the feed's lock (RFC-7 "Kept feeds"); apps never write the
  // archives and comment feeds of a kept feed.
  const feed = feedOf(path, s)
  if (feed != path) await refuseKeptFileWrite(path, s, env)
  const locked = (fn: () => Promise<Response>) => feed ? withFeedLock(env, feed, fn) : fn()

  if (method == 'DELETE') return locked(async () => {
    const existing = await env.FILES.head(key)
    if (!existing) throw new HttpError(404, 'not_found', 'The file does not exist')
    if (ifMatch && !etagMatches(ifMatch, existing.httpEtag)) throw new HttpError(412, 'precondition_failed', 'The file has changed')
    await env.FILES.delete(key)
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
    const existing = await env.FILES.head(key)
    if (ifNoneMatch && (ifNoneMatch.trim() == '*' ? existing : existing && etagMatches(ifNoneMatch, existing.httpEtag)))
      throw new HttpError(412, 'precondition_failed', 'The file already exists')
    if (ifMatch && (!existing || !etagMatches(ifMatch, existing.httpEtag)))
      throw new HttpError(412, 'precondition_failed', existing ? 'The file has changed' : 'The file does not exist')
    if (kept != undefined) return putKept(path, rawPath, kept, !!existing, grant, s, env)

    const delta = body.byteLength - (existing?.size ?? 0)
    if (!await db.reserveStorage(delta, s.maxStorageBytes)) throw new HttpError(507, 'insufficient_storage', 'The storage quota is reached')
    // The client's conditions were checked against `existing` above. R2 then makes the write
    // conditional on `existing` still being the current version (atomically), which also keeps the
    // quota exact. The client's headers are not passed on: Cloudflare weakens the ETags of
    // compressed responses (W/"…"), and R2 never matches a weak ETag.
    const conditions = new Headers()
    conditions.set(existing ? 'if-match' : 'if-none-match', existing?.httpEtag ?? '*')
    const obj = await env.FILES.put(key, body, {
      onlyIf: conditions,
      httpMetadata: { contentType: servedType(type) },
      customMetadata: { grant: grant.id, client: grant.clientId },
    })
    if (!obj) {
      await db.reserveStorage(-delta, 0)
      throw new HttpError(412, 'precondition_failed', 'The file was changed concurrently')
    }
    const status = existing ? 200 : 201
    return new Response(null, {
      status,
      headers: { ETag: obj.httpEtag, ...status == 201 && { Location: s.storageBase + rawPath.slice(1) } },
    })
  })
}

const tooLarge = (s: Settings) => new HttpError(413, 'too_large', `Files may be at most ${s.maxUploadBytes} bytes`)

/** Reads at storage_base vary by Authorization: with a token, they are fresh reads. */
const PUBLIC_READ = { Vary: 'Authorization' }
const FRESH_READ = { ...PUBLIC_READ, 'Cache-Control': 'private, no-store' }
/** On every error for a private path: no cache may store it, not even a 404. */
const PRIVATE_ERROR = { ...PUBLIC_READ, 'Cache-Control': 'no-store' }

const hasBearer = (req: Request) => /^Bearer\s/i.test(req.headers.get('authorization') ?? '')

/** The upload API at storage_base: PUT, DELETE, and public or fresh GET/HEAD. */
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

/** Headers on every uploaded file: they make sure an upload is always treated as data. */
export const fileHeaders = (contentType: string) => ({
  'Content-Type': contentType,
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': 'sandbox',
  'Cache-Control': 'no-cache',
  'Accept-Ranges': 'bytes',
})

/** Is a percent-encoded path (starting with `/`) a valid path in a private area? */
export function isPrivateRaw(rawPath: string, s: Settings) {
  const p = parsePath(rawPath, s)
  return 'path' in p && isPrivate(p.path)
}

function checkRead(req: Request) {
  if (req.method != 'GET' && req.method != 'HEAD') throw methodNotAllowed('GET, HEAD, OPTIONS')
  // Uploads never contain JavaScript; refusing service worker scripts is defence in depth.
  if (req.headers.get('service-worker')?.toLowerCase() == 'script')
    throw new HttpError(403, 'forbidden', 'Uploaded files can never be service workers')
}

/**
 * Read of an uploaded file, from R2 (never from a cache), at any URL that maps to a file:
 * storage_base, public_base or a well-known `url`. `rawPath` is percent-encoded and starts with `/`.
 * `atStorageBase`: a bearer token makes the read a fresh read (RFC-6 "Fresh reads").
 * Private files are read only with a token that covers them, whatever the URL.
 */
export async function serve(req: Request, rawPath: string, s: Settings, env: Env, atStorageBase = false): Promise<Response> {
  const p = parsePath(rawPath, s)
  const path = 'path' in p ? p.path : undefined
  if (path && isPrivate(path)) return privateRead(req, path, s, env)
  // With a token, any valid one whatever its scopes, the read bypasses caches (it comes from R2,
  // which is strongly consistent). An invalid token gets 401.
  const fresh = atStorageBase && hasBearer(req) && await authenticate(req, s, env)
  checkRead(req)
  return readFile(req, path, s, env, fresh ? FRESH_READ : atStorageBase ? PUBLIC_READ : {})
}

/**
 * RFC-6 "Private areas": decides before it looks for the file, so that nobody who may not read it
 * learns whether it exists. Every response, errors included, is kept out of caches.
 */
async function privateRead(req: Request, path: string, s: Settings, env: Env): Promise<Response> {
  try {
    checkRead(req)
    if (!hasBearer(req)) throw new HttpError(401, 'invalid_token', 'Private files need a bearer token', { 'WWW-Authenticate': 'Bearer' })
    requireScope(await authenticate(req, s, env), path, true)
    return await readFile(req, path, s, env, FRESH_READ)
  } catch (e) {
    if (e instanceof HttpError) Object.assign(e.headers, PRIVATE_ERROR)
    throw e
  }
}

/** `extra` headers replace or add to the file headers. */
async function readFile(req: Request, path: string | undefined, s: Settings, env: Env, extra: Record<string, string>): Promise<Response> {
  const type = path && fileType(path)
  if (!type) throw new HttpError(404, 'not_found', 'Not found')
  const key = keyOf(path)
  const headers = new Headers({ ...fileHeaders(servedType(type)), ...extra })

  if (req.method == 'HEAD') {
    const obj = await env.FILES.head(key)
    if (!obj) throw new HttpError(404, 'not_found', 'Not found')
    headers.set('ETag', obj.httpEtag)
    headers.set('Last-Modified', obj.uploaded.toUTCString())
    headers.set('Content-Length', String(obj.size))
    const links = await feedLinks(path!, obj.customMetadata?.kept == 'true', s, env)
    if (links) headers.set('Link', links)
    return new Response(null, { headers })
  }

  const obj = await env.FILES.get(key, { onlyIf: req.headers, range: req.headers })
  if (!obj) throw new HttpError(404, 'not_found', 'Not found')
  headers.set('ETag', obj.httpEtag)
  const links = await feedLinks(path!, obj.customMetadata?.kept == 'true', s, env)
  if (links) headers.set('Link', links)
  headers.set('Last-Modified', obj.uploaded.toUTCString())
  if (!('body' in obj)) {
    // A failed precondition: 304 for If-None-Match / If-Modified-Since, 412 otherwise.
    const notModified = req.headers.has('if-none-match') || req.headers.has('if-modified-since')
    return new Response(null, { status: notModified ? 304 : 412, headers })
  }
  const range = obj.range as { offset?: number; length?: number; suffix?: number } | undefined
  if (req.headers.has('range') && range) {
    const offset = range.suffix != undefined ? Math.max(0, obj.size - range.suffix) : range.offset ?? 0
    const length = Math.min(range.suffix != undefined ? obj.size - offset : range.length ?? obj.size - offset, obj.size - offset)
    if (offset || length < obj.size) {
      headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`)
      return new Response(obj.body, { status: 206, headers })
    }
  }
  return new Response(obj.body, { headers })
}
