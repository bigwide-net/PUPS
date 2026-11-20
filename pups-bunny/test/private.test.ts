import { beforeAll, describe, expect, it } from 'vitest'
import { handle } from '../src/index'
import { permissionList } from '../src/oauth'
import { settings } from '../src/settings'
import { originPages } from './fakes'
import {
  approve, authorizeUrl, bearer, call, connect, env, mockClientFetch, ORIGIN, pkce, put, registerClient, setupOwner, testEnv,
} from './helpers'

/** Private areas (RFC-6): /appdata/<client-host>/private/ and declared paths in /pups/private/. */

const WELL_KNOWN = JSON.stringify([
  { path: '/.well-known/about.md', url: `${ORIGIN}/.well-known/about.md`, description: 'your profile' },
  { path: '/feed/', url: `${ORIGIN}/feed/`, rels: ['https://bigwide.net/ns/feed'] },
  { path: '/pups/images/', url: `${ORIGIN}/pups/images/`, properties: ['https://bigwide.net/ns/avatar'], url_properties: ['https://bigwide.net/ns/avatar'] },
  { path: '/pups/private/inbox/', description: 'your inbox' },
])
env.WELL_KNOWN_PATHS = WELL_KNOWN

const app = registerClient('priv-app.example')
const other = registerClient('priv-other.example')
const notes = '/appdata/priv-app.example/private/notes.json'

beforeAll(async () => {
  mockClientFetch()
  await setupOwner()
})

const get = (path: string, headers: Record<string, string> = {}, method = 'GET') => call(`/files${path}`, { method, headers })
const noStore = (r: Response) => [r.headers.get('cache-control'), r.headers.get('vary')]

