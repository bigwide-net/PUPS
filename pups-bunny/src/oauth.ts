import * as ui from 'pups-ui'
import { errorPage } from 'pups-ui'
import { passkeyGetOptions, session, verifyCredential } from './auth'
import { type Client, ClientError, loadClient, redirectUriAllowed } from './cimd'
import { hashToken, randomToken, s256, sign, verify } from './crypto'
import { onGrantRevoked } from './hostmeta'
import { HttpError, json, methodNotAllowed, readForm, readQuery } from './http'
import { loginPage } from './owner'
import { isPrivate, needsStepUp, parseScope, parseScopes, type Scope } from './paths'
import { CONFIG_PATH, type Env, type Settings, SPEC_VERSION, store } from './settings'
import { ACCESS_TTL } from './state'

// --- Discovery documents ---------------------------------------------------------------

export const endpoints = (s: Settings) => ({
  authorization_endpoint: `${s.issuer}/oauth/authorize`,
  token_endpoint: `${s.issuer}/oauth/token`,
  revocation_endpoint: `${s.issuer}/oauth/revoke`,
})

/** The PUPS configuration document. */
export const configDocument = (s: Settings) => ({
  issuer: s.issuer,
  ...endpoints(s),
  storage_base: s.storageBase,
  public_base: s.publicBase,
  scopes_supported: ['identify', 'write:/appdata/'],
  well_known_paths: s.wellKnown.map(e => ({
    path: e.path,
    ...e.url && { url: e.url },
    ...e.rels.length && { rels: e.rels },
    ...e.properties.length && { properties: e.properties },
    ...e.linkProperties.length && { link_properties: e.linkProperties },
  })),
  host_meta_endpoint: `${s.ownerOrigin}/pups/host-meta`,
  ...s.postFallback && { post_endpoint: `${s.ownerOrigin}/pups/post` },
  max_upload_bytes: s.maxUploadBytes,
  spec_version: SPEC_VERSION,
})

/** RFC 8414 metadata, for generic OAuth tooling. */
export const oauthMetadata = (s: Settings) => ({
  issuer: s.issuer,
  ...endpoints(s),
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  revocation_endpoint_auth_methods_supported: ['none'],
  authorization_response_iss_parameter_supported: true,
  client_id_metadata_document_supported: true,
  scopes_supported: ['identify', 'write:/appdata/', ...s.wellKnown.map(e => `write:${e.path}`),
    ...s.wellKnown.filter(e => isPrivate(e.path)).map(e => `read:${e.path}`)],
  service_documentation: `${s.ownerOrigin}${CONFIG_PATH}`,
})

// --- Authorization endpoint ----------------------------------------------------------------

/** A validated authorization request, carried through the consent form as a signed field. */
interface AuthRequest {
  t: 'authz'
  clientId: string
  clientHost: string
  clientName?: string
  logo?: string
  redirectUri: string
  state?: string
  codeChallenge: string
  scope: string
  sid?: string
  nonce: string
  exp: number
}

const REQUEST_TTL = 15 * 60_000

