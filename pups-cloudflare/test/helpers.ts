import { exports } from 'cloudflare:workers'
import { expect, vi } from 'vitest'
import { randomToken, s256 } from '../src/crypto'
import worker from '../src/index'

export const ORIGIN = 'https://tim.example.com'
export const PASSWORD = 'correct horse battery staple'

let envOverride: object | undefined
/** Runs every following call() with this environment instead of the configured one. */
export const useEnv = (env: object | undefined) => envOverride = env

/** Every response is checked: same-domain mode never sets a cookie. */
export async function call(path: string, init?: RequestInit): Promise<Response> {
  const req = new Request(path.startsWith('http') ? path : ORIGIN + path, init)
  const res: Response = await (envOverride ? worker.fetch(req as any, envOverride as any) : (exports as any).default.fetch(req))
  expect(res.headers.get('set-cookie'), `cookie on ${path}`).toBeNull()
  return res
}

export const form = (pairs: Record<string, string> | [string, string][]) =>
  new URLSearchParams(Array.isArray(pairs) ? pairs : Object.entries(pairs))

export interface TestClient {
  clientId: string
  redirectUri: string
  host: string
}

const clientDocs = new Map<string, unknown>()
export const cimdFetches: string[] = []

/** Serves client metadata documents in place of the network. */
export function mockClientFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = typeof input == 'string' ? input : input instanceof URL ? input.href : input.url
    cimdFetches.push(url)
    const doc = clientDocs.get(url)
    return doc ? Response.json(doc) : new Response('not found', { status: 404 })
  })
}

export function registerClient(host: string, extra: object = {}): TestClient {
  const clientId = `https://${host}/oauth/client.json`
  const redirectUri = `https://${host}/callback`
  clientDocs.set(clientId, { client_id: clientId, client_name: 'Test App', redirect_uris: [redirectUri], ...extra })
  return { clientId, redirectUri, host }
}

export async function setupOwner() {
  let r = await call('/pups/setup', { method: 'POST', body: form({ step: 'secret', secret: 'test-bootstrap-secret' }) })
  if (r.status == 404) return
  expect(r.status).toBe(200)
  const token = /name="setup" value="([^"]+)"/.exec(await r.text())![1]
  r = await call('/pups/setup', { method: 'POST', body: form({ setup: token, new_password: PASSWORD, new_password2: PASSWORD }) })
  expect(r.status).toBe(200)
}

export async function pkce() {
  const verifier = randomToken(32)
  return { verifier, challenge: await s256(verifier) }
}

export function authorizeUrl(c: TestClient, scope: string, challenge: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({
    response_type: 'code', client_id: c.clientId, redirect_uri: c.redirectUri, scope, state: 'xyz',
    code_challenge: challenge, code_challenge_method: 'S256', ...extra,
  })
  return `/oauth/authorize?${q}`
}

export const signedRequest = (html: string) => /name="request" value="([^"]+)"/.exec(html)![1]

/** Runs the authorization request and approves it. Returns the redirect to the app. */
export async function approve(c: TestClient, scope: string, opts: { grant?: string[]; password?: string } = {}) {
  const { verifier, challenge } = await pkce()
  const page = await call(authorizeUrl(c, scope, challenge))
  expect(page.status).toBe(200)
  const pairs: [string, string][] = [['request', signedRequest(await page.text())], ['decision', 'approve'],
    ['password', opts.password ?? PASSWORD]]
  for (const sc of opts.grant ?? scope.split(' ')) pairs.push(['scope', sc])
  const res = await call('/oauth/authorize', { method: 'POST', body: form(pairs), redirect: 'manual' })
  return { res, verifier }
}

export async function exchange(c: TestClient, code: string, verifier: string) {
  return call('/oauth/token', {
    method: 'POST',
    body: form({ grant_type: 'authorization_code', code, client_id: c.clientId, redirect_uri: c.redirectUri, code_verifier: verifier }),
  })
}

/** Connects an app: authorization, approval and code exchange. Returns the token response. */
export async function connect(c: TestClient, scope: string, grant?: string[]) {
  const { res, verifier } = await approve(c, scope, { grant })
  expect(res.status).toBe(303)
  const code = new URL(res.headers.get('location')!).searchParams.get('code')!
  const t = await exchange(c, code, verifier)
  expect(t.status).toBe(200)
  return await t.json() as { access_token: string; refresh_token?: string; scope: string; me: string; expires_in: number }
}

export const bearer = (token: string, headers: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...headers })

export const put = (path: string, token: string, body: BodyInit, headers: Record<string, string> = {}) =>
  call(`/files${path}`, { method: 'PUT', body, headers: bearer(token, { 'content-type': 'application/json', ...headers }) })