describe("an app's own private data", () => {
  let token: string
  beforeAll(async () => {
    token = (await connect(app, 'write:/appdata/priv-app.example/')).access_token
  })

  it('is written and read back with the app\'s token, never cached', async () => {
    const w = await put(notes, token, '{"secret":1}')
    expect(w.status).toBe(201)
    expect(w.headers.get('location')).toBe(`${ORIGIN}/files${notes}`)
    for (const method of ['GET', 'HEAD']) {
      const r = await get(notes, bearer(token), method)
      expect(r.status, method).toBe(200)
      expect(noStore(r)).toEqual(['private, no-store', 'Authorization'])
      expect(r.headers.get('etag')).toBe(w.headers.get('etag'))
      expect(r.headers.get('access-control-allow-origin')).toBe('*')
      expect(await r.text()).toBe(method == 'GET' ? '{"secret":1}' : '')
    }
  })

  it('needs a bearer token: 401 with WWW-Authenticate: Bearer', async () => {
    for (const headers of [{}, { authorization: 'Basic dXNlcjpwYXNz' }] as Record<string, string>[]) {
      const r = await get(notes, headers)
      expect(r.status).toBe(401)
      expect(r.headers.get('www-authenticate')).toBe('Bearer')
      expect(noStore(r)).toEqual(['no-store', 'Authorization'])
      expect(((await r.json()) as any).error).toBe('invalid_token')
    }
  })

  it('rejects an invalid token with 401', async () => {
    const r = await get(notes, bearer('not-a-token'))
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"')
    expect(noStore(r)).toEqual(['no-store', 'Authorization'])
  })

  it('rejects valid tokens of another app or without a covering scope with 403, before looking for the file', async () => {
    const others = [(await connect(other, 'write:/appdata/priv-other.example/')).access_token, (await connect(app, 'identify')).access_token]
    for (const t of others) for (const path of [notes, '/appdata/priv-app.example/private/missing.json']) {
      const r = await get(path, bearer(t))
      expect(r.status, path).toBe(403)
      expect(r.headers.get('www-authenticate')).toBe('Bearer error="insufficient_scope"')
      expect(noStore(r)).toEqual(['no-store', 'Authorization'])
    }
  })

  it('answers 404 for a missing file only to a covering token', async () => {
    const r = await get('/appdata/priv-app.example/private/missing.json', bearer(token))
    expect(r.status).toBe(404)
    expect(noStore(r)).toEqual(['no-store', 'Authorization'])
  })

  it('leaves public files unchanged, also next to the private folder', async () => {
    for (const path of ['/appdata/priv-app.example/private.json', '/appdata/priv-app.example/sub/private/x.json']) {
      await put(path, token, '{}')
      const r = await get(path)
      expect(r.status, path).toBe(200)
      expect(noStore(r)).toEqual(['no-cache', 'Authorization'])
    }
    const missing = await get('/appdata/priv-app.example/missing.json')
    expect([missing.status, missing.headers.get('cache-control')]).toEqual([404, 'no-cache'])
  })

  it('is never served without a token at public_base or the domain root, and never comes from the origin', async () => {
    originPages.set(notes, 'leaked')
    originPages.set('/appdata/priv-app.example/private/missing.json', 'leaked')
    originPages.set('/pups/private/inbox/a.json', 'leaked')
    const vars = { ORIGIN_URL: 'https://origin.test/', WELL_KNOWN_PATHS: WELL_KNOWN }
    const envs = [
      { ...testEnv({ ...vars, PUBLIC_BASE: `${ORIGIN}/` }), files: env.files },
      { ...testEnv({ ...vars, PUBLIC_BASE: `${ORIGIN}/pub/` }), files: env.files },
      { ...testEnv(vars), files: env.files },
    ]
    for (const e of envs) for (const url of [`${ORIGIN}${notes}`, `${ORIGIN}/pups/private/inbox/a.json`, ...e == envs[1] ? [`${ORIGIN}/pub${notes}`] : []]) {
      const r = await handle(new Request(url), e)
      expect(r.status, `${e.PUBLIC_BASE} ${url}`).toBe(401)
      expect(noStore(r)).toEqual(['no-store', 'Authorization'])
      expect(await r.text()).not.toContain('leaked')
    }
    // With a covering token, the file is served from storage; a missing one is a 404, not the origin's page.
    const root = await handle(new Request(`${ORIGIN}${notes}`, { headers: bearer(token) }), envs[0])
    expect([root.status, await root.text()]).toEqual([200, '{"secret":1}'])
    const missing = await handle(new Request(`${ORIGIN}/appdata/priv-app.example/private/missing.json`, { headers: bearer(token) }), envs[0])
    expect(missing.status).toBe(404)
    expect(await missing.text()).not.toContain('leaked')
  })

  it("can't be linked in host-meta.json, or be the value of a URL property", async () => {
    const t = (await connect(app, 'write:/appdata/priv-app.example/ write:/pups/images/')).access_token
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    expect((await put('/appdata/priv-app.example/private/a.png', t, png, { 'content-type': 'image/png' })).status).toBe(201)
    const edit = (body: object) =>
      call('/pups/host-meta', { method: 'POST', body: JSON.stringify(body), headers: bearer(t, { 'content-type': 'application/json' }) })
    const add = await edit({ action: 'add', rel: 'https://priv-app.example/rel/notes', href: `${ORIGIN}/files${notes}` })
    expect(add.status).toBe(403)
    expect(((await add.json()) as any).message).toContain("Private files can't be linked")
    const avatar = 'https://bigwide.net/ns/avatar'
    expect((await edit({ action: 'set-property', property: avatar, value: `${ORIGIN}/files/appdata/priv-app.example/private/a.png` })).status).toBe(403)
    // The same links to public files work.
    expect((await edit({ action: 'add', rel: 'https://priv-app.example/rel/notes', href: `${ORIGIN}/files/appdata/priv-app.example/private.json` })).status).toBe(201)
    expect((await edit({ action: 'set-property', property: avatar, value: `${ORIGIN}/files/appdata/priv-app.example/x.png` })).status).toBe(201)
  })
})

