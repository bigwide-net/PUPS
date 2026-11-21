import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { HOST_META_KEY } from '../src/hostmeta'
import worker from '../src/index'
import {
  approve, authorizeUrl, bearer, call, cimdFetches, connect, exchange, form, mockClientFetch, ORIGIN, PASSWORD, pkce, put,
  registerClient, setupOwner, signedRequest,
} from './helpers'

const app = registerClient('app.example')
const other = registerClient('other.example')
const evilLogo = registerClient('evil-logo.example', { logo_uri: 'https://cdn.example/logo.png' })

// The authorization endpoint before the setup.
let notSetUp: Response

beforeAll(async () => {
  mockClientFetch()
  notSetUp = await call(authorizeUrl(app, 'identify', (await pkce()).challenge))
  await setupOwner()
})

describe('discovery', () => {
  it('links host-meta.json to the configuration document', async () => {
    const r = await call('/.well-known/host-meta.json')
    expect(r.status).toBe(200)
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
    const doc = await r.json() as any
    const link = doc.links.find((l: any) => l.rel == 'https://bigwide.net/ns/personal-storage')
    expect(link.href).toBe(`${ORIGIN}/personal-storage.json`)
  })

  it('serves the configuration document', async () => {
    const r = await call('/personal-storage.json')
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
    const c = await r.json() as any
    expect(c).toMatchObject({
      issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/oauth/authorize`, token_endpoint: `${ORIGIN}/oauth/token`,
      revocation_endpoint: `${ORIGIN}/oauth/revoke`, storage_base: `${ORIGIN}/files/`, public_base: `${ORIGIN}/files/`,
      scopes_supported: ['identify', 'write:/appdata/'], spec_version: '0.1', host_meta_endpoint: `${ORIGIN}/pups/host-meta`,
      max_upload_bytes: 1048576,
    })
    expect(c.well_known_paths.map((e: any) => e.path)).toContain('/.well-known/about.md')
  })

  it('serves RFC 8414 metadata', async () => {
    const m = await (await call('/.well-known/oauth-authorization-server')).json() as any
    expect(m).toMatchObject({
      issuer: ORIGIN, code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true,
      token_endpoint_auth_methods_supported: ['none'], client_id_metadata_document_supported: true,
    })
  })

  it('answers preflights', async () => {
    const r = await call('/files/appdata/app.example/x.json', { method: 'OPTIONS' })
    expect(r.status).toBe(204)
    expect(r.headers.get('access-control-allow-methods')).toContain('PUT')
    expect(r.headers.get('access-control-allow-headers')).toContain('If-None-Match')
    expect(r.headers.get('access-control-max-age')).toBe('86400')
  })

  it('does not enable CORS on the authorization endpoint', async () => {
    const r = await call('/oauth/authorize', { method: 'OPTIONS' })
    expect(r.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('authorization request', () => {
  it('shows an error page, never a redirect, for invalid clients and redirect URIs', async () => {
    const { challenge } = await pkce()
    for (const url of [
      authorizeUrl({ ...app, clientId: 'https://unknown.example/oauth/client.json' }, 'identify', challenge),
      authorizeUrl({ ...app, redirectUri: 'https://attacker.example/cb' }, 'identify', challenge),
      authorizeUrl({ ...app, clientId: 'https://127.0.0.1/c.json' }, 'identify', challenge),
      authorizeUrl(evilLogo, 'identify', challenge),
    ]) {
      const r = await call(url, { redirect: 'manual' })
      expect(r.status, url).toBe(400)
      expect(r.headers.get('location')).toBeNull()
    }
  })

  it('never fetches client metadata from private addresses', async () => {
    cimdFetches.length = 0
    const { challenge } = await pkce()
    await call(authorizeUrl({ ...app, clientId: 'https://localhost/c.json' }, 'identify', challenge))
    await call(authorizeUrl({ ...app, clientId: 'https://10.0.0.1/c.json' }, 'identify', challenge))
    expect(cimdFetches).toEqual([])
  })

  it('requires PKCE with S256', async () => {
    const { challenge } = await pkce()
    for (const extra of [{ code_challenge_method: 'plain' }, { code_challenge: '' }] as Record<string, string>[]) {
      const r = await call(authorizeUrl(app, 'identify', challenge, extra), { redirect: 'manual' })
      const loc = new URL(r.headers.get('location')!)
      expect(loc.searchParams.get('error')).toBe('invalid_request')
      expect(loc.searchParams.get('iss')).toBe(ORIGIN)
    }
  })

  it('rejects invalid scopes', async () => {
    const { challenge } = await pkce()
    for (const scope of ['write:/', 'write:/appdata/other.example/', 'write:/feeds/', 'write:/.well-known/host-meta.json']) {
      const r = await call(authorizeUrl(app, scope, challenge), { redirect: 'manual' })
      expect(new URL(r.headers.get('location')!).searchParams.get('error'), scope).toBe('invalid_scope')
    }
  })

  it('accepts loopback redirect URIs with any port and says that the app runs on this computer', async () => {
    const native = registerClient('native.example', { redirect_uris: ['http://127.0.0.1/callback'] })
    const { challenge } = await pkce()
    const r = await call(authorizeUrl({ ...native, redirectUri: 'http://127.0.0.1:49152/callback' }, 'identify', challenge))
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('This app runs on this computer')
    const local = await call(authorizeUrl({ ...native, redirectUri: 'http://localhost:49152/callback' }, 'identify', challenge))
    expect(local.status).toBe(400)
  })

  it('before the setup, explains how to set up the server and links to the setup', async () => {
    expect(notSetUp.status).toBe(503)
    const html = await notSetUp.text()
    expect(html).toContain('<h1>Set up your server first</h1>')
    expect(html).toContain('<a href="/pups/setup">Set it up now</a>')
    expect(html).toContain('go back to the app and log in again')
  })

  it('shows a consent screen that cannot be framed', async () => {
    const { challenge } = await pkce()
    const r = await call(authorizeUrl(app, 'identify write:/appdata/app.example/ write:/.well-known/about.md', challenge))
    expect(r.status).toBe(200)
    expect(r.headers.get('x-frame-options')).toBe('DENY')
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    const html = await r.text()
    expect(html).toContain('app.example')
    expect(html).toContain('Did you mean to log in with')
    expect(html).toContain('<legend>app.example may then</legend>')
    expect(html).not.toContain('outside')
    expect(html).not.toContain('This app runs on this computer')
  })
})

describe('code flow', () => {
  it('issues a code with iss and state, and tokens with me', async () => {
    const { res, verifier } = await approve(app, 'identify write:/appdata/app.example/')
    expect(res.status).toBe(303)
    const loc = new URL(res.headers.get('location')!)
    expect(loc.origin + loc.pathname).toBe(app.redirectUri)
    expect(loc.searchParams.get('iss')).toBe(ORIGIN)
    expect(loc.searchParams.get('state')).toBe('xyz')
    const t = await exchange(app, loc.searchParams.get('code')!, verifier)
    expect(t.headers.get('cache-control')).toBe('no-store')
    expect(t.headers.get('access-control-allow-origin')).toBe('*')
    const body = await t.json() as any
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'identify write:/appdata/app.example/', me: `${ORIGIN}/` })
    expect(body.access_token).toBeTruthy()
    expect(body.refresh_token).toBeTruthy()
  })

  it('rejects a wrong password without redirecting', async () => {
    const { res } = await approve(app, 'identify', { password: 'wrong password!' })
    expect(res.status).toBe(401)
    expect(res.headers.get('location')).toBeNull()
  })

  it('redirects with access_denied on denial', async () => {
    const { challenge } = await pkce()
    const page = await call(authorizeUrl(app, 'identify', challenge))
    const r = await call('/oauth/authorize', {
      method: 'POST', body: form({ request: signedRequest(await page.text()), decision: 'deny' }), redirect: 'manual',
    })
    expect(new URL(r.headers.get('location')!).searchParams.get('error')).toBe('access_denied')
  })

  it('rejects a wrong code_verifier, a wrong client and a wrong redirect_uri', async () => {
    for (const change of [{ verifier: 'x'.repeat(43) }, { client: other }, { redirect: 'https://app.example/other' }]) {
      const { res, verifier } = await approve(app, 'identify')
      const code = new URL(res.headers.get('location')!).searchParams.get('code')!
      const c = { ...(change.client ?? app), redirectUri: change.redirect ?? app.redirectUri }
      const t = await exchange(c, code, change.verifier ?? verifier)
      expect(t.status).toBe(400)
      expect((await t.json() as any).error).toBe('invalid_grant')
    }
  })

  it('revokes every token issued from a code that is redeemed twice', async () => {
    const { res, verifier } = await approve(app, 'write:/appdata/app.example/')
    const code = new URL(res.headers.get('location')!).searchParams.get('code')!
    const first = await (await exchange(app, code, verifier)).json() as any
    expect((await put('/appdata/app.example/reuse.json', first.access_token, '{}')).status).toBe(201)
    const second = await exchange(app, code, verifier)
    expect(second.status).toBe(400)
    expect((await put('/appdata/app.example/reuse.json', first.access_token, '{}')).status).toBe(401)
  })

  it('enforces the granted scope, not the requested one', async () => {
    const t = await connect(app, 'identify write:/appdata/app.example/', ['identify'])
    expect(t.scope).toBe('identify')
    expect(t.refresh_token).toBeUndefined()
    const r = await put('/appdata/app.example/x.json', t.access_token, '{}')
    expect(r.status).toBe(403)
    expect(r.headers.get('www-authenticate')).toContain('insufficient_scope')
  })

  it('treats dropping every scope as denial', async () => {
    const { res } = await approve(app, 'identify', { grant: [] })
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('access_denied')
  })

  it('accepts each approval only once', async () => {
    const { challenge } = await pkce()
    const page = await call(authorizeUrl(app, 'identify', challenge))
    const html = await page.text()
    const body = () => form({ request: signedRequest(html), decision: 'approve', scope: 'identify', password: PASSWORD })
    expect((await call('/oauth/authorize', { method: 'POST', body: body(), redirect: 'manual' })).status).toBe(303)
    expect((await call('/oauth/authorize', { method: 'POST', body: body(), redirect: 'manual' })).status).toBe(400)
  })
})

describe('refresh and revocation', () => {
  const refresh = (token: string, client = app) => call('/oauth/token', {
    method: 'POST', body: form({ grant_type: 'refresh_token', refresh_token: token, client_id: client.clientId }),
  })
  const tokens = async (r: Response) => {
    expect(r.status).toBe(200)
    return await r.json() as { access_token: string; refresh_token: string; me: string }
  }
  /** Moves the grace period of every replaced refresh token into the past. */
  const expireGrace = () => runInDurableObject(env.STORE.get(env.STORE.idFromName('owner')), async (_, state) => {
    state.storage.sql.exec('UPDATE grants SET replaced_at = replaced_at - 600000')
  })

  it('rotates refresh tokens and returns me', async () => {
    const t = await connect(app, 'write:/appdata/app.example/')
    const t1 = await tokens(await refresh(t.refresh_token!))
    expect(t1.me).toBe(`${ORIGIN}/`)
    expect(t1.refresh_token).not.toBe(t.refresh_token)
    const t2 = await tokens(await refresh(t1.refresh_token))
    expect((await put('/appdata/app.example/r.json', t2.access_token, '{}')).status).toBe(201)
  })

  it('lets a lost refresh response be retried within the grace period', async () => {
    const t = await connect(app, 'write:/appdata/app.example/')
    const lost = await tokens(await refresh(t.refresh_token!))
    const retry = await tokens(await refresh(t.refresh_token!))
    // The unused tokens of the lost response are revoked, without revoking the grant.
    expect((await refresh(lost.refresh_token)).status).toBe(400)
    expect((await put('/appdata/app.example/g.json', lost.access_token, '{}')).status).toBe(401)
    expect((await put('/appdata/app.example/g.json', retry.access_token, '{}')).status).toBe(201)
    await tokens(await refresh(retry.refresh_token))
  })

  it('revokes the grant on reuse after the new access token was used', async () => {
    const t = await connect(app, 'write:/appdata/app.example/')
    const t1 = await tokens(await refresh(t.refresh_token!))
    expect((await put('/appdata/app.example/u.json', t1.access_token, '{}')).status).toBe(201)
    expect((await refresh(t.refresh_token!)).status).toBe(400)
    expect((await refresh(t1.refresh_token)).status).toBe(400)
    expect((await put('/appdata/app.example/u.json', t1.access_token, '{}')).status).toBe(401)
  })

  it('revokes the grant on reuse after the new refresh token was used', async () => {
    const t = await connect(app, 'write:/appdata/app.example/')
    const t1 = await tokens(await refresh(t.refresh_token!))
    const t2 = await tokens(await refresh(t1.refresh_token))
    expect((await refresh(t.refresh_token!)).status).toBe(400)
    expect((await refresh(t1.refresh_token)).status).toBe(400)
    expect((await refresh(t2.refresh_token)).status).toBe(400)
  })

  it('revokes the grant on reuse after the grace period', async () => {
    const t = await connect(app, 'write:/appdata/app.example/')
    const t1 = await tokens(await refresh(t.refresh_token!))
    await expireGrace()
    expect((await refresh(t.refresh_token!)).status).toBe(400)
    expect((await refresh(t1.refresh_token)).status).toBe(400)
  })

  it('rejects a refresh token of another client', async () => {
    const t = await connect(app, 'write:/appdata/app.example/')
    expect((await refresh(t.refresh_token!, other)).status).toBe(400)
    await tokens(await refresh(t.refresh_token!))
  })

  it('revokes tokens (RFC 7009)', async () => {
    const t = await connect(app, 'write:/appdata/app.example/')
    const r = await call('/oauth/revoke', { method: 'POST', body: form({ token: t.refresh_token!, client_id: app.clientId }) })
    expect(r.status).toBe(200)
    expect((await put('/appdata/app.example/v.json', t.access_token, '{}')).status).toBe(401)
  })
})

describe('uploads', () => {
  let token: string
  beforeAll(async () => {
    token = (await connect(app, 'write:/appdata/app.example/')).access_token
  })

  it('creates, replaces and deletes with ETag preconditions', async () => {
    const path = '/appdata/app.example/feed.json'
    const c = await put(path, token, '{"v":1}', { 'if-none-match': '*' })
    expect(c.status).toBe(201)
    const etag = c.headers.get('etag')!
    expect(etag).toMatch(/^".+"$/)
    expect(c.headers.get('access-control-expose-headers')).toContain('ETag')
    expect((await put(path, token, '{"v":2}', { 'if-none-match': '*' })).status).toBe(412)
    const u = await put(path, token, '{"v":2}', { 'if-match': etag })
    expect(u.status).toBe(200)
    expect(u.headers.get('etag')).not.toBe(etag)
    expect((await put(path, token, '{"v":3}', { 'if-match': etag })).status).toBe(412)
    expect((await put(path, token, '{"v":3}')).status).toBe(200)
    // Cloudflare weakens the ETag of a compressed response: W/"…" must still match.
    const weak = (await put(path, token, '{"v":4}')).headers.get('etag')!
    expect((await put(path, token, '{"v":5}', { 'if-match': `W/${weak}` })).status).toBe(200)
    expect((await put(path, token, '{"v":6}', { 'if-match': `W/${weak}` })).status).toBe(412)
    const d = await call(`/files${path}`, { method: 'DELETE', headers: bearer(token, { 'if-match': etag }) })
    expect(d.status).toBe(412)
    expect((await call(`/files${path}`, { method: 'DELETE', headers: bearer(token) })).status).toBe(204)
    expect((await call(`/files${path}`, { method: 'DELETE', headers: bearer(token) })).status).toBe(404)
  })

  it('serves files publicly with safe headers', async () => {
    await put('/appdata/app.example/pic.svg', token, '<svg xmlns="http://www.w3.org/2000/svg"/>', { 'content-type': 'image/svg+xml' })
    const r = await call('/files/appdata/app.example/pic.svg')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('content-security-policy')).toBe('sandbox')
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
    expect(r.headers.get('etag')).toBeTruthy()
    const nm = await call('/files/appdata/app.example/pic.svg', { headers: { 'if-none-match': r.headers.get('etag')! } })
    expect(nm.status).toBe(304)
    const sw = await call('/files/appdata/app.example/pic.svg', { headers: { 'service-worker': 'script' } })
    expect(sw.status).toBe(403)
  })

  it('serves the type of the extension, not the uploaded one', async () => {
    await put('/appdata/app.example/feed2.json', token, '{}', { 'content-type': 'application/feed+json' })
    expect((await call('/files/appdata/app.example/feed2.json')).headers.get('content-type')).toBe('application/json; charset=utf-8')
  })

  it('supports range requests', async () => {
    await put('/appdata/app.example/r.txt', token, '0123456789', { 'content-type': 'text/plain' })
    const r = await call('/files/appdata/app.example/r.txt', { headers: { range: 'bytes=2-4' } })
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(await r.text()).toBe('234')
  })

  it('requires a valid bearer token in the header', async () => {
    const r = await call('/files/appdata/app.example/a.json', { method: 'PUT', body: '{}', headers: { 'content-type': 'application/json' } })
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"')
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
    expect((await call(`/files/appdata/app.example/a.json?access_token=${token}`, {
      method: 'PUT', body: '{}', headers: { 'content-type': 'application/json' },
    })).status).toBe(401)
    expect((await put('/appdata/app.example/a.json', 'not-a-token', '{}')).status).toBe(401)
  })

  it('rejects paths outside the scope', async () => {
    for (const p of ['/appdata/other.example/a.json', '/appdata/app.example.evil/a.json', '/feeds/a.json', '/.well-known/about.md'])
      expect((await put(p, token, '{}')).status, p).toBe(403)
  })

  it('rejects invalid paths', async () => {
    for (const p of ['/appdata/app.example/.htaccess', '/appdata/app.example/a%5Cb.json', '/appdata/app.example/a.json.',
      '/appdata/app.example//a.json', '/appdata/app.example/'])
      expect((await put(p, token, '{}')).status, p).toBe(400)
  })

  it('rejects disallowed types without storing anything', async () => {
    const cases: [string, string][] = [['a.php', 'application/json'], ['a.phtml', 'text/plain'], ['feed.php.json', 'application/json'],
      ['a.html', 'text/html'], ['a.js', 'text/javascript'], ['a.css', 'text/css'], ['a.json', 'text/html'], ['a.json', '']]
    for (const [name, type] of cases) {
      const r = await put(`/appdata/app.example/${name}`, token, '{}', { 'content-type': type })
      expect(r.status, name).toBe(415)
      expect((await call(`/files/appdata/app.example/${name}`)).status).toBe(404)
    }
    const bad = await put('/appdata/app.example/latin1.txt', token, new Uint8Array([0x66, 0xe9, 0xff]), { 'content-type': 'text/plain' })
    expect(bad.status).toBe(415)
  })

  it('rejects oversized uploads without storing anything', async () => {
    const r = await put('/appdata/app.example/big.png', token, new Uint8Array(1048577), { 'content-type': 'image/png' })
    expect(r.status).toBe(413)
    expect((await call('/files/appdata/app.example/big.png')).status).toBe(404)
  })

  it('supports the POST fallback', async () => {
    const path = encodeURIComponent('/appdata/app.example/post.json')
    const r = await call(`/pups/post?method=PUT&path=${path}`, { method: 'POST', body: '{}', headers: bearer(token, { 'content-type': 'application/json' }) })
    expect(r.status).toBe(201)
    const trav = await call(`/pups/post?method=PUT&path=${encodeURIComponent('/appdata/app.example/../other.example/x.json')}`,
      { method: 'POST', body: '{}', headers: bearer(token, { 'content-type': 'application/json' }) })
    expect(trav.status).toBe(400)
    const d = await call(`/pups/post?method=DELETE&path=${path}`, { method: 'POST', headers: bearer(token) })
    expect(d.status).toBe(204)
  })
})

describe('fresh reads', () => {
  const path = '/appdata/app.example/fresh.json'
  let token: string
  beforeAll(async () => {
    token = (await connect(app, 'write:/appdata/app.example/')).access_token
  })
  const read = (method: string, headers: Record<string, string> = {}) => call(`/files${path}`, { method, headers })

  it('serves the latest write to any valid token, without caching', async () => {
    const etag = (await put(path, token, '{"v":1}')).headers.get('etag')!
    const identify = (await connect(other, 'identify')).access_token
    for (const t of [token, identify]) for (const method of ['GET', 'HEAD']) {
      const r = await read(method, bearer(t))
      expect(r.status, method).toBe(200)
      expect(r.headers.get('cache-control')).toBe('private, no-store')
      expect(r.headers.get('vary')).toBe('Authorization')
      expect(r.headers.get('etag')).toBe(etag)
      expect(r.headers.get('x-content-type-options')).toBe('nosniff')
      expect(r.headers.get('content-security-policy')).toBe('sandbox')
      expect(r.headers.get('access-control-allow-origin')).toBe('*')
      expect(r.headers.get('last-modified')).toBeTruthy()
      if (method == 'GET') expect(await r.text()).toBe('{"v":1}')
    }
  })

  it('reflects a write immediately, and its ETag works for If-Match', async () => {
    const old = (await put(path, token, '{"v":2}')).headers.get('etag')!
    const etag = (await put(path, token, '{"v":3}', { 'if-match': old })).headers.get('etag')!
    const r = await read('GET', bearer(token))
    expect(r.headers.get('etag')).toBe(etag)
    expect(await r.text()).toBe('{"v":3}')
    expect((await put(path, token, '{"v":4}', { 'if-match': etag })).status).toBe(200)
  })

  it('answers conditional requests and ranges with a token', async () => {
    const etag = (await put(path, token, '{"v":5}')).headers.get('etag')!
    const nm = await read('GET', bearer(token, { 'if-none-match': etag }))
    expect(nm.status).toBe(304)
    expect(nm.headers.get('cache-control')).toBe('private, no-store')
    const r = await read('GET', bearer(token, { range: 'bytes=1-3' }))
    expect(r.status).toBe(206)
    expect(await r.text()).toBe('"v"')
  })

  it('rejects invalid and revoked tokens, never falling back to a public read', async () => {
    const bad = await read('GET', bearer('not-a-token'))
    expect(bad.status).toBe(401)
    expect(bad.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"')
    expect(bad.headers.get('access-control-allow-origin')).toBe('*')
    // Basic credentials of a password-protected site aren't a token: a public read.
    const basic = await read('HEAD', { authorization: 'Basic abc' })
    expect([basic.status, basic.headers.get('cache-control')]).toEqual([200, 'no-cache'])
    const t = await connect(app, 'write:/appdata/app.example/')
    expect((await read('GET', bearer(t.access_token))).status).toBe(200)
    await call('/oauth/revoke', { method: 'POST', body: form({ token: t.refresh_token!, client_id: app.clientId }) })
    const revoked = await read('GET', bearer(t.access_token))
    expect(revoked.status).toBe(401)
    expect(revoked.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"')
  })

  it('leaves public reads unchanged, with Vary: Authorization', async () => {
    const r = await read('GET')
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-cache')
    expect(r.headers.get('vary')).toBe('Authorization')
  })
})

describe('well-known files', () => {
  it('writes a declared /.well-known/ file after step-up and serves it at the domain root', async () => {
    const t = await connect(app, 'write:/.well-known/about.md')
    const r = await put('/.well-known/about.md', t.access_token, '# Tim', { 'content-type': 'text/markdown' })
    expect(r.status).toBe(201)
    const g = await call('/.well-known/about.md')
    expect(g.status).toBe(200)
    expect(g.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(g.headers.get('content-security-policy')).toBe('sandbox')
    expect(g.headers.get('access-control-allow-origin')).toBe('*')
    expect(await g.text()).toBe('# Tim')
    expect((await put('/.well-known/contact.vcf', t.access_token, 'x', { 'content-type': 'text/vcard' })).status).toBe(403)
  })

  it('requires the password for well-known scopes', async () => {
    const { res } = await approve(app, 'write:/.well-known/about.md', { password: '' })
    expect(res.status).toBe(401)
  })
})

describe('feed paths', () => {
  it('declares the list of well-known paths at the domain root', async () => {
    const c = await (await call('/personal-storage.json')).json() as any
    const feed = ['https://bigwide.net/ns/feed']
    expect(c.well_known_paths).toEqual([
      { path: '/.well-known/following.opml', url: `${ORIGIN}/.well-known/following.opml` },
      { path: '/.well-known/about.md', url: `${ORIGIN}/.well-known/about.md`, properties: ['name', 'title', 'summary', 'theme-color', 'language'].map(p => `https://bigwide.net/ns/${p}`) },
      { path: '/.well-known/contact.vcf', url: `${ORIGIN}/.well-known/contact.vcf` },
      { path: '/feed.json', url: `${ORIGIN}/feed.json`, rels: feed },
      { path: '/feed/', url: `${ORIGIN}/feed/`, rels: feed },
      { path: '/pups/images/', url: `${ORIGIN}/pups/images/`, properties: ['https://bigwide.net/ns/avatar', 'https://bigwide.net/ns/banner'] },
      { path: '/pups/pages/', url: `${ORIGIN}/pups/pages/`, rels: ['https://bigwide.net/ns/webpup-pages'],
        properties: ['https://bigwide.net/ns/webpup-footer'], link_properties: ['https://bigwide.net/ns/webpup-hidden'] },
    ])
  })

  it('describes them on the consent screen', async () => {
    const { challenge } = await pkce()
    const html = await (await call(authorizeUrl(app, 'write:/feed.json write:/feed/ write:/feed/2026/ write:/pups/images/ write:/pups/pages/', challenge))).text()
    expect(html).toContain('<li>your feed (<code>/feed.json</code>)</li>')
    expect(html).toContain('<li>the files of your feed, and your other feeds (<code>/feed/</code>)</li>')
    expect(html).toContain('<li>your site&#39;s profile images (<code>/pups/images/</code>)</li>')
    expect(html).toContain('<li>your site&#39;s pages (<code>/pups/pages/</code>)</li>')
    expect(html).toContain('<li>files under <code>/feed/2026/</code></li>')
  })

  it('groups the permissions: identity, then one checkbox each for app data, feeds and profile, with the details collapsed', async () => {
    const scope = 'identify write:/appdata/app.example/ write:/feed.json write:/feed/photos.json write:/.well-known/following.opml write:/.well-known/about.md write:/pups/images/'
    const { challenge } = await pkce()
    const html = await (await call(authorizeUrl(app, scope, challenge))).text()
    expect(html).toContain('<input type="checkbox" checked disabled> <span>Learn that you are <strong>tim.example.com</strong></span>')
    expect(html).toContain('<input type="hidden" name="scope" value="identify">')
    expect(html).toContain('value="write:/appdata/app.example/" checked> <span>Store its own data</span>')
    expect(html).toContain('value="write:/feed.json write:/feed/photos.json write:/.well-known/following.opml" checked> <span>Manage your feeds</span>')
    expect(html).toContain('value="write:/.well-known/about.md write:/pups/images/" checked> <span>Manage your profile</span>')
    expect(html).toContain('<li>its own folder (<code>/appdata/app.example/</code>)</li>')
    expect(html).toContain('<li><code>/feed/photos.json</code></li>')
    expect(html).toContain('<li>the list of people you follow (<code>/.well-known/following.opml</code>)</li>')
    expect(html).toContain('Add links to your <code>host-meta.json</code>: <code>https://bigwide.net/ns/feed</code>')
    expect(html).toContain('Set in your <code>host-meta.json</code>: <code>https://bigwide.net/ns/name</code>')
    expect([html.split('<details>').length - 1, html.split('name="scope"').length - 1, html.includes('will learn your domain')]).toEqual([3, 4, false])

    // Dropping the feeds and the app data keeps identity and the profile.
    const t = await connect(app, scope, ['identify', 'write:/.well-known/about.md write:/pups/images/'])
    expect(t.scope).toBe('identify write:/.well-known/about.md write:/pups/images/')
  })

  it('writes the main feed and its files, served at the domain root', async () => {
    const t = await connect(app, 'write:/feed.json write:/feed/')
    const feed = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'Tim', feed_url: `${ORIGIN}/feed.json`, items: [] })
    expect((await put('/feed.json', t.access_token, feed, { 'content-type': 'application/feed+json' })).status).toBe(201)
    expect((await put('/feed/2026/episode-1.mp3', t.access_token, new Uint8Array(16), { 'content-type': 'audio/mpeg' })).status).toBe(201)
    const g = await call('/feed.json')
    expect(g.status).toBe(200)
    expect(g.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(g.headers.get('content-security-policy')).toBe('sandbox')
    expect(g.headers.get('access-control-allow-origin')).toBe('*')
    expect(await g.text()).toBe(feed)
    expect((await call('/feed/2026/episode-1.mp3')).headers.get('content-type')).toBe('audio/mpeg')
    expect((await put('/feed/index.html', t.access_token, '<p>', { 'content-type': 'text/html' })).status).toBe(415)
    expect((await put('/feed.xml', t.access_token, '<rss/>', { 'content-type': 'application/rss+xml' })).status).toBe(403)
  })

  it('falls back to the origin for declared files nobody uploaded, with ORIGIN_FALLBACK', async () => {
    const withFallback = { ...env, ORIGIN_FALLBACK: 'true' } as any
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => new Response('from origin'))
    expect(await (await worker.fetch(new Request(`${ORIGIN}/.well-known/contact.vcf`) as any, withFallback)).text()).toBe('from origin')
    // An uploaded file comes from storage.
    expect(await (await worker.fetch(new Request(`${ORIGIN}/feed.json`) as any, withFallback)).text()).toContain('jsonfeed')
  })
})

