import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  approve, authorizeUrl, bearer, call, cimdFetches, connect, mockClientFetch, ORIGIN, pkce, put, registerClient, setupOwner, useEnv,
} from './helpers'

/** RFC-6 "Private areas", with a declared private directory and a declared private file. */
const INBOX = '/pups/private/inbox/'
const WELL_KNOWN = [
  { path: '/.well-known/about.md', url: `${ORIGIN}/.well-known/about.md`, properties: ['https://bigwide.net/ns/name'] },
  { path: '/pups/images/', url: `${ORIGIN}/pups/images/`, properties: ['https://bigwide.net/ns/avatar'], url_properties: ['https://bigwide.net/ns/avatar'] },
  { path: INBOX, description: 'your inbox' },
  { path: '/pups/private/settings.json' },
]
const privEnv = { ...env, WELL_KNOWN_PATHS: JSON.stringify(WELL_KNOWN) }

const app = registerClient('priv-app.example')
const other = registerClient('priv-other.example')
const reader = registerClient('priv-reader.example')
const writer = registerClient('priv-writer.example')

const NOTES = '/appdata/priv-app.example/private/notes.json'
const MISSING = '/appdata/priv-app.example/private/missing.json'
let appToken: string

const read = (path: string, headers: Record<string, string> = {}, method = 'GET') => call(`/files${path}`, { method, headers })

/** Every response for a private path stays out of caches, errors included. */
function expectPrivate(r: Response, status: number) {
  expect(r.status).toBe(status)
  expect(r.headers.get('cache-control')).toBe(status < 400 ? 'private, no-store' : 'no-store')
  expect(r.headers.get('vary')).toBe('Authorization')
  expect(r.headers.get('access-control-allow-origin')).toBe('*')
}

beforeAll(async () => {
  useEnv(privEnv)
  mockClientFetch()
  await setupOwner()
  appToken = (await connect(app, 'write:/appdata/priv-app.example/')).access_token
  expect((await put(NOTES, appToken, '{"secret":true}')).status).toBe(201)
})
afterAll(() => useEnv(undefined))

