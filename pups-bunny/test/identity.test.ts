import { beforeAll, describe, expect, it } from 'vitest'
import { signingKey } from '../src/oauth'
import { storage } from './fakes'
import { bearer, call, connect, env, form, mockClientFetch, ORIGIN, PASSWORD, put, registerClient, setupOwner } from './helpers'

// Identity tokens (RFC-10): the scope, the token exchange, the JWK Set and the log on the apps page. Ported from
// pups-cloudflare, with the place of the key and the log in the storage zone.

const app = registerClient('reader.example')
const writer = registerClient('writer.example')
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange'
const ACCESS = 'urn:ietf:params:oauth:token-type:access_token'

beforeAll(async () => {
  mockClientFetch()
  await setupOwner()
})

const exchange = (subject: string, fields: Record<string, string> | [string, string][] = {}, client = app) => call('/oauth/token', {
  method: 'POST', body: form([['grant_type', TOKEN_EXCHANGE], ['client_id', client.clientId], ['subject_token', subject], ['subject_token_type', ACCESS],
    ...Array.isArray(fields) ? fields : Object.entries({ audience: 'https://polls.example.com', ...fields })]),
})
const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0))
const part = (token: string, i: number) => JSON.parse(new TextDecoder().decode(b64(token.split('.')[i]!)))
const jwks = async () => (await (await call('/pups/jwks.json')).json() as any).keys

/** Whether the token's signature checks out with the published key of its kid. */
async function verifies(token: string) {
  const jwk = (await jwks()).find((k: any) => k.kid == part(token, 0).kid)
  if (!jwk) return false
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  const [h, p, sig] = token.split('.')
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64(sig!), new TextEncoder().encode(`${h}.${p}`))
}

