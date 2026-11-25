import { env } from 'cloudflare:workers'
import { expect, vi } from 'vitest'
import { randomToken, s256 } from '../src/crypto'
import worker from '../src/index'
import { store } from '../src/settings'

export const ORIGIN = 'https://tim.example.com'
export const PASSWORD = 'correct horse battery staple'

let envOverride: object | undefined
/** Runs every following call() with this environment instead of the configured one. */
export const useEnv = (env: object | undefined) => envOverride = env
/** Runs every following call() with these variables added; without, with the default environment. */
export const useVars = (vars?: Record<string, string>) => useEnv(vars && { ...env, ...vars })
/** The owner's store, for tests that change the credentials directly. */
export const ownerStore = () => store(env as any)

const pending: Promise<unknown>[] = []
/** The execution context of test requests: work passed to waitUntil() runs until settle(). */
export const testCtx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext

/** Waits for the work that requests left for after their response (e.g. checking webmentions). */
export async function settle() {
  while (pending.length) await pending.shift()
}

/** Every response is checked: same-domain mode never sets a cookie. */
export async function call(path: string, init?: RequestInit): Promise<Response> {
  const req = new Request(path.startsWith('http') ? path : ORIGIN + path, init)
  const res: Response = await worker.fetch(req as any, (envOverride ?? env) as any, testCtx)
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
/** Other documents on the fake network, e.g. the sources of webmentions. */
export const web = new Map<string, { status?: number; headers?: Record<string, string>; body: string }>()

/** Serves client metadata documents and the documents in `web` in place of the network. */
export function mockClientFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = typeof input == 'string' ? input : input instanceof URL ? input.href : input.url
    cimdFetches.push(url)
    const doc = clientDocs.get(url)
    if (doc) return Response.json(doc)
    const w = web.get(url)
    return w ? new Response(w.body, { status: w.status ?? 200, headers: w.headers }) : new Response('not found', { status: 404 })
  })
}

/** A JSON Feed document. */
export const jsonFeed = (items: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'A feed', ...extra, items })

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