function redirectTo(redirectUri: string, params: Record<string, string | undefined>, status = 302): Response {
  const u = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v != undefined) u.searchParams.set(k, v)
  return new Response(null, { status, headers: { location: u.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
}

export async function authorize(req: Request, s: Settings, env: Env): Promise<Response> {
  if (!await store(env).ownerExists()) return ui.notSetUpPage(s)
  if (req.method == 'POST') return authorizeDecision(req, s, env)
  if (req.method != 'GET') return errorPage('Method not allowed', 'Use GET or POST.', 405)

  const url = new URL(req.url)
  const q = readQuery(req)
  const clientId = q.get('client_id')
  const redirectUri = q.get('redirect_uri')
  // Invalid clients and redirect URIs get an error page, never a redirect (no open redirector).
  if (!clientId) return errorPage('Invalid request', 'client_id is missing.')
  let client: Client
  try {
    client = await loadClient(clientId, s, env)
  } catch (e) {
    if (e instanceof ClientError) return errorPage('Invalid app', e.message)
    throw e
  }
  if (!redirectUri || !redirectUriAllowed(client, redirectUri))
    return errorPage('Invalid redirect URI', "redirect_uri is not listed in the app's client metadata document.")

  const state = q.get('state') ?? undefined
  const fail = (error: string, description: string) =>
    redirectTo(redirectUri, { error, error_description: description, state, iss: s.issuer })
  if (q.get('response_type') != 'code') return fail('unsupported_response_type', 'response_type must be code')
  const codeChallenge = q.get('code_challenge')
  if (!codeChallenge || q.get('code_challenge_method') != 'S256') return fail('invalid_request', 'PKCE with S256 is required')
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) return fail('invalid_request', 'Invalid code_challenge')
  const scope = q.get('scope') ?? ''
  const scopes = parseScopes(scope, client.clientHost, s)
  if (!scopes) return fail('invalid_scope',
    "Only identify, the app's own directory, declared well-known paths and read scopes for declared private paths can be requested")

  const sid = await session(req, s, env)
  if (s.subdomainMode && !sid) return loginPage(s, env, url.pathname + url.search)

  const ar: AuthRequest = {
    t: 'authz', clientId, clientHost: client.clientHost, clientName: client.name, logo: client.logo, redirectUri, state,
    codeChallenge, scope: [...scopes.keys()].join(' '), sid: sid ?? undefined, nonce: randomToken(16), exp: Date.now() + REQUEST_TTL,
  }

  // With an owner session, a request that an existing grant covers and that contains no
  // well-known scope is approved without the consent screen.
  if (sid && ![...scopes.values()].some(x => needsStepUp(x, client.clientHost))) {
    const grants = (await store(env).activeGrants()).filter(g => g.clientId == clientId)
    if (grants.some(g => [...scopes.keys()].every(x => g.scope.split(' ').includes(x)))) return issueCode(ar, ar.scope, s, env, 302)
  }
  return consentPage(ar, scopes, s, env)
}

/** A grant's permissions on the apps page, grouped as on the consent screen. */
export const permissionList = (scope: string, clientHost: string, s: Settings) =>
  ui.permissionList(scope.split(' ').map((str): [string, Scope | undefined] => [str, parseScope(str, clientHost, s)]), s.ownerHost)

async function consentPage(ar: AuthRequest, scopes: Map<string, Scope>, s: Settings, env: Env, error?: string, status = 200) {
  const db = store(env)
  const [secret, approvedBefore, owner] = await Promise.all([db.secret(), db.clientApproved(ar.clientId), db.owner()])
  // Same-domain mode has no sessions, so every approval is confirmed; otherwise only step-up scopes need it.
  const needsConfirm = !s.subdomainMode || [...scopes.values()].some(x => needsStepUp(x, ar.clientHost))
  return ui.consentPage({
    clientHost: ar.clientHost, clientName: ar.clientName, logo: ar.logo, redirectUri: ar.redirectUri, ownerHost: s.ownerHost,
    scopes, approvedBefore, request: await sign(ar, secret), error, status,
    confirm: needsConfirm ? { passkeyOptions: await passkeyGetOptions(s, env), hasPassword: !!owner?.passwordHash } : undefined,
  })
}

async function authorizeDecision(req: Request, s: Settings, env: Env): Promise<Response> {
  const db = store(env)
  const form = await readForm(req)
  const ar = await verify<AuthRequest>(form.get('request') as string | null, await db.secret())
  if (!ar || ar.t != 'authz') return errorPage('Request expired', 'This authorization request is invalid or has expired. Please start again from the app.')
  const sid = await session(req, s, env)
  if (s.subdomainMode && (!sid || sid != ar.sid)) return errorPage('Not signed in', 'Your session has ended. Please start again from the app.', 403)
  if (form.get('decision') != 'approve')
    return redirectTo(ar.redirectUri, { error: 'access_denied', state: ar.state, iss: s.issuer }, 303)

  const scopes = parseScopes(ar.scope, ar.clientHost, s)!
  // A group's checkbox carries all of its scopes, separated by spaces.
  const chosen = new Set(form.getAll('scope').flatMap(v => String(v).split(' ')))
  const granted = new Map([...scopes].filter(([k]) => chosen.has(k)))
  // Dropping every scope counts as denial.
  if (!granted.size) return redirectTo(ar.redirectUri, { error: 'access_denied', state: ar.state, iss: s.issuer }, 303)

  const stepUp = [...granted.values()].some(x => needsStepUp(x, ar.clientHost))
  if (!s.subdomainMode || stepUp) {
    const err = await verifyCredential(form, s, env)
    if (err) return consentPage(ar, scopes, s, env, err, 401)
  }
  if (!await db.useNonce(ar.nonce, REQUEST_TTL)) return errorPage('Already answered', 'This authorization request was already approved.')
  return issueCode(ar, [...granted.keys()].join(' '), s, env, 303)
}

async function issueCode(ar: AuthRequest, scope: string, s: Settings, env: Env, status: number): Promise<Response> {
  const code = randomToken()
  await store(env).createCode(await hashToken(code), {
    clientId: ar.clientId, clientHost: ar.clientHost, clientName: ar.clientName ?? null, redirectUri: ar.redirectUri,
    codeChallenge: ar.codeChallenge, scope,
  })
  return redirectTo(ar.redirectUri, { code, state: ar.state, iss: s.issuer }, status)
}

// --- Token endpoint --------------------------------------------------------------------

const noStore = { 'cache-control': 'no-store', pragma: 'no-cache' }
const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status, noStore)

