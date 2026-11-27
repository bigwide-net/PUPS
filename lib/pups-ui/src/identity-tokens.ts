/**
 * Identity tokens (RFC-10), the parts that the TypeScript servers share: the scope, the checks of a token exchange
 * request (RFC 8693), the signing key, the JWK Set (RFC 7517) and the token, a JWT as in RFC 9068, signed with RS256.
 * Only Web Crypto, so that it runs on Workers, Bunny and Node. Each server keeps the key and the log in its own storage,
 * where no app can write, and answers the token exchange at its token endpoint.
 */

export const IDENTITY_SCOPE = 'identity-tokens'
export const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange'
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token'
export const JWT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt'
/** Seconds: RFC-10 recommends 60, and allows at most 300. */
export const IDENTITY_TOKEN_TTL = 60
/** Seconds that a read token lives, for fetching personal feeds (RFC-10 "Read tokens": at most 86,400, recommended). */
export const READ_TOKEN_TTL = 86_400
/** Identity tokens per grant and minute; more get 429. */
export const IDENTITY_TOKENS_PER_MINUTE = 60
/** How long the log of issued tokens is kept (RFC-10 "Log": at least 30 days). */
export const IDENTITY_LOG_MS = 30 * 24 * 3600_000
/** Seconds that verifiers may cache the JWK Set (RFC-10: at most 3600). */
export const JWKS_MAX_AGE = 600
/** Where the servers publish the JWK Set, on the issuer's host. It is never a path that apps can write. */
export const JWKS_PATH = '/pups/jwks.json'

const enc = new TextEncoder()
const b64url = (bytes: Uint8Array | ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64json = (value: unknown) => b64url(enc.encode(JSON.stringify(value)))
const random = (bytes: number) => b64url(crypto.getRandomValues(new Uint8Array(bytes)))

/** A submitted form: URLSearchParams or FormData. */
export interface ExchangeForm {
  get(name: string): unknown
  getAll(name: string): unknown[]
  has(name: string): boolean
}

export type OAuthFailure = { error: string; description: string }

/**
 * Whether `value` is an audience that RFC-10 allows: exactly one https origin as the URL parser writes it (lowercase
 * host in ASCII form, a port only if it isn't 443), without path, `/`, query, user info or fragment, and not a local
 * name or an IP address.
 */
export function isAudience(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  const host = url.hostname
  return url.protocol == 'https:' && value == url.origin && !url.username && !url.password
    && host != 'localhost' && !/\.(local|localhost)$/.test(host) && !host.startsWith('[') && !/^[\d.]+$/.test(host) && host.includes('.')
}

/**
 * Checks a token exchange request (RFC-10 "Token exchange"), apart from the subject token, which the server looks up:
 * an access token as subject, no `resource`, `actor_token` or other `requested_token_type` than a JWT, one audience, and
 * no `scope` but `read`, which asks for a read token.
 */
export function exchangeRequest(form: ExchangeForm): { subjectToken: string; audience: string; read: boolean } | OAuthFailure {
  const subjectToken = form.get('subject_token')
  if (typeof subjectToken != 'string' || !subjectToken) return { error: 'invalid_request', description: 'subject_token is required' }
  if (form.get('subject_token_type') != ACCESS_TOKEN_TYPE)
    return { error: 'invalid_request', description: `subject_token_type must be ${ACCESS_TOKEN_TYPE}` }
  for (const name of ['resource', 'actor_token', 'actor_token_type'])
    if (form.has(name)) return { error: 'invalid_request', description: `${name} is not supported` }
  const scopes = form.getAll('scope')
  if (scopes.length > 1 || scopes.length && scopes[0] != 'read') return { error: 'invalid_scope', description: 'scope may only be read, for a read token' }
  if (form.has('requested_token_type') && form.get('requested_token_type') != JWT_TOKEN_TYPE)
    return { error: 'invalid_request', description: `requested_token_type must be ${JWT_TOKEN_TYPE}` }
  const audiences = form.getAll('audience')
  if (audiences.length != 1 || typeof audiences[0] != 'string' || !isAudience(audiences[0]))
    return { error: 'invalid_target', description: 'audience must be one https origin, such as https://polls.example.com, without a path' }
  return { subjectToken, audience: audiences[0], read: !!scopes.length }
}

/** The server's signing key: an RSA key pair, as JWKs, which the server stores where nothing serves it. */
export interface SigningKey {
  kid: string
  createdAt: number
  privateJwk: JsonWebKey
  publicJwk: JsonWebKey
}

const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }

