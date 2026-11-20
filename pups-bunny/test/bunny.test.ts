import { beforeAll, describe, expect, it } from 'vitest'
import { parseRange } from '../src/files'
import { parseWellKnown } from '../src/settings'
import { isPublicAddress } from '../src/ssrf'
import { store } from '../src/settings'
import { etagOf } from '../src/storage'
import { privateHosts, storage } from './fakes'
import { authorizeUrl, call, cimdFetches, connect, env, form, mockClientFetch, pkce, put, registerClient, setupOwner } from './helpers'

/** What is specific to Bunny: state in the storage zone, content-hash ETags, the SSRF check. */

const app = registerClient('bunny-app.example')
const text = (key: string) => new TextDecoder().decode(storage.get(key)!.bytes)

beforeAll(async () => {
  mockClientFetch()
  await setupOwner()
})

describe('state in the storage zone', () => {
  it('never serves the server state', async () => {
    expect(storage.has('_pups/owner.json')).toBe(true)
    for (const p of ['/files/_pups/owner.json', '/files/_pups/secret.json', '/files/.well-known/host-meta.json', '/_pups/owner.json'])
      expect((await call(p)).status, p).toBe(404)
  })

  it('stores tokens only as hashes', async () => {
    const t = await connect(app, 'write:/appdata/bunny-app.example/')
    const all = [...storage.keys()].filter(k => k.startsWith('_pups/')).map(text).join('\n')
    expect(all).not.toContain(t.access_token)
    expect(all).not.toContain(t.refresh_token)
    expect(all).not.toContain('correct horse')
  })

  it('does not revoke a grant for a made-up refresh token', async () => {
    const t = await connect(app, 'write:/appdata/bunny-app.example/')
    const fake = `${t.refresh_token!.split('.')[0]}.made-up`
    const refresh = (token: string) => call('/oauth/token', {
      method: 'POST', body: form({ grant_type: 'refresh_token', refresh_token: token, client_id: app.clientId }),
    })
    expect((await refresh(fake)).status).toBe(400)
    expect((await put('/appdata/bunny-app.example/still.json', t.access_token, '{}')).status).toBe(201)
    expect((await refresh(t.refresh_token!)).status).toBe(200)
  })

  it('cleans up old codes and nonces', async () => {
    for (const k of storage.keys()) if (k.startsWith('_pups/codes/') || k.startsWith('_pups/nonces/')) storage.get(k)!.changed -= 2 * 24 * 3600_000
    const before = [...storage.keys()].filter(k => k.startsWith('_pups/codes/')).length
    expect(before).toBeGreaterThan(0)
    await store(env).cleanup()
    const after = [...storage.keys()].filter(k => k.startsWith('_pups/codes/') || k.startsWith('_pups/nonces/')).length
    expect(after).toBeLessThan(before)
  })

  it('reserves /_pups/ for the server', () => {
    expect(() => parseWellKnown('[{"path":"/_pups/x.json"}]', 'https://tim.example.com')).toThrow()
  })
})

describe('content-hash ETags', () => {
  it('uses the SHA-256 of the content, on writes and reads alike', async () => {
    const t = await connect(app, 'write:/appdata/bunny-app.example/')
    const body = '{"hello":"bunny"}'
    const w = await put('/appdata/bunny-app.example/e.json', t.access_token, body)
    const etag = await etagOf(new TextEncoder().encode(body))
    expect(w.headers.get('etag')).toBe(etag)
    expect((await call('/files/appdata/bunny-app.example/e.json')).headers.get('etag')).toBe(etag)
    expect((await call('/files/appdata/bunny-app.example/e.json', { method: 'HEAD' })).headers.get('etag')).toBe(etag)
    // The same content written again keeps its ETag.
    expect((await put('/appdata/bunny-app.example/e.json', t.access_token, body, { 'if-match': etag })).headers.get('etag')).toBe(etag)
    // The storage checksum is the same hash: Bunny refuses an upload that doesn't match it.
    expect(storage.get('appdata/bunny-app.example/e.json')).toBeDefined()
  })

  it('answers single byte ranges', () => {
    expect(parseRange('bytes=2-4', 10)).toEqual({ start: 2, end: 4 })
    expect(parseRange('bytes=7-', 10)).toEqual({ start: 7, end: 9 })
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
    expect(parseRange('bytes=5-100', 10)).toEqual({ start: 5, end: 9 })
    expect(parseRange('bytes=10-', 10)).toBeNull()
    expect(parseRange('bytes=1-2,4-5', 10)).toBeUndefined()
    expect(parseRange(null, 10)).toBeUndefined()
  })

  it('refuses unsatisfiable ranges', async () => {
    const t = await connect(app, 'write:/appdata/bunny-app.example/')
    await put('/appdata/bunny-app.example/r.txt', t.access_token, '0123', { 'content-type': 'text/plain' })
    const r = await call('/files/appdata/bunny-app.example/r.txt', { headers: { range: 'bytes=10-' } })
    expect(r.status).toBe(416)
    expect(r.headers.get('content-range')).toBe('bytes */4')
  })
})

describe('SSRF check', () => {
  it('refuses client_id hosts that resolve to private addresses, without fetching them', async () => {
    const evil = registerClient('private.example')
    expect(privateHosts.has(evil.host)).toBe(true)
    cimdFetches.length = 0
    const { challenge } = await pkce()
    const r = await call(authorizeUrl(evil, 'identify', challenge))
    expect(r.status).toBe(400)
    expect(await r.text()).toContain('non-public address')
    expect(cimdFetches).toEqual([])
  })

  it.each(['93.184.215.14', '8.8.8.8', '2606:4700::1111', '[2a00:1450::1]'])('accepts public %s', ip => expect(isPublicAddress(ip)).toBe(true))
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '64:ff9b::a00:1', '2001:db8::1',
    '2002:a00:1::', 'ff02::1', 'not-an-ip', '1.2.3', '2001::1::2',
  ])('refuses %s', ip => expect(isPublicAddress(ip)).toBe(false))
})

describe('owner assets', () => {
  it('serves the bundled stylesheet and script', async () => {
    const css = await call('/pups/assets/owner.css')
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect((await call('/pups/assets/owner.js')).headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect((await call('/pups/assets/other.js')).status).toBe(404)
  })
})

describe('transport behind the pull zone', () => {
  it('trusts X-Forwarded-Proto from the pull zone', async () => {
    const r = await call('http://tim.example.com/personal-storage.json', { headers: { 'x-forwarded-proto': 'https' } })
    expect(r.status).toBe(200)
    expect(r.headers.get('strict-transport-security')).toContain('max-age')
  })
})

describe('misconfiguration', () => {
  it('explains a missing storage zone', async () => {
    const { handle } = await import('../src/index')
    const r = await handle(new Request('https://tim.example.com/'), { OWNER_HOST: 'tim.example.com' })
    expect(r.status).toBe(500)
    expect(await r.text()).toContain('STORAGE_ACCESS_KEY')
  })
})