describe('host-meta.json editing', () => {
  const hostMeta = async () => await (await call('/.well-known/host-meta.json')).json() as any
  const edit = (token: string, body: object) =>
    call('/pups/host-meta', { method: 'POST', body: JSON.stringify(body), headers: bearer(token, { 'content-type': 'application/json' }) })

  it('adds and removes links to the app\'s own files', async () => {
    const t = await connect(other, 'write:/appdata/other.example/')
    const href = `${ORIGIN}/files/appdata/other.example/feed.json`
    expect((await edit(t.access_token, { action: 'add', rel: 'https://other.example/rel/feed', href, type: 'application/json' })).status).toBe(201)
    const link = (await hostMeta()).links.find((l: any) => l.href == href)
    expect(link.properties['https://bigwide.net/ns/pups#client']).toBe(other.clientId)
    expect((await hostMeta()).links.some((l: any) => l.rel == 'https://bigwide.net/ns/personal-storage')).toBe(true)

    for (const bad of [
      { action: 'add', rel: 'https://other.example/rel/x', href: 'https://evil.example/x.json' },
      { action: 'add', rel: 'https://other.example/rel/x', href: `${ORIGIN}/files/appdata/app.example/x.json` },
      { action: 'add', rel: 'https://app.example/rel/x', href },
      { action: 'add', rel: 'http://webfinger.net/rel/profile-page', href },
      { action: 'add', rel: 'https://bigwide.net/ns/personal-storage', href },
      { action: 'set-property', property: 'https://bigwide.net/ns/name', value: 'Mallory' },
    ]) expect((await edit(t.access_token, bad)).status, JSON.stringify(bad)).toBe(403)

    expect((await edit(t.access_token, { action: 'remove', rel: 'https://other.example/rel/feed', href })).status).toBe(204)
    expect((await hostMeta()).links.some((l: any) => l.href == href)).toBe(false)
  })

  it('sets shared properties declared for a granted well-known path', async () => {
    const t = await connect(app, 'write:/.well-known/about.md')
    expect((await edit(t.access_token, { action: 'set-property', property: 'https://bigwide.net/ns/name', value: 'Tim' })).status).toBe(201)
    expect((await hostMeta()).properties['https://bigwide.net/ns/name']).toBe('Tim')
    for (const bad of [
      { action: 'set-property', property: 'https://bigwide.net/ns/name', value: '' },
      { action: 'set-property', property: 'https://bigwide.net/ns/name', value: 'a\nb' },
      { action: 'set-property', property: 'https://bigwide.net/ns/name', value: 'x'.repeat(2049) },
    ]) expect((await edit(t.access_token, bad)).status).toBe(400)
    expect((await edit(t.access_token, { action: 'set-property', property: 'https://bigwide.net/ns/pups#client', value: 'x' })).status).toBe(403)
    expect((await edit(t.access_token, { action: 'set-property', property: 'https://example.com/other', value: 'x' })).status).toBe(403)
  })

  it('registers feeds with the rel of /feed.json and /feed/', async () => {
    const c = registerClient('feeds.example')
    const rel = 'https://bigwide.net/ns/feed', type = 'application/feed+json'
    let t = await connect(c, 'write:/feed/')
    expect((await edit(t.access_token, { action: 'add', rel, href: `${ORIGIN}/feed/photos.json`, type })).status).toBe(201)
    expect((await edit(t.access_token, { action: 'add', rel, href: `${ORIGIN}/feed.json`, type })).status).toBe(403)
    expect((await edit(t.access_token, { action: 'add', rel: 'https://bigwide.net/ns/other', href: `${ORIGIN}/feed/photos.json` })).status).toBe(403)
    t = await connect(c, 'write:/feed.json')
    expect((await edit(t.access_token, { action: 'add', rel, href: `${ORIGIN}/feed.json`, type })).status).toBe(201)
    const feeds = (await hostMeta()).links.filter((l: any) => l.rel == rel && l.properties?.['https://bigwide.net/ns/pups#client'] == c.clientId)
    expect(feeds.map((l: any) => l.href)).toEqual([`${ORIGIN}/feed/photos.json`, `${ORIGIN}/feed.json`])
  })

  it('sets the profile properties of about.md', async () => {
    const t = await connect(app, 'write:/.well-known/about.md')
    const props = { title: 'Notes', summary: 'About me', 'theme-color': '#336699', language: 'en' }
    for (const [p, value] of Object.entries(props))
      expect((await edit(t.access_token, { action: 'set-property', property: `https://bigwide.net/ns/${p}`, value })).status).toBe(201)
    expect((await edit(t.access_token, { action: 'set-property', property: 'https://bigwide.net/ns/avatar', value: `${ORIGIN}/pups/images/a.png` })).status).toBe(403)
    const got = (await hostMeta()).properties
    for (const [p, value] of Object.entries(props)) expect(got[`https://bigwide.net/ns/${p}`]).toBe(value)
  })

  it('stores profile images in /pups/images/, served at the domain root, and sets them as URL properties', async () => {
    const t = await connect(app, 'write:/pups/images/')
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const r = await put('/pups/images/x.png', t.access_token, png, { 'content-type': 'image/png' })
    expect(r.status).toBe(201)
    const g = await call('/pups/images/x.png')
    expect(g.status).toBe(200)
    expect(Object.fromEntries(['content-type', 'x-content-type-options', 'content-security-policy', 'access-control-allow-origin'].map(k => [k, g.headers.get(k)])))
      .toEqual({ 'content-type': 'image/png', 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox', 'access-control-allow-origin': '*' })
    expect(new Uint8Array(await g.arrayBuffer())).toEqual(png)
    expect((await call('/files/pups/images/x.png')).status).toBe(200)
    const avatar = 'https://bigwide.net/ns/avatar', banner = 'https://bigwide.net/ns/banner'
    expect((await edit(t.access_token, { action: 'set-property', property: avatar, value: `${ORIGIN}/pups/images/x.png` })).status).toBe(201)
    expect((await edit(t.access_token, { action: 'set-property', property: banner, value: `${ORIGIN}/pups/images/sub/b.jpg` })).status).toBe(201)
    for (const value of [`${ORIGIN}/feed/x.png`, `${ORIGIN}/pups/x.png`, `${ORIGIN}/files/appdata/app.example/x.png`, 'https://evil.example/pups/images/x.png'])
      expect((await edit(t.access_token, { action: 'set-property', property: avatar, value })).status, value).toBe(403)
    expect((await edit(t.access_token, { action: 'set-property', property: 'https://bigwide.net/ns/name', value: 'Mallory' })).status).toBe(403)
    const props = (await hostMeta()).properties
    expect([props[avatar], props[banner]]).toEqual([`${ORIGIN}/pups/images/x.png`, `${ORIGIN}/pups/images/sub/b.jpg`])
    // Nothing else under /pups/ is writable, and the server's own routes still work.
    for (const p of ['/pups/x.png', '/pups/imagesx/a.png', '/pups/assets/a.png'])
      expect((await put(p, t.access_token, png, { 'content-type': 'image/png' })).status, p).toBe(403)
    expect((await call('/pups/apps')).status).toBe(200)
    expect((await call('/pups/host-meta')).status).toBe(405)
  })

  it('publishes pages with titles, hidden flags and a footer, and orders them', async () => {
    const pages = 'https://bigwide.net/ns/webpup-pages', hidden = 'https://bigwide.net/ns/webpup-hidden', client = 'https://bigwide.net/ns/pups#client'
    const page = (n: string) => `${ORIGIN}/pups/pages/${n}.md`
    const before = await (await env.FILES.get(HOST_META_KEY))?.text()
    await env.FILES.put(HOST_META_KEY, JSON.stringify({ links: [{ rel: pages, href: page('owner') }, { rel: 'me', href: 'https://x' }] }))
    const c = registerClient('pages.example')
    const tok = (await connect(c, 'write:/pups/pages/')).access_token
    expect((await put('/pups/pages/now.md', tok, '# Now', { 'content-type': 'text/markdown' })).status).toBe(201)
    expect(await (await call('/pups/pages/now.md')).text()).toBe('# Now')
    expect((await edit(tok, { action: 'add', rel: pages, href: page('now'), type: 'text/markdown' })).status).toBe(201)
    expect((await edit(tok, { action: 'add', rel: pages, href: page('imprint'), titles: { default: 'Imprint', de: 'Impressum' }, properties: { [hidden]: 'true' } })).status).toBe(201)
    // Undeclared link properties, the ownership marker, bad titles
    expect((await edit(tok, { action: 'add', rel: pages, href: page('x'), properties: { 'https://bigwide.net/ns/other': 'x' } })).status).toBe(403)
    expect((await edit(tok, { action: 'add', rel: pages, href: page('x'), properties: { [client]: 'https://evil.example/' } })).status).toBe(403)
    expect((await edit(tok, { action: 'add', rel: pages, href: page('x'), titles: { default: 'a'.repeat(256) } })).status).toBe(400)
    expect((await edit(tok, { action: 'add', rel: pages, href: page('x'), titles: { 'not a tag': 'x' } })).status).toBe(400)
    // Changing the app's own link replaces titles and properties; the owner's can't be changed.
    expect((await edit(tok, { action: 'add', rel: pages, href: page('now'), type: 'text/markdown', titles: { default: 'Now' } })).status).toBe(201)
    expect((await edit(tok, { action: 'add', rel: pages, href: page('owner'), titles: { default: 'Mine' } })).status).toBe(409)
    expect((await edit(tok, { action: 'add', rel: pages, href: page('owner') })).status).toBe(201)
    let links = (await hostMeta()).links
    expect(links).toEqual([
      { rel: pages, href: page('owner') },
      { rel: 'me', href: 'https://x' },
      { rel: pages, href: page('now'), type: 'text/markdown', titles: { default: 'Now' }, properties: { [client]: c.clientId } },
      { rel: pages, href: page('imprint'), titles: { default: 'Imprint', de: 'Impressum' }, properties: { [hidden]: 'true', [client]: c.clientId } },
    ])
    // The footer
    const footer = 'https://bigwide.net/ns/webpup-footer'
    expect((await edit(tok, { action: 'set-property', property: footer, value: page('footer') })).status).toBe(201)
    expect((await edit(tok, { action: 'set-property', property: footer, value: `${ORIGIN}/feed/footer.md` })).status).toBe(403)
    // Order: all links of the rel, each once, in their slots; the owner's link moves too.
    for (const hrefs of [[page('now'), page('owner')], [page('now'), page('now'), page('owner'), page('imprint')], [page('now'), page('owner'), page('imprint'), page('x')]])
      expect((await edit(tok, { action: 'order', rel: pages, hrefs })).status).toBe(409)
    expect((await edit(tok, { action: 'order', rel: 'https://bigwide.net/ns/feed', hrefs: [] })).status).toBe(403)
    expect((await edit(tok, { action: 'order', rel: pages, hrefs: [page('imprint'), page('owner'), page('now')] })).status).toBe(204)
    links = (await hostMeta()).links
    expect(links.map((l: any) => l.href)).toEqual([page('imprint'), 'https://x', page('owner'), page('now')])
    expect(links[2]).toEqual({ rel: pages, href: page('owner') })
    if (before) await env.FILES.put(HOST_META_KEY, before)
    else await env.FILES.delete(HOST_META_KEY)
  })

  it('removes an app\'s own-data links when its grant is revoked', async () => {
    const c = registerClient('revoked.example')
    const t = await connect(c, 'write:/appdata/revoked.example/')
    const href = `${ORIGIN}/files/appdata/revoked.example/x.json`
    await edit(t.access_token, { action: 'add', rel: 'https://revoked.example/rel/x', href })
    expect((await hostMeta()).links.some((l: any) => l.href == href)).toBe(true)
    await call('/oauth/revoke', { method: 'POST', body: form({ token: t.refresh_token!, client_id: c.clientId }) })
    expect((await hostMeta()).links.some((l: any) => l.href == href)).toBe(false)
  })
})

describe('transport', () => {
  it('redirects plain HTTP GETs and refuses other plain HTTP requests', async () => {
    const r = await call('http://tim.example.com/personal-storage.json', { redirect: 'manual' })
    expect(r.status).toBe(301)
    expect((await call('http://tim.example.com/oauth/token', { method: 'POST', body: form({}) })).status).toBe(403)
  })
  it('sends HSTS', async () => {
    expect((await call('/personal-storage.json')).headers.get('strict-transport-security')).toContain('max-age')
  })
})
