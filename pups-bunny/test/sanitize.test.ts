import { beforeAll, describe, expect, it } from 'vitest'
import { authorizeUrl, bearer, call, connect, form, mockClientFetch, ORIGIN, PASSWORD, pkce, put, registerClient, setupOwner } from './helpers'
import { isCspOrigin, isHostName, sanitizeText, visible } from 'pups-ui'

// Invisible characters, built at runtime so that this file contains none.
const RLO = String.fromCharCode(0x202e), ZWSP = String.fromCharCode(0x200b), LRI = String.fromCharCode(0x2066)

beforeAll(async () => {
  mockClientFetch()
  await setupOwner()
})

const showApps = () => call('/pups/apps', { method: 'POST', body: form({ show: '1', password: PASSWORD }) })

describe('sanitize', () => {
  it('cleans self-declared text like Downread', () => {
    expect(sanitizeText(` a${RLO}b${ZWSP}\n\tc${String.fromCharCode(7)} `, 100)).toBe('ab c')
    expect(sanitizeText('😀😀😀😀', 3)).toBe('😀😀…')
    expect(sanitizeText(ZWSP, 10)).toBeUndefined()
  })

  it('makes unsafe characters visible', () => {
    expect(visible(`/a${RLO}b`)).toBe('/a\\u{202e}b')
  })

  it('checks host names and CSP origins strictly', () => {
    expect(isHostName('app.example')).toBe(true)
    for (const h of ['x;sandbox.example', "a'b.example", '-a.example', 'App.example']) expect([h, isHostName(h)]).toEqual([h, false])
    expect(isCspOrigin('http://127.0.0.1:5173')).toBe(true)
    expect(isCspOrigin('https://x;sandbox')).toBe(false)
  })
})

describe('untrusted input', () => {
  it('sanitizes and encodes the self-declared name on the consent screen and the apps page', async () => {
    const c = registerClient('named.example', { client_name: `Good${RLO} App\n<script>alert(1)</script>${ZWSP}"x"` })
    const page = await (await call(authorizeUrl(c, 'write:/appdata/named.example/', (await pkce()).challenge))).text()
    expect(page).toContain('Did you mean to log in with “<bdi>Good App &lt;script&gt;alert(1)&lt;/script&gt;&quot;x&quot;</bdi>”?')
    expect(page).not.toContain('<script>alert')
    expect(page).not.toContain(RLO)
    await connect(c, 'write:/appdata/named.example/')
    const apps = await (await showApps()).text()
    expect(apps).toContain('<bdi>Good App &lt;script&gt;')
    expect(apps).not.toContain(RLO)
  })

  it('rejects unsafe URLs and host names in client metadata', async () => {
    const { challenge } = await pkce()
    for (const extra of [{ logo_uri: 'javascript:alert(1)' }, { logo_uri: 'https://bad-logo.example/a b.png' },
      { logo_uri: `https://bad-logo.example/${RLO}gnp.png` }]) {
      const c = registerClient('bad-logo.example', extra)
      expect([extra, (await call(authorizeUrl(c, 'identify', challenge))).status]).toEqual([extra, 400])
    }
    const semi = registerClient('semi.example', { redirect_uris: ['https://semi.example;sandbox/cb'] })
    expect((await call(authorizeUrl({ ...semi, redirectUri: 'https://semi.example;sandbox/cb' }, 'identify', challenge))).status).toBe(400)
    const r = await call(authorizeUrl(registerClient('x;sandbox.example'), 'identify', challenge))
    expect(r.status).toBe(400)
    expect(await r.text()).toContain('may contain only letters, digits, hyphens and dots')
  })

  it('keeps the consent page CSP to plain origins', async () => {
    const c = registerClient('loop.example', { redirect_uris: ['http://127.0.0.1/cb'] })
    const r = await call(authorizeUrl({ ...c, redirectUri: 'http://127.0.0.1:5173/cb' }, 'identify', (await pkce()).challenge))
    expect(r.headers.get('content-security-policy')).toContain("form-action 'self' http://127.0.0.1:5173;")
  })

  it('rejects invisible characters in paths and host-meta values, and stores canonical hrefs', async () => {
    const c = registerClient('invisible.example')
    const t = await connect(c, 'write:/appdata/invisible.example/ write:/.well-known/about.md')
    expect((await put('/appdata/invisible.example/%E2%80%AEnosj.json', t.access_token, '{}')).status).toBe(400)
    expect((await put('/appdata/invisible.example/a%E2%81%A6.json', t.access_token, '{}')).status).toBe(400)
    const hm = (body: object) => call('/pups/host-meta', {
      method: 'POST', headers: bearer(t.access_token, { 'content-type': 'application/json' }), body: JSON.stringify(body),
    })
    expect((await hm({ action: 'set-property', property: 'https://bigwide.net/ns/name', value: `Tim${RLO}` })).status).toBe(400)
    expect((await hm({ action: 'add', rel: `https://invisible.example/r${LRI}`, href: `${ORIGIN}/files/appdata/invisible.example/a.json` })).status).toBe(400)
    expect((await hm({ action: 'add', rel: 'https://invisible.example/r', href: `${ORIGIN}/files/appdata/invisible.example/a<b>.json` })).status).toBe(201)
    const doc = await (await call('/.well-known/host-meta.json')).json() as any
    expect(doc.links.some((l: any) => l.href == `${ORIGIN}/files/appdata/invisible.example/a%3Cb%3E.json`)).toBe(true)
  })

  it('answers a malformed remove_link with a message, not an error', async () => {
    const r = await call('/pups/apps', { method: 'POST', body: form({ remove_link: '{not json', password: PASSWORD }) })
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('Invalid link.')
  })
})