async function readTokenForm(req: Request): Promise<FormData> {
  if (req.method != 'POST') throw methodNotAllowed('POST, OPTIONS')
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/x-www-form-urlencoded'))
    throw new HttpError(400, 'invalid_request', 'The body must be application/x-www-form-urlencoded')
  return readForm(req)
}

const str = (form: FormData, name: string) => {
  const v = form.get(name)
  return typeof v == 'string' && v ? v : undefined
}

const tokenResponse = (t: { access: string; refresh: string | null }, scope: string, s: Settings) => json({
  access_token: t.access,
  token_type: 'Bearer',
  expires_in: ACCESS_TTL / 1000,
  ...t.refresh && { refresh_token: t.refresh },
  scope,
  me: s.me,
}, 200, noStore)


export async function token(req: Request, s: Settings, env: Env): Promise<Response> {
  const form = await readTokenForm(req)
  const clientId = str(form, 'client_id')
  if (!clientId) return oauthError('invalid_request', 'client_id is required')
  const db = store(env)

  switch (form.get('grant_type')) {
    case 'authorization_code': {
      const code = str(form, 'code'), redirectUri = str(form, 'redirect_uri'), verifier = str(form, 'code_verifier')
      if (!code || !redirectUri || !verifier) return oauthError('invalid_request', 'code, redirect_uri and code_verifier are required')
      if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return oauthError('invalid_grant', 'Invalid code_verifier')
      const r = await db.redeemCode(await hashToken(code), clientId, redirectUri, await s256(verifier))
      if (!r.ok) return oauthError(r.error, r.description)
      return tokenResponse(r.tokens, r.grant.scope, s)
    }
    case 'refresh_token': {
      const refresh = str(form, 'refresh_token')
      if (!refresh) return oauthError('invalid_request', 'refresh_token is required')
      const r = await db.refresh(refresh, clientId)
      if (!r.ok) {
        if (r.revokedClient) await onGrantRevoked(r.revokedClient, s, env)
        return oauthError('invalid_grant', r.revokedClient
          ? 'The refresh token was already used; the grant is revoked'
          : 'Invalid, expired or revoked refresh token')
      }
      const requested = str(form, 'scope')
      if (requested && requested.split(' ').some(x => !r.grant.scope.split(' ').includes(x)))
        return oauthError('invalid_scope', "The scope can't grow through a refresh")
      return tokenResponse(r.tokens, r.grant.scope, s)
    }
    default:
      return oauthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token')
  }
}

// --- Revocation endpoint (RFC 7009) ----------------------------------------------------

export async function revoke(req: Request, s: Settings, env: Env): Promise<Response> {
  const form = await readTokenForm(req)
  const t = str(form, 'token'), clientId = str(form, 'client_id')
  if (!t || !clientId) return oauthError('invalid_request', 'token and client_id are required')
  const revokedClient = await store(env).revokeToken(t, clientId)
  if (revokedClient) await onGrantRevoked(revokedClient, s, env)
  // Unknown tokens get 200 too (RFC 7009).
  return new Response(null, { status: 200, headers: noStore })
}