describe('identity tokens', () => {
  it('are announced, with the key set', async () => {
    const m = await (await call('/.well-known/oauth-authorization-server')).json() as any
    expect([m.jwks_uri, m.grant_types_supported, m.scopes_supported.includes('identity-tokens')])
      .toEqual([`${ORIGIN}/pups/jwks.json`, ['authorization_code', 'refresh_token', TOKEN_EXCHANGE], true])
    const r = await call('/pups/jwks.json')
    expect([r.status, r.headers.get('access-control-allow-origin'), r.headers.get('cache-control')]).toEqual([200, '*', 'public, max-age=600'])
    const { keys } = await r.json() as any
    expect(keys).toEqual([{ kty: 'RSA', use: 'sig', alg: 'RS256', kid: expect.any(String), n: expect.any(String), e: 'AQAB' }])
    expect(await jwks()).toEqual(keys)
    expect((await call('/pups/jwks.json', { method: 'PUT', body: '{}' })).status).toBe(405)
  })

  it('need their own consent group, with confirmation, and come with a refresh token', async () => {
    const page = await (await call(`/oauth/authorize?${new URLSearchParams({
      response_type: 'code', client_id: app.clientId, redirect_uri: app.redirectUri, scope: 'identify identity-tokens',
      code_challenge: 'a'.repeat(43), code_challenge_method: 'S256',
    })}`)).text()
    expect(page).toContain('name="scope" value="identity-tokens" checked> <span>Act as <strong>tim.example.com</strong> on other sites')
    expect(page).toContain('name="password"')
    const t = await connect(app, 'identify identity-tokens')
    expect([t.scope, !!t.refresh_token]).toEqual(['identify identity-tokens', true])
  })

  it('are signed tokens for one audience, which the published key checks', async () => {
    const t = await connect(app, 'identify identity-tokens')
    const r = await exchange(t.access_token)
    expect([r.status, r.headers.get('cache-control')]).toEqual([200, 'no-store'])
    const body = await r.json() as any
    expect(body).toMatchObject({ issued_token_type: 'urn:ietf:params:oauth:token-type:jwt', token_type: 'Bearer', expires_in: 60 })
    expect(part(body.access_token, 0)).toEqual({ typ: 'at+jwt', alg: 'RS256', kid: (await jwks())[0].kid })
    const claims = part(body.access_token, 1)
    expect(claims).toMatchObject({ iss: ORIGIN, sub: `${ORIGIN}/`, aud: 'https://polls.example.com', client_id: app.clientId })
    expect(claims.exp - claims.iat).toBe(60)
    expect(await verifies(body.access_token)).toBe(true)
    expect(part((await (await exchange(t.access_token)).json() as any).access_token, 1).jti).not.toBe(claims.jti)

    // Never accepted by the upload API.
    expect((await put('/appdata/reader.example/x.json', body.access_token, '{}')).status).toBe(401)

    // A read token, for fetching personal feeds: scope read, 24 hours.
    const read = await (await exchange(t.access_token, { audience: 'https://comments.example.org', scope: 'read' })).json() as any
    expect(read).toMatchObject({ issued_token_type: 'urn:ietf:params:oauth:token-type:jwt', token_type: 'Bearer', expires_in: 86400, scope: 'read' })
    const rc = part(read.access_token, 1)
    expect([rc.scope, rc.aud, rc.exp - rc.iat, await verifies(read.access_token)]).toEqual(['read', 'https://comments.example.org', 86400, true])
    expect(claims.scope).toBeUndefined()
    expect((await call('/files/appdata/reader.example/x.json', { headers: bearer(body.access_token) })).status).toBe(401)
  })

  it('are refused without the scope, for another app, a bad audience or extra parameters, and after revocation', async () => {
    const plain = await connect(writer, 'write:/appdata/writer.example/')
    expect(await (await exchange(plain.access_token, {}, writer)).json()).toMatchObject({ error: 'invalid_scope' })
    const t = await connect(app, 'identity-tokens')
    expect(await (await exchange(t.access_token, {}, writer)).json()).toMatchObject({ error: 'invalid_grant' })
    expect(await (await exchange('nonsense')).json()).toMatchObject({ error: 'invalid_grant' })
    for (const audience of ['https://polls.example.com/', 'https://polls.example.com/vote', 'http://polls.example.com', 'https://127.0.0.1', 'https://localhost'])
      expect(await (await exchange(t.access_token, { audience })).json(), audience).toMatchObject({ error: 'invalid_target' })
    expect(await (await exchange(t.access_token, [['audience', 'https://a.example'], ['audience', 'https://b.example']])).json()).toMatchObject({ error: 'invalid_target' })
    for (const extra of [{ resource: 'https://polls.example.com' }, { actor_token: 'x' }] as Record<string, string>[])
      expect(await (await exchange(t.access_token, extra)).json()).toMatchObject({ error: 'invalid_request' })
    for (const scope of ['identify', 'read write', 'write'])
      expect(await (await exchange(t.access_token, { scope })).json(), scope).toMatchObject({ error: 'invalid_scope' })
    expect((await exchange(t.access_token)).status).toBe(200)
    await call('/oauth/revoke', { method: 'POST', body: form({ token: t.refresh_token!, client_id: app.clientId }) })
    expect(await (await exchange(t.access_token)).json()).toMatchObject({ error: 'invalid_grant' })
  })

  it('are limited per minute, logged on the apps page, and the owner can replace the key', async () => {
    const t = await connect(app, 'identity-tokens')
    for (let i = 0; i < 59; i++) expect((await exchange(t.access_token, { audience: 'https://groups.example.com', ...i < 2 && { scope: 'read' } })).status).toBe(200)
    const last = (await (await exchange(t.access_token)).json() as any).access_token
    const limited = await exchange(t.access_token)
    expect([limited.status, (await limited.json() as any).error]).toEqual([429, 'slow_down'])

    let html = await (await call('/pups/apps', { method: 'POST', body: form({ show: '1', password: PASSWORD }) })).text()
    expect(html).toContain('<li><code>polls.example.com</code>: once, last')
    expect(html).toContain('<li><code>groups.example.com</code>: 59 times (2 times for reading), last')
    const kid = (await jwks())[0].kid
    expect(html).toContain(`<code>${kid}</code>`)
    html = await (await call('/pups/apps', { method: 'POST', body: form({ replace_signing_key: '1', password: PASSWORD }) })).text()
    const keys = await jwks()
    expect([keys.length, keys[0].kid == kid, html.includes(`The signing key was replaced; the new one is ${keys[0].kid}.`)]).toEqual([1, false, true])
    expect(await verifies(last)).toBe(false)
  })

  it('keep the key and the log in the private state, and parallel first uses of an instance share one key', async () => {
    expect(storage.has('_pups/signing-key.json')).toBe(true)
    // One log per grant that got tokens, the revoked one's included.
    expect([...storage.keys()].filter(k => k.startsWith('_pups/identity/'))).toHaveLength(3)
    for (const path of ['/files/_pups/signing-key.json', '/_pups/signing-key.json']) expect((await call(path)).status, path).toBe(404)
    storage.delete('_pups/signing-key.json')
    const [a, b, set] = await Promise.all([signingKey(env), signingKey(env), jwks()])
    const stored = JSON.parse(new TextDecoder().decode(storage.get('_pups/signing-key.json')!.bytes)).kid
    expect([a.kid, b.kid, set[0].kid]).toEqual([stored, stored, stored])
  })
})