describe('size limits', () => {
  it('rejects oversized authorization parameters with an error page', async () => {
    const c = registerClient('limits.example')
    const { challenge } = await pkce()
    for (const extra of [{ state: 'x'.repeat(1025) }, { scope: 'identify '.repeat(300) }] as Record<string, string>[]) {
      const r = await call(authorizeUrl(c, 'identify', challenge, extra))
      expect(r.status).toBe(400)
      expect(r.headers.get('content-type')).toMatch(/^text\/html/)
      expect(await r.text()).toContain('is longer than')
    }
    const r = await call(authorizeUrl(c, Array.from({ length: 21 }, () => 'identify').join(' '), challenge), { redirect: 'manual' })
    expect(new URL(r.headers.get('location')!).searchParams.get('error')).toBe('invalid_scope')
  })

  it('rejects oversized client metadata', async () => {
    const { challenge } = await pkce()
    for (const extra of [{ client_name: 'n'.repeat(1001) },
      { redirect_uris: Array.from({ length: 21 }, (_, i) => `https://big.example/cb${i}`) },
      { logo_uri: `https://big.example/${'l'.repeat(2048)}.png` }]) {
      const c = registerClient('big.example', extra)
      expect((await call(authorizeUrl({ ...c, redirectUri: 'https://big.example/cb0' }, 'identify', challenge))).status).toBe(400)
    }
    const long = registerClient('long-name.example', { client_name: 'n'.repeat(1000) })
    expect(await (await call(authorizeUrl(long, 'identify', challenge))).text()).toContain(`<bdi>${'n'.repeat(99)}…</bdi>`)
  })

  it('rejects oversized forms, fields, headers and paths', async () => {
    const c = registerClient('limits2.example')
    let r = await call('/oauth/token', { method: 'POST', body: form({ grant_type: 'refresh_token', client_id: c.clientId, refresh_token: 't'.repeat(257) }) })
    expect(r.status).toBe(400)
    expect(((await r.json()) as any).message).toContain('refresh_token is longer than 256')
    r = await call('/oauth/token', { method: 'POST', body: form({ grant_type: 'x', client_id: c.clientId, filler: 'f'.repeat(70_000) }) })
    expect(r.status).toBe(413)
    r = await call('/pups/apps', { method: 'POST', body: form({ show: '1', password: 'p'.repeat(1025) }) })
    expect(r.status).toBe(400)
    expect(await r.text()).toContain('password is longer than 1024 characters')
    const t = await connect(c, 'write:/appdata/limits2.example/')
    expect((await put('/appdata/limits2.example/a.json', t.access_token, '{}', { 'if-match': `"${'e'.repeat(4100)}"` })).status).toBe(400)
    expect((await put(`/appdata/limits2.example/${'p'.repeat(600)}.json`, t.access_token, '{}')).status).toBe(400)
    r = await call('/files/appdata/limits2.example/a.json', {
      method: 'PUT', headers: { authorization: `Bearer ${'t'.repeat(5000)}`, 'content-type': 'application/json' }, body: '{}',
    })
    expect(r.status).toBe(401)
  })
})