describe('the app\'s private folder', () => {
  it('is written and read back with the app\'s token, like a fresh read', async () => {
    for (const method of ['GET', 'HEAD']) {
      const r = await read(NOTES, bearer(appToken), method)
      expectPrivate(r, 200)
      expect(r.headers.get('etag')).toBeTruthy()
      expect(r.headers.get('x-content-type-options')).toBe('nosniff')
      expect(r.headers.get('content-security-policy')).toBe('sandbox')
      if (method == 'GET') expect(await r.text()).toBe('{"secret":true}')
    }
    const etag = (await read(NOTES, bearer(appToken))).headers.get('etag')!
    expectPrivate(await read(NOTES, bearer(appToken, { 'if-none-match': etag })), 304)
  })

  it('answers 401 without a token, before looking for the file', async () => {
    for (const path of [NOTES, MISSING]) for (const headers of [{}, { authorization: 'Basic abc' }] as Record<string, string>[]) {
      const r = await read(path, headers)
      expectPrivate(r, 401)
      expect(r.headers.get('www-authenticate')).toBe('Bearer')
      expect((await r.json() as any).error).toBe('invalid_token')
    }
  })

  it('answers 401 to an invalid token', async () => {
    for (const path of [NOTES, MISSING]) {
      const r = await read(path, bearer('not-a-valid-token'))
      expectPrivate(r, 401)
      expect(r.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"')
    }
  })

  it('answers 403 to a valid token of another app, also for a missing file', async () => {
    const tokens = [(await connect(other, 'write:/appdata/priv-other.example/')).access_token, (await connect(other, 'identify')).access_token]
    for (const t of tokens) for (const path of [NOTES, MISSING]) {
      const r = await read(path, bearer(t))
      expectPrivate(r, 403)
      expect(r.headers.get('www-authenticate')).toBe('Bearer error="insufficient_scope"')
      expect((await r.json() as any).error).toBe('insufficient_scope')
    }
    expect((await put(NOTES, tokens[0], '{}')).status).toBe(403)
  })

  it('answers 404 for a missing file with a covering token', async () => {
    const r = await read(MISSING, bearer(appToken))
    expectPrivate(r, 404)
    expect((await r.json() as any).error).toBe('not_found')
  })

  it('leaves public files of the app public', async () => {
    expect((await put('/appdata/priv-app.example/public.json', appToken, '{}')).status).toBe(201)
    const r = await read('/appdata/priv-app.example/public.json')
    expect([r.status, r.headers.get('cache-control'), r.headers.get('vary')]).toEqual([200, 'no-cache', 'Authorization'])
    // A directory named "private" deeper down is not private.
    expect((await put('/appdata/priv-app.example/x/private/a.json', appToken, '{}')).status).toBe(201)
    expect((await read('/appdata/priv-app.example/x/private/a.json')).status).toBe(200)
  })

  it('is never served at public_base or the domain root without a token, nor by the origin', async () => {
    for (const publicBase of [`${ORIGIN}/pub/`, `${ORIGIN}/`]) {
      useEnv({ ...privEnv, PUBLIC_BASE: publicBase, ORIGIN_FALLBACK: 'true' })
      const url = (path: string) => publicBase + path.slice(1)
      cimdFetches.length = 0
      const r = await call(url(NOTES))
      expectPrivate(r, 401)
      expect(r.headers.get('www-authenticate')).toBe('Bearer')
      expectPrivate(await call(url(NOTES), { headers: bearer('not-a-valid-token') }), 401)
      expectPrivate(await call(url(MISSING), { headers: bearer(appToken) }), 404)
      expectPrivate(await call(url('/pups/private/inbox/x.json')), 401)
      expect(cimdFetches).toEqual([])
      const ok = await call(url(NOTES), { headers: bearer(appToken) })
      expectPrivate(ok, 200)
      expect(await ok.text()).toBe('{"secret":true}')
    }
    // Requests for private paths outside every route don't go to the origin either.
    useEnv({ ...privEnv, ORIGIN_FALLBACK: 'true' })
    cimdFetches.length = 0
    expect((await call(NOTES)).status).toBe(404)
    expect(cimdFetches).toEqual([])
    useEnv(privEnv)
  })

  it('has no public URL and can\'t be linked in host-meta.json', async () => {
    const edit = (token: string, body: object) =>
      call('/pups/host-meta', { method: 'POST', body: JSON.stringify(body), headers: bearer(token, { 'content-type': 'application/json' }) })
    const r = await edit(appToken, { action: 'add', rel: 'https://priv-app.example/rel/notes', href: `${ORIGIN}/files${NOTES}` })
    expect(r.status).toBe(403)
    expect((await r.json() as any).message).toBe("Private files can't be linked")
    expect((await edit(appToken, { action: 'add', rel: 'https://priv-app.example/rel/notes', href: `${ORIGIN}/files/appdata/priv-app.example/public.json` })).status).toBe(201)
    // A URL property can't point to a private file either.
    const t = await connect(app, 'write:/appdata/priv-app.example/ write:/pups/images/')
    expect((await put('/appdata/priv-app.example/private/a.png', t.access_token, new Uint8Array(8), { 'content-type': 'image/png' })).status).toBe(201)
    const avatar = 'https://bigwide.net/ns/avatar'
    expect((await edit(t.access_token, { action: 'set-property', property: avatar, value: `${ORIGIN}/files/appdata/priv-app.example/private/a.png` })).status).toBe(403)
    expect((await edit(t.access_token, { action: 'set-property', property: avatar, value: `${ORIGIN}/files/appdata/priv-app.example/public.json` })).status).toBe(201)
  })
})

describe('private well-known paths', () => {
  let writeToken: string, readToken: string

  beforeAll(async () => {
    writeToken = (await connect(writer, `write:${INBOX}`)).access_token
    const t = await connect(reader, `read:${INBOX}`)
    expect(t.scope).toBe(`read:${INBOX}`)
    readToken = t.access_token
  })

  it('are declared with their path only', async () => {
    const c = await (await call('/personal-storage.json')).json() as any
    expect(c.well_known_paths.slice(2)).toEqual([{ path: INBOX }, { path: '/pups/private/settings.json' }])
    expect(c.scopes_supported).toEqual(['identify', 'write:/appdata/'])
    const m = await (await call('/.well-known/oauth-authorization-server')).json() as any
    expect(m.scopes_supported).toContain(`read:${INBOX}`)
    expect(m.scopes_supported).not.toContain('read:/pups/images/')
  })

  it('can be written and read with write:, and only read with read:', async () => {
    const path = `${INBOX}n1.json`
    expect((await put(path, writeToken, '{"n":1}')).status).toBe(201)
    for (const t of [writeToken, readToken]) {
      const r = await read(path, bearer(t))
      expectPrivate(r, 200)
      expect(await r.text()).toBe('{"n":1}')
    }
    expectPrivate(await read(`${INBOX}missing.json`, bearer(readToken)), 404)
    expect((await put(path, readToken, '{"n":2}')).status).toBe(403)
    expect((await call(`/files${path}`, { method: 'DELETE', headers: bearer(readToken) })).status).toBe(403)
    expect((await call(`/pups/post?method=PUT&path=${encodeURIComponent(path)}`,
      { method: 'POST', body: '{}', headers: bearer(readToken, { 'content-type': 'application/json' }) })).status).toBe(403)
    expectPrivate(await read(path, bearer(appToken)), 403)
    expectPrivate(await read(path), 401)
    expect((await call(`/files${path}`, { method: 'DELETE', headers: bearer(writeToken) })).status).toBe(204)
  })

  it('reject read: scopes for undeclared or public paths', async () => {
    const { challenge } = await pkce()
    for (const scope of ['read:/pups/private/other/', 'read:/pups/private/', 'read:/pups/images/', 'read:/.well-known/about.md',
      'read:/appdata/priv-app.example/', 'read:/appdata/priv-app.example/private/', 'read:/pups/private/settings.json/x']) {
      const r = await call(authorizeUrl(app, scope, challenge), { redirect: 'manual' })
      expect(new URL(r.headers.get('location')!).searchParams.get('error'), scope).toBe('invalid_scope')
    }
    for (const scope of [`read:${INBOX}2026/`, 'read:/pups/private/settings.json', 'write:/pups/private/settings.json'])
      expect((await call(authorizeUrl(app, scope, challenge))).status, scope).toBe(200)
  })

  it('are a separate consent group that needs step-up', async () => {
    const { challenge } = await pkce()
    const html = await (await call(authorizeUrl(reader, `identify write:/.well-known/about.md read:${INBOX} read:/pups/private/settings.json`, challenge))).text()
    expect(html).toContain(`value="read:${INBOX} read:/pups/private/settings.json" checked> <span>Read your private data</span>`)
    expect(html).toContain('value="write:/.well-known/about.md" checked> <span>Manage your profile</span>')
    expect(html).toContain(`<li>read your inbox (<code>${INBOX}</code>)</li>`)
    expect(html).toContain('<li>read <code>/pups/private/settings.json</code></li>')
    const sub = await (await call(authorizeUrl(reader, `read:${INBOX}2026/`, challenge))).text()
    expect(sub).toContain(`<li>read files under <code>${INBOX}2026/</code></li>`)
    const mixed = await (await call(authorizeUrl(reader, `read:${INBOX} write:/pups/private/settings.json`, challenge))).text()
    expect(mixed).toContain('<span>Manage your private data</span>')
    expect(mixed).toContain('<li>read, create, replace and delete <code>/pups/private/settings.json</code></li>')
    expect((await approve(reader, `read:${INBOX}`, { password: '' })).res.status).toBe(401)
  })
})