/** A new RSA key pair of 2048 bits, named by its date and a random suffix, e.g. `2026-11-27-Xa9q2w`. */
export async function newSigningKey(now = Date.now()): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey({ ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['sign', 'verify']) as CryptoKeyPair
  return {
    kid: `${new Date(now).toISOString().slice(0, 10)}-${random(6)}`,
    createdAt: now,
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey,
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey,
  }
}

/** The JWK Set with the public keys. */
export const jwkSet = (keys: SigningKey[]) => ({
  keys: keys.map(k => ({ kty: 'RSA', use: 'sig', alg: 'RS256', kid: k.kid, n: k.publicJwk.n, e: k.publicJwk.e })),
})

/** Answers a request for the JWK Set: public, with CORS, cacheable for JWKS_MAX_AGE. */
export function jwksResponse(method: string, keys: SigningKey[]): Response {
  const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, OPTIONS' }
  if (method == 'OPTIONS') return new Response(null, { status: 204, headers })
  if (method != 'GET' && method != 'HEAD')
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: { ...headers, allow: 'GET, HEAD, OPTIONS', 'content-type': 'application/json' } })
  const body = JSON.stringify(jwkSet(keys))
  return new Response(method == 'HEAD' ? null : body, {
    headers: { ...headers, 'content-type': 'application/json', 'cache-control': `public, max-age=${JWKS_MAX_AGE}`, 'x-content-type-options': 'nosniff' },
  })
}

export interface IdentityClaims {
  /** The PUPS server's `issuer`. */
  iss: string
  /** The owner's `me`, `https://<host>/`. */
  sub: string
  aud: string
  client_id: string
}

/**
 * Signs an identity token (RFC-10 "The token"), valid for IDENTITY_TOKEN_TTL seconds; with `read`, a read token, with
 * `"scope": "read"`, valid for READ_TOKEN_TTL seconds.
 */
export async function signIdentityToken(key: SigningKey, claims: IdentityClaims, read = false, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000)
  const payload = { ...claims, ...read && { scope: 'read' }, iat, exp: iat + (read ? READ_TOKEN_TTL : IDENTITY_TOKEN_TTL), jti: random(16) }
  const input = `${b64json({ typ: 'at+jwt', alg: 'RS256', kid: key.kid })}.${b64json(payload)}`
  const privateKey = await crypto.subtle.importKey('jwk', key.privateJwk, RSA, false, ['sign'])
  return `${input}.${b64url(await crypto.subtle.sign(RSA.name, privateKey, enc.encode(input)))}`
}

/** The token endpoint's answer to a token exchange (RFC 8693); for a read token with its `scope`. */
export const exchangeResponse = (token: string, read = false) => ({
  access_token: token, issued_token_type: JWT_TOKEN_TYPE, token_type: 'Bearer',
  expires_in: read ? READ_TOKEN_TTL : IDENTITY_TOKEN_TTL, ...read && { scope: 'read' },
})

/** A logged identity token: when, for which app, for which audience, and whether it was a read token. */
export interface IdentityLogEntry {
  at: number
  clientId: string
  audience: string
  read?: boolean
}

/** Where an app acted as the owner: per audience, how often (`reads` of them read tokens) and when it last did, the latest first. */
export interface IdentityUse {
  audience: string
  count: number
  reads: number
  last: number
}

/** The uses of the app `clientId`, from the log. */
export function identityUses(log: IdentityLogEntry[], clientId: string): IdentityUse[] {
  const uses = new Map<string, IdentityUse>()
  for (const e of log.filter(e => e.clientId == clientId)) {
    const u = uses.get(e.audience) ?? { audience: e.audience, count: 0, reads: 0, last: 0 }
    uses.set(e.audience, { ...u, count: u.count + 1, reads: u.reads + (e.read ? 1 : 0), last: Math.max(u.last, e.at) })
  }
  return [...uses.values()].sort((a, b) => b.last - a.last)
}
