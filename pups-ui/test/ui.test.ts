import { describe, expect, it } from 'vitest'
import { appsPage, consentPage, isPrivate, page, permissionList, t, type ScopeView } from '../src'

const site = { ownerHost: 'tim.example.com', ownerOrigin: 'https://tim.example.com', subdomainMode: false }
const inbox = { path: '/pups/private/inbox/', rels: [], properties: [], description: 'your inbox' }
const feed = { path: '/feed.json', rels: ['https://bigwide.net/ns/feed'], properties: [] }
const scopes = (...xs: [string, ScopeView][]) => new Map(xs)

describe('page', () => {
  it('sends the security headers and only plain origins as form-action', async () => {
    const res = page('T', '<p>x</p>', { formAction: ['https://app.example', "https://x; script-src 'unsafe-inline'"] })
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self' https://app.example; frame-ancestors 'none'")
    expect(await res.text()).toContain('<link rel="stylesheet" href="/pups/assets/owner.css">')
  })
})

describe('isPrivate', () => {
  it.each(['/pups/private/inbox/a.json', '/appdata/app.example/private/a.json', '/APPDATA/app.example/PRIVATE/a.json'])(
    '%s is private', p => expect(isPrivate(p)).toBe(true))
  it.each(['/pups/privatex/a.json', '/appdata/app.example/private', '/appdata/app.example/x/private/a.json'])(
    '%s is public', p => expect(isPrivate(p)).toBe(false))
})

describe('consent page', () => {
  const base = {
    clientHost: 'app.example', redirectUri: 'https://app.example/cb', ownerHost: site.ownerHost, approvedBefore: true, request: 'signed',
  }

  it('groups the scopes, with read-only private data', async () => {
    const html = await consentPage({
      ...base, scopes: scopes(['identify', { kind: 'identify' }], ['write:/feed.json', { kind: 'write', prefix: '/feed.json', wellKnown: feed }],
        ['read:/pups/private/inbox/', { kind: 'read', prefix: '/pups/private/inbox/', wellKnown: inbox }]),
      confirm: { hasPassword: true },
    }).text()
    expect(html).toContain('<title>Allow app.example to write to tim.example.com?</title>')
    expect(html).toContain('<span>Manage your feeds</span>')
    expect(html).toContain('<span>Read your private data</span>')
    expect(html).toContain('<li>read your inbox (<code>/pups/private/inbox/</code>)</li>')
    expect(html.indexOf('Manage your feeds')).toBeLessThan(html.indexOf('Read your private data'))
    expect(html).toContain('Everything the app stores is public, except private data.')
    expect(html).toContain('<legend>Confirm that it is you</legend>')
  })

  it('says "access" without write scopes, and escapes self-declared values', async () => {
    const html = await consentPage({
      ...base, clientName: '<b>App</b>', scopes: scopes(['read:/pups/private/inbox/', { kind: 'read', prefix: '/pups/private/inbox/', wellKnown: inbox }]),
    }).text()
    expect(html).toContain('<title>Allow app.example to access tim.example.com?</title>')
    expect(html).toContain('“<bdi>&lt;b&gt;App&lt;/b&gt;</bdi>”')
    expect(html).not.toContain('data-confirm')
  })
})

describe('apps page', () => {
  it('lists the apps with their permissions, links and properties', async () => {
    const permissions = permissionList([['write:/appdata/app.example/', { kind: 'write', prefix: '/appdata/app.example/' }], ['write:/gone/', undefined]], site.ownerHost)
    const html = await appsPage(site, {
      apps: [{ id: 'g1', clientHost: 'app.example', clientName: 'App', permissions, createdAt: 0, lastUsedAt: null, hasFiles: true }],
      links: [{ rel: 'https://bigwide.net/ns/feed', href: 'https://tim.example.com/feed.json', addedBy: 'https://app.example/client.json' }],
      properties: [['https://bigwide.net/ns/name', 'Tim']], hostMetaStored: true, usedBytes: 1048576, confirm: { hasPassword: true },
    }).text()
    expect(html).toContain('<li>Store its own data')
    expect(html).toContain('<li><code>write:/gone/</code></li>')
    expect(html).toContain('name="revoke_delete" value="g1"')
    expect(html).toContain('<code>https://app.example/client.json</code>')
    expect(html).toContain('These pages share the origin of your website.')
    expect(html).toContain('Storage used: 1.0 MiB.')
  })
})

describe('texts', () => {
  it('replaces placeholders and leaves unknown ones', () => {
    expect(t('scope.read', { what: '<code>/x</code>' })).toBe('read <code>/x</code>')
    expect(t('scope.read')).toBe('read {what}')
  })
})