describe('declared private paths in /pups/private/', () => {
  const inbox = '/pups/private/inbox/2026/a.json'
  const writer = registerClient('inbox-writer.example')
  const reader = registerClient('inbox-reader.example')

  it('are declared with their path only', async () => {
    const c = await (await call('/personal-storage.json')).json() as any
    expect(c.well_known_paths).toContainEqual({ path: '/pups/private/inbox/' })
    const m = await (await call('/.well-known/oauth-authorization-server')).json() as any
    expect(m.scopes_supported).toEqual(expect.arrayContaining(['write:/pups/private/inbox/', 'read:/pups/private/inbox/']))
  })

  it('are in the consent group "private data", which reads only with read scopes', async () => {
    const { challenge } = await pkce()
    let html = await (await call(authorizeUrl(reader, 'identify read:/pups/private/inbox/', challenge))).text()
    expect(html).toContain('value="read:/pups/private/inbox/" checked> <span>Read your private data</span>')
    expect(html).toContain('<li>read your inbox (<code>/pups/private/inbox/</code>)</li>')
    expect(html).not.toContain('Manage your profile')
    html = await (await call(authorizeUrl(writer, 'write:/.well-known/about.md write:/pups/private/inbox/ read:/pups/private/inbox/2026/', challenge))).text()
    expect(html).toContain('value="write:/.well-known/about.md" checked> <span>Manage your profile</span>')
    expect(html).toContain('value="write:/pups/private/inbox/ read:/pups/private/inbox/2026/" checked> <span>Manage your private data</span>')
    expect(html).toContain('<li>read, create, replace and delete your inbox (<code>/pups/private/inbox/</code>)</li>')
    expect(html).toContain('<li>read files under <code>/pups/private/inbox/2026/</code></li>')
    const s = settings(env, new URL(ORIGIN))
    expect(permissionList('read:/pups/private/inbox/', reader.host, s)).toContain('<li>Read your private data')
  })

  it('need step-up confirmation for read scopes', async () => {
    const { res } = await approve(reader, 'read:/pups/private/inbox/', { password: '' })
    expect(res.status).toBe(401)
  })

  it('can be read with a read: scope, but not written', async () => {
    const w = (await connect(writer, 'write:/pups/private/inbox/')).access_token
    const r = (await connect(reader, 'read:/pups/private/inbox/')).access_token
    expect((await put(inbox, w, '{"n":1}')).status).toBe(201)
    for (const t of [w, r]) {
      const g = await get(inbox, bearer(t))
      expect(g.status).toBe(200)
      expect(noStore(g)).toEqual(['private, no-store', 'Authorization'])
      expect(await g.text()).toBe('{"n":1}')
    }
    expect((await put(inbox, r, '{"n":2}')).status).toBe(403)
    expect((await put('/pups/private/inbox/new.json', r, '{}')).status).toBe(403)
    expect((await call(`/files${inbox}`, { method: 'DELETE', headers: bearer(r) })).status).toBe(403)
    expect((await call(`/pups/post?method=PUT&path=${encodeURIComponent(inbox)}`, { method: 'POST', body: '{}', headers: bearer(r, { 'content-type': 'application/json' }) })).status).toBe(403)
    expect((await call(`/pups/post?method=DELETE&path=${encodeURIComponent(inbox)}`, { method: 'POST', headers: bearer(r) })).status).toBe(403)
    expect(await (await get(inbox, bearer(w))).text()).toBe('{"n":1}')
    // A read scope covers only its own private path; nothing is public.
    expect((await get(notes, bearer(r))).status).toBe(403)
    expect((await get(inbox)).status).toBe(401)
    const narrow = (await connect(reader, 'read:/pups/private/inbox/2027/')).access_token
    expect((await get(inbox, bearer(narrow))).status).toBe(403)
    expect((await get('/pups/private/inbox/2027/missing.json', bearer(narrow))).status).toBe(404)
  })

  it('reject read: and write: scopes for undeclared or public paths', async () => {
    const { challenge } = await pkce()
    for (const scope of ['read:/pups/private/other/', 'read:/pups/private/', 'write:/pups/private/other/', 'read:/feed/',
      'read:/.well-known/about.md', 'read:/appdata/priv-app.example/', 'read:/appdata/priv-app.example/private/', 'read:/']) {
      const r = await call(authorizeUrl(app, scope, challenge), { redirect: 'manual' })
      const loc = new URL(r.headers.get('location')!)
      expect(loc.searchParams.get('error'), scope).toBe('invalid_scope')
      expect(loc.searchParams.get('error_description')).toContain('private')
    }
  })
})
