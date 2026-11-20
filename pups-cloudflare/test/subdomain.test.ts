import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import worker from '../src/index'
import { form, mockClientFetch, PASSWORD, pkce, registerClient, signedRequest, type TestClient } from './helpers'

/** The same Worker in auth subdomain mode: owner pages and OAuth on id.tim.example.com. */
const AUTH = 'https://id.tim.example.com'
const OWNER = 'https://tim.example.com'
const subEnv = { ...env, AUTH_HOST: 'id.tim.example.com' } as any

const call = (url: string, init?: RequestInit) => worker.fetch(new Request(url, init) as any, subEnv)

const app = registerClient('sub-app.example')

async function setupOwner() {
  let r = await call(`${AUTH}/pups/setup`, { method: 'POST', body: form({ step: 'secret', secret: 'test-bootstrap-secret' }) })
  if (r.status == 404) return
  const token = /name="setup" value="([^"]+)"/.exec(await r.text())![1]
  r = await call(`${AUTH}/pups/setup`, { method: 'POST', body: form({ setup: token, new_password: PASSWORD, new_password2: PASSWORD }) })
  expect(r.status).toBe(200)
}

const authorizeUrl = (c: TestClient, scope: string, challenge: string) => `${AUTH}/oauth/authorize?${new URLSearchParams({
  response_type: 'code', client_id: c.clientId, redirect_uri: c.redirectUri, scope, state: 's', code_challenge: challenge,
  code_challenge_method: 'S256',
})}`

let cookie: string

beforeAll(async () => {
  mockClientFetch()
  await setupOwner()
})

