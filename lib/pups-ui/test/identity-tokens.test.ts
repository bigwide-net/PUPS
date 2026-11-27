import { describe, expect, it } from 'vitest'
import {
  ACCESS_TOKEN_TYPE, appsPage, exchangeRequest, exchangeResponse, identityUses, isAudience, jwksResponse, newSigningKey, permissionGroups, permissionList,
  signIdentityToken, type ScopeView,
} from '../src'

const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0))
const part = (token: string, i: number) => JSON.parse(new TextDecoder().decode(b64(token.split('.')[i]!)))

describe('identity tokens (RFC-10)', () => {
  it('accept only one canonical https origin as audience', () => {
    for (const ok of ['https://polls.example.com', 'https://polls.example.com:8443', 'https://xn--bcher-kva.example'])
      expect(isAudience(ok), ok).toBe(true)
    for (const bad of ['https://polls.example.com/', 'https://polls.example.com/vote', 'https://polls.example.com?x', 'https://polls.example.com#x',
      'http://polls.example.com', 'https://Polls.example.com', 'https://polls.example.com:443', 'https://a@polls.example.com', 'https://bücher.example',
      'https://localhost', 'https://app.localhost', 'https://printer.local', 'https://127.0.0.1', 'https://[::1]', 'https://intranet', 'polls.example.com', ''])
      expect(isAudience(bad), bad).toBe(false)
  })

  it('check token exchange requests', () => {
    const req = (extra: [string, string][] = [], audience = ['https://polls.example.com']) =>
      exchangeRequest(new URLSearchParams([['subject_token', 'at'], ['subject_token_type', ACCESS_TOKEN_TYPE], ...audience.map(a => ['audience', a] as [string, string]), ...extra]))
    expect(req()).toEqual({ subjectToken: 'at', audience: 'https://polls.example.com', read: false })
    expect(req([['scope', 'read']])).toEqual({ subjectToken: 'at', audience: 'https://polls.example.com', read: true })
    for (const scope of [[['scope', 'write']], [['scope', 'read write']], [['scope', 'read'], ['scope', 'read']]] as [string, string][][])
      expect(req(scope)).toMatchObject({ error: 'invalid_scope' })
    expect(req([['requested_token_type', 'urn:ietf:params:oauth:token-type:jwt']])).toMatchObject({ audience: 'https://polls.example.com' })
    for (const extra of [['resource', 'https://x.example'], ['actor_token', 'x'], ['requested_token_type', ACCESS_TOKEN_TYPE]] as [string, string][])
      expect(req([extra])).toMatchObject({ error: 'invalid_request' })
    for (const audience of [[], ['https://a.example', 'https://b.example'], ['https://polls.example.com/']])
      expect(req([], audience)).toMatchObject({ error: 'invalid_target' })
    expect(exchangeRequest(new URLSearchParams({ subject_token: 'at', audience: 'https://a.example' }))).toMatchObject({ error: 'invalid_request' })
  })

  it('sign RS256 JWTs that verify with the published JWK Set', async () => {
    const key = await newSigningKey(Date.UTC(2026, 10, 27))
    expect(key.kid).toMatch(/^2026-11-27-[A-Za-z0-9_-]{8}$/)
    const res = jwksResponse('GET', [key])
    expect([res.headers.get('access-control-allow-origin'), res.headers.get('cache-control'), res.headers.get('content-type')])
      .toEqual(['*', 'public, max-age=600', 'application/json'])
    const { keys } = await res.json() as any
    expect(keys).toEqual([{ kty: 'RSA', use: 'sig', alg: 'RS256', kid: key.kid, n: expect.any(String), e: 'AQAB' }])
    expect(JSON.stringify(keys)).not.toContain(String(key.privateJwk.d))

    const now = Date.now()
    const token = await signIdentityToken(key, { iss: 'https://tim.example.com', sub: 'https://tim.example.com/', aud: 'https://polls.example.com', client_id: 'https://app.example/oauth/client.json' }, false, now)
    expect(part(token, 0)).toEqual({ typ: 'at+jwt', alg: 'RS256', kid: key.kid })
    const claims = part(token, 1)
    expect(claims).toEqual({
      iss: 'https://tim.example.com', sub: 'https://tim.example.com/', aud: 'https://polls.example.com', client_id: 'https://app.example/oauth/client.json',
      iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 60, jti: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    })
    const pub = await crypto.subtle.importKey('jwk', keys[0], { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    const [h, p, sig] = token.split('.')
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pub, b64(sig!), new TextEncoder().encode(`${h}.${p}`))).toBe(true)
    expect(exchangeResponse(token)).toEqual({ access_token: token, issued_token_type: 'urn:ietf:params:oauth:token-type:jwt', token_type: 'Bearer', expires_in: 60 })
    expect(jwksResponse('POST', [key]).status).toBe(405)

    // A read token: scope read, 24 hours.
    const read = await signIdentityToken(key, { iss: 'https://tim.example.com', sub: 'https://tim.example.com/', aud: 'https://comments.example.org', client_id: 'c' }, true, now)
    const rc = part(read, 1)
    expect([rc.scope, rc.exp - rc.iat]).toEqual(['read', 86400])
    expect(claims.scope).toBeUndefined()
    expect(exchangeResponse(read, true)).toEqual({ access_token: read, issued_token_type: 'urn:ietf:params:oauth:token-type:jwt', token_type: 'Bearer', expires_in: 86400, scope: 'read' })
  })

  it('show the scope as a group of its own, and the log per app and site', async () => {
    const scopes = new Map<string, ScopeView>([['identify', { kind: 'identify' }], ['identity-tokens', { kind: 'identity-tokens' }]])
    const html = permissionGroups(scopes, 'tim.example.com')
    expect(html).toContain('<input type="checkbox" name="scope" value="identity-tokens" checked> <span>Act as <strong>tim.example.com</strong> on other sites')
    expect(html).toContain('It can prove to any site that it acts for you')
    expect(permissionList([['identity-tokens', { kind: 'identity-tokens' }]], 'tim.example.com')).toContain('<li>Act as <strong>tim.example.com</strong> on other sites')
    const log = [
      { at: 1, clientId: 'a', audience: 'https://polls.example.com' }, { at: 3, clientId: 'a', audience: 'https://polls.example.com' },
      { at: 2, clientId: 'a', audience: 'https://groups.example.com', read: true }, { at: 4, clientId: 'b', audience: 'https://x.example' },
    ]
    expect(identityUses(log, 'a')).toEqual([
      { audience: 'https://polls.example.com', count: 2, reads: 0, last: 3 }, { audience: 'https://groups.example.com', count: 1, reads: 1, last: 2 },
    ])
    const usesPage = (uses: { count: number; reads: number }[]) => appsPage({ ownerHost: 'tim.example.com', ownerOrigin: 'https://tim.example.com', subdomainMode: false }, {
      apps: [{ id: 'g', clientHost: 'app.example', permissions: '', createdAt: 0, lastUsedAt: null, hasFiles: false, identityUses: uses.map(u => ({ audience: 'https://x.example', last: 0, ...u })) }],
      links: [], properties: [], hostMetaStored: true, confirm: { hasPassword: true, passkeyOptions: {} },
    }).text()
    expect(await usesPage([{ count: 3, reads: 0 }, { count: 3, reads: 2 }, { count: 1, reads: 1 }, { count: 4, reads: 4 }]))
      .toMatch(/3 times, last[^]*3 times \(2 times for reading\), last[^]*once, for reading, last[^]*4 times, all for reading, last/)
  })
})
