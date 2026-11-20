import { readLimited } from './http'
import { isCleanUrlString, isHostName, sanitizeText } from 'pups-ui'
import { type Settings, type Env, store } from './settings'

/** A validated client metadata document. */
export interface Client {
  clientId: string
  /** The host of client_id: the only verified fact about the app. */
  clientHost: string
  name?: string
  uri?: string
  logo?: string
  redirectUris: string[]
}

export class ClientError extends Error {}

const MAX_DOC_BYTES = 64 * 1024
const FETCH_TIMEOUT = 5000
const MAX_CACHE_SECONDS = 24 * 3600
const MAX_REDIRECT_URIS = 20
/** client_name may have this many characters; at most 100 are shown. */
const MAX_NAME_CHARS = 1000

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

/** Validates a client_id URL. It must already be in canonical form. */
export function parseClientId(clientId: string, s: Settings): URL {
  let u: URL
  try {
    u = new URL(clientId)
  } catch {
    throw new ClientError('client_id is not a URL')
  }
  if (u.protocol != 'https:') throw new ClientError('client_id must be an HTTPS URL')
  if (u.username || u.password || u.port || u.search || u.hash || clientId.includes('?') || clientId.includes('#'))
    throw new ClientError('client_id must not contain user info, a port, a query or a fragment')
  if (u.pathname == '/') throw new ClientError('client_id must have a path')
  // The canonical serialization catches uppercase hosts, dot segments and other variants.
  if (u.href != clientId) throw new ClientError('client_id is not in canonical form (lowercase host, normalized path)')
  const host = u.hostname
  if (IPV4.test(host) || host.startsWith('[') || !host.includes('.') || host == 'localhost' || host.endsWith('.localhost'))
    throw new ClientError('client_id must be on a public domain name')
  if (!isHostName(host)) throw new ClientError('The host of client_id may contain only letters, digits, hyphens and dots (IDNs in punycode)')
  if (host == s.ownerHost || host == s.authHost) throw new ClientError("client_id can't be on this server's own host")
  return u
}

/** client_uri and logo_uri must be on the client host, with or without a leading `www.`. */
export function onClientHost(url: string, clientHost: string): boolean {
  if (!isCleanUrlString(url)) return false
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol != 'https:' || u.username || u.password) return false
  const h = u.host
  return h == clientHost || h == `www.${clientHost}` || (clientHost.startsWith('www.') && h == clientHost.slice(4))
}

const isLoopback = (u: URL) => u.protocol == 'http:' && (u.hostname == '127.0.0.1' || u.hostname == '[::1]')

function validRedirectUri(r: unknown): r is string {
  if (!isCleanUrlString(r)) return false
  try {
    const u = new URL(r)
    return !u.hash && (u.protocol == 'https:' && isHostName(u.hostname) || isLoopback(u))
  } catch {
    return false
  }
}

/** Validates a fetched client metadata document. */
export function validateMetadata(doc: any, clientId: string): Client {
  const clientHost = new URL(clientId).host
  if (!doc || typeof doc != 'object' || Array.isArray(doc)) throw new ClientError('The client metadata document is not a JSON object')
  if (doc.client_id !== clientId) throw new ClientError('client_id in the client metadata document does not match its URL')
  const redirectUris = doc.redirect_uris
  if (!Array.isArray(redirectUris) || !redirectUris.length || redirectUris.length > MAX_REDIRECT_URIS || !redirectUris.every(validRedirectUri))
    throw new ClientError(`redirect_uris must be a non-empty array of at most ${MAX_REDIRECT_URIS} HTTPS URLs with a DNS host name, or loopback URLs, without whitespace or control characters, each at most 2048 characters`)
  for (const field of ['client_uri', 'logo_uri']) {
    if (doc[field] == undefined) continue
    if (typeof doc[field] != 'string' || !onClientHost(doc[field], clientHost))
      throw new ClientError(`${field} must be on the client host ${clientHost} (optionally with or without www.)`)
  }
  if (doc.client_name != undefined && (typeof doc.client_name != 'string' || doc.client_name.length > MAX_NAME_CHARS))
    throw new ClientError(`client_name must be a string of at most ${MAX_NAME_CHARS} characters`)
  if (doc.token_endpoint_auth_method != undefined && doc.token_endpoint_auth_method != 'none')
    throw new ClientError('Only public clients (token_endpoint_auth_method "none") are supported')
  return {
    clientId, clientHost, redirectUris,
    // The name is self-declared text: sanitized for display. URLs are stored in their canonical (ASCII) form.
    name: sanitizeText(doc.client_name, 100),
    uri: doc.client_uri && new URL(doc.client_uri).href, logo: doc.logo_uri && new URL(doc.logo_uri).href,
  }
}

function cacheSeconds(cacheControl: string | null): number {
  if (!cacheControl || /no-store|no-cache|private/i.test(cacheControl)) return 0
  const m = /max-age=(\d+)/i.exec(cacheControl)
  return m ? Math.min(Number(m[1]), MAX_CACHE_SECONDS) : 0
}

/**
 * Fetches (or takes from the cache) and validates a client metadata document. The fetch
 * goes only to public addresses: the `global_fetch_strictly_public` compatibility flag
 * makes the runtime refuse private, loopback and link-local addresses after DNS resolution.
 */
export async function loadClient(clientId: string, s: Settings, env: Env): Promise<Client> {
  parseClientId(clientId, s)
  const db = store(env)
  const cached = await db.cachedClient(clientId)
  if (cached) return validateMetadata(JSON.parse(cached), clientId)

  let res: Response
  try {
    res = await fetch(clientId, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    })
  } catch {
    throw new ClientError(`The client metadata document at ${clientId} could not be fetched`)
  }
  if (res.status >= 300 && res.status < 400) throw new ClientError('The client metadata document must be served without redirects')
  if (res.status != 200) throw new ClientError(`Fetching the client metadata document returned HTTP ${res.status}`)
  const body = await readLimited(res.body, MAX_DOC_BYTES)
  if (!body) throw new ClientError('The client metadata document is larger than 64 KB')
  let doc: unknown
  try {
    doc = JSON.parse(new TextDecoder().decode(body))
  } catch {
    throw new ClientError('The client metadata document is not valid JSON')
  }
  const client = validateMetadata(doc, clientId)
  const ttl = cacheSeconds(res.headers.get('cache-control'))
  if (ttl) await db.cacheClient(clientId, JSON.stringify(doc), ttl * 1000)
  return client
}

/** Exact match; for loopback redirect URIs the port is ignored (RFC 8252). */
export function redirectUriAllowed(client: Client, redirectUri: string): boolean {
  if (client.redirectUris.includes(redirectUri)) return true
  let req: URL
  try {
    req = new URL(redirectUri)
  } catch {
    return false
  }
  if (!isLoopback(req) || req.href != redirectUri) return false
  req.port = ''
  return client.redirectUris.some(r => {
    const reg = new URL(r)
    if (!isLoopback(reg)) return false
    reg.port = ''
    return reg.href == req.href
  })
}