describe('auth subdomain mode', () => {
  it('moves the issuer and endpoints, but not the identity or the files', async () => {
    const c = await (await call(`${OWNER}/personal-storage.json`)).json() as any
    expect(c.issuer).toBe(AUTH)
    expect(c.authorization_endpoint).toBe(`${AUTH}/oauth/authorize`)
    expect(c.storage_base).toBe(`${OWNER}/files/`)
    const m = await (await call(`${AUTH}/.well-known/oauth-authorization-server`)).json() as any
    expect(m.issuer).toBe(AUTH)
  })

  it('serves owner pages only on the auth host', async () => {
    expect((await call(`${OWNER}/pups/apps`)).status).toBe(404)
    expect((await call(`${OWNER}/oauth/authorize`)).status).toBe(404)
    expect((await call(`${AUTH}/files/x.json`)).status).toBe(404)
  })

  it('asks for a login, then sets a __Host- session cookie', async () => {
    const { challenge } = await pkce()
    const page = await call(authorizeUrl(app, 'write:/appdata/sub-app.example/', challenge))
    const html = await page.text()
    expect(html).toContain('action="/pups/login"')
    const returnTo = /name="return_to" value="([^"]+)"/.exec(html)![1].replace(/&amp;/g, '&')
    const r = await call(`${AUTH}/pups/login`, { method: 'POST', body: form({ return_to: returnTo, password: PASSWORD }), redirect: 'manual' })
    expect(r.status).toBe(303)
    expect(r.headers.get('location')).toBe(returnTo)
    const setCookie = r.headers.get('set-cookie')!
    expect(setCookie).toMatch(/^__Host-pups_session=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax/)
    cookie = setCookie.split(';')[0]
  })

  it('approves the app\'s own directory without a password, and returns me on the main domain', async () => {
    const { challenge, verifier } = await pkce()
    const page = await call(authorizeUrl(app, 'write:/appdata/sub-app.example/', challenge), { headers: { cookie } })
    const html = await page.text()
    expect(html).not.toContain('name="password"')
    const r = await call(`${AUTH}/oauth/authorize`, {
      method: 'POST', headers: { cookie }, redirect: 'manual',
      body: form([['request', signedRequest(html)], ['decision', 'approve'], ['scope', 'write:/appdata/sub-app.example/']]),
    })
    expect(r.status).toBe(303)
    const loc = new URL(r.headers.get('location')!)
    expect(loc.searchParams.get('iss')).toBe(AUTH)
    const t = await (await call(`${AUTH}/oauth/token`, {
      method: 'POST', body: form({
        grant_type: 'authorization_code', code: loc.searchParams.get('code')!, client_id: app.clientId,
        redirect_uri: app.redirectUri, code_verifier: verifier,
      }),
    })).json() as any
    expect(t.me).toBe(`${OWNER}/`)
    const put = await call(`${OWNER}/files/appdata/sub-app.example/a.json`, {
      method: 'PUT', body: '{}', headers: { authorization: `Bearer ${t.access_token}`, 'content-type': 'application/json' },
    })
    expect(put.status).toBe(201)
  })

  it('skips the consent screen for a request an existing grant covers', async () => {
    const { challenge } = await pkce()
    const r = await call(authorizeUrl(app, 'write:/appdata/sub-app.example/', challenge), { headers: { cookie }, redirect: 'manual' })
    expect(r.status).toBe(302)
    expect(new URL(r.headers.get('location')!).searchParams.get('code')).toBeTruthy()
  })

  it('still requires step-up for well-known scopes', async () => {
    const { challenge } = await pkce()
    const html = await (await call(authorizeUrl(app, 'write:/.well-known/about.md', challenge), { headers: { cookie } })).text()
    expect(html).toContain('name="password"')
    const post = (password: string) => call(`${AUTH}/oauth/authorize`, {
      method: 'POST', headers: { cookie }, redirect: 'manual',
      body: form([['request', signedRequest(html)], ['decision', 'approve'], ['scope', 'write:/.well-known/about.md'], ['password', password]]),
    })
    expect((await post('')).status).toBe(401)
    expect((await post(PASSWORD)).status).toBe(303)
  })

  it('rejects an approval without the session it was issued to', async () => {
    const { challenge } = await pkce()
    const html = await (await call(authorizeUrl(app, 'identify', challenge), { headers: { cookie } })).text()
    const r = await call(`${AUTH}/oauth/authorize`, {
      method: 'POST', redirect: 'manual', body: form([['request', signedRequest(html)], ['decision', 'approve'], ['scope', 'identify']]),
    })
    expect(r.status).toBe(403)
  })

  it('shows the apps page with a session and logs out', async () => {
    expect(await (await call(`${AUTH}/pups/apps`, { headers: { cookie } })).text()).toContain('sub-app.example')
    const r = await call(`${AUTH}/pups/logout`, { method: 'POST', headers: { cookie }, redirect: 'manual' })
    expect(r.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await call(`${AUTH}/pups/apps`, { headers: { cookie }, redirect: 'manual' })).status).toBe(303)
  })

  it('ends every other session when the password changes', async () => {
    expect((await call(`${AUTH}/pups/password`, { redirect: 'manual' })).headers.get('location')).toBe('/pups/login?return_to=%2Fpups%2Fpassword')
    const login = async () => (await call(`${AUTH}/pups/login`, {
      method: 'POST', body: form({ return_to: '/pups/password', password: PASSWORD }), redirect: 'manual',
    })).headers.get('set-cookie')!.split(';')[0]
    const mine = await login(), other = await login()
    const NEW = 'another new password'
    const r = await call(`${AUTH}/pups/password`, {
      method: 'POST', headers: { cookie: mine }, body: form({ password: PASSWORD, new_password: NEW, new_password2: NEW }),
    })
    expect(r.status).toBe(200)
    const fresh = r.headers.get('set-cookie')!.split(';')[0]
    expect((await call(`${AUTH}/pups/apps`, { headers: { cookie: other }, redirect: 'manual' })).status).toBe(303)
    expect((await call(`${AUTH}/pups/apps`, { headers: { cookie: fresh } })).status).toBe(200)
  })
})
