import { hasUnsafeChars, IDENTITY_SCOPE, isPrivate } from 'pups-ui'
import type { Settings, WellKnownEntry } from './settings'

export const MAX_PATH_BYTES = 512
/** At most this many scopes in one request. */
export const MAX_SCOPES = 20

const isDeclaredWellKnownFile = (path: string, s: Settings) =>
  path.startsWith('/.well-known/') && s.wellKnown.some(e => e.path == path)

/**
 * Validates a storage path (RFC-6 "Paths"). `raw` is percent-encoded and starts with `/`.
 * Returns the decoded, normalized path, or an error message.
 */
export function parsePath(raw: string, s: Settings): { path: string } | { error: string } {
  if (raw.length > 3 * MAX_PATH_BYTES) return { error: `The path is longer than ${MAX_PATH_BYTES} bytes` }
  let path: string
  try {
    path = decodeURIComponent(raw)
  } catch {
    return { error: 'The path is not valid percent-encoded UTF-8' }
  }
  if (!path.startsWith('/')) return { error: 'The path must start with /' }
  if (new TextEncoder().encode(path).byteLength > MAX_PATH_BYTES) return { error: `The path is longer than ${MAX_PATH_BYTES} bytes` }
  if (path.endsWith('/')) return { error: 'The path ends with /' }
  // Bidi controls and other invisible characters too: they can disguise a file name (`gpj.exe`).
  if (/[\\:]/.test(path) || hasUnsafeChars(path)) return { error: 'The path contains a backslash, colon, or a control or invisible character' }
  const segments = path.slice(1).split('/')
  for (const seg of segments) {
    if (!seg) return { error: 'The path has an empty segment' }
    if (seg == '.' || seg == '..') return { error: 'The path has a dot segment' }
    if (seg.endsWith('.') || seg.endsWith(' ')) return { error: 'A path segment ends with a dot or a space' }
  }
  if (segments.some(seg => seg.startsWith('.')) && !isDeclaredWellKnownFile(path, s))
    return { error: 'A path segment starts with a dot' }
  return { path }
}

export type Scope = { kind: 'identify' } | { kind: 'identity-tokens' }
  | { kind: 'write'; prefix: string; wellKnown?: WellKnownEntry }
  | { kind: 'read'; prefix: string; wellKnown: WellKnownEntry }

const SCOPE_SYNTAX = /^(read|write):(\/(?:[A-Za-z0-9\-._~\/]|%[0-9A-Fa-f]{2})*)$/

export { isPrivate } from 'pups-ui'


/** The app's own directory. */
export const appdataPrefix = (clientHost: string) => `/appdata/${clientHost}/`

/**
 * Parses one scope string for a client. Returns undefined if the scope is invalid: only
 * `identify`, `identity-tokens` (RFC-10), the app's own directory, declared well-known paths
 * and, with `read:`, declared private paths in /pups/private/ exist.
 */
export function parseScope(scope: string, clientHost: string, s: Settings): Scope | undefined {
  if (scope == 'identify') return { kind: 'identify' }
  if (scope == IDENTITY_SCOPE) return { kind: 'identity-tokens' }
  const m = SCOPE_SYNTAX.exec(scope)
  if (!m) return
  let prefix: string
  try {
    prefix = decodeURIComponent(m[2])
  } catch {
    return
  }
  const read = m[1] == 'read'
  if (!read && prefix == appdataPrefix(clientHost)) return { kind: 'write', prefix }
  // Validate the prefix like a path (a directory prefix without its trailing slash).
  const asPath = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  if (!asPath || 'error' in parsePath(encodeURI(asPath), s)) return
  const e = s.wellKnown.find(x => x.path.endsWith('/') ? prefix.startsWith(x.path) : prefix == x.path)
  if (!e) return
  if (!read) return { kind: 'write', prefix, wellKnown: e }
  // The only read scope: a declared private path (public files need none).
  if (isPrivate(e.path)) return { kind: 'read', prefix, wellKnown: e }
}

/** Parses a space-separated scope string. Returns undefined if any scope is invalid. */
export function parseScopes(scope: string, clientHost: string, s: Settings): Map<string, Scope> | undefined {
  const out = new Map<string, Scope>()
  const items = scope.split(' ').filter(Boolean)
  if (items.length > MAX_SCOPES) return
  for (const item of items) {
    const parsed = parseScope(item, clientHost, s)
    if (!parsed) return
    out.set(item, parsed)
  }
  return out.size ? out : undefined
}

/** Does a write scope prefix cover a normalized path? Compares segment by segment. */
export const covers = (prefix: string, path: string) => prefix.endsWith('/') ? path.startsWith(prefix) : path == prefix

const prefixes = (scope: string, kind: string) =>
  scope.split(' ').filter(x => x.startsWith(kind)).map(x => decodeURIComponent(x.slice(kind.length)))

/** Write prefixes of a granted scope string. The granted scope was validated when it was granted. */
export const writePrefixes = (scope: string) => prefixes(scope, 'write:')

/** Read prefixes (`read:`, only for private paths in /pups/private/) of a granted scope string. */
export const readPrefixes = (scope: string) => prefixes(scope, 'read:')

/** May a grant read a private file? A `write:` scope covers reading too. */
export const canReadPrivate = (scope: string, path: string) =>
  [...writePrefixes(scope), ...readPrefixes(scope)].some(prefix => covers(prefix, path))

/**
 * Does a scope need step-up confirmation? Everything but `identify` and the app's own directory does, `identity-tokens`
 * always, so that its consent screen is never skipped (RFC-10 "Scope and consent").
 */
export const needsStepUp = (scope: Scope, clientHost: string) =>
  scope.kind == 'identity-tokens' || scope.kind != 'identify' && scope.prefix != appdataPrefix(clientHost)

/**
 * Can a path hold an uploaded file? Only the app directories and declared well-known
 * paths can be written; everything else in the storage zone (the server's state under
 * /_pups/, host-meta.json) is never served as an upload.
 */
export const servable = (path: string, s: Settings) =>
  path.startsWith('/appdata/') || s.wellKnown.some(e => covers(e.path, path))

/** The public URL of a stored file; private files have none. */
export function publicUrl(path: string, s: Settings): string | undefined {
  if (isPrivate(path)) return
  for (const e of s.wellKnown) {
    if (e.url && covers(e.path, path)) return e.url + path.slice(e.path.length)
  }
  return s.publicBase + path.slice(1)
}

/** Maps a public URL back to a normalized storage path, or undefined. */
export function pathFromPublicUrl(url: string, s: Settings): string | undefined {
  let raw: string | undefined
  for (const e of s.wellKnown) {
    if (e.url && (e.path.endsWith('/') ? url.startsWith(e.url) : url == e.url)) raw = e.path + url.slice(e.url.length)
  }
  if (raw == undefined && url.startsWith(s.publicBase)) raw = '/' + url.slice(s.publicBase.length)
  if (raw == undefined || /[?#]/.test(raw)) return
  const parsed = parsePath(raw, s)
  return 'path' in parsed ? parsed.path : undefined
}
