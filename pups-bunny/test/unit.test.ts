import { describe, expect, it } from 'vitest'
import { ClientError, onClientHost, parseClientId, redirectUriAllowed, validateMetadata } from '../src/cimd'
import { fileType } from '../src/filetypes'
import { covers, isPrivate, parsePath, parseScope, parseScopes, pathFromPublicUrl, publicUrl } from '../src/paths'
import { parseWellKnown, settings } from '../src/settings'

const s = settings({ OWNER_HOST: 'tim.example.com' } as any, new URL('https://tim.example.com/'))

describe('paths', () => {
  const ok = (raw: string) => {
    const p = parsePath(raw, s)
    return 'path' in p ? p.path : undefined
  }
  it('accepts normal paths and decodes once', () => {
    expect(ok('/appdata/app.example/a.json')).toBe('/appdata/app.example/a.json')
    expect(ok('/appdata/app.example/h%C3%A4user.json')).toBe('/appdata/app.example/häuser.json')
    expect(ok('/a/%252e%252e/b.json')).toBe('/a/%2e%2e/b.json')
  })
  it.each([
    '/a/../b.json', '/a/%2e%2e/b.json', '/a/./b.json', '/a//b.json', '/a/b/', '/a\\b.json', '/a%5Cb.json', '/c:/x.json',
    '/a/%00.json', '/.htaccess', '/a/.user.ini', '/.git/config', '/a/feed.php.', '/a/feed.json ', '/a/%ff.json',
    '/.well-known/host-meta.json', '/.well-known/other.md', '/' + 'x'.repeat(520),
  ])('rejects %s', raw => expect(ok(raw)).toBeUndefined())
  it('allows declared /.well-known/ files', () => {
    expect(ok('/.well-known/about.md')).toBe('/.well-known/about.md')
  })
})

describe('scopes', () => {
  const host = 'app.example'
  it('accepts identify, the own directory and declared well-known paths', () => {
    expect(parseScope('identify', host, s)).toEqual({ kind: 'identify' })
    expect(parseScope('write:/appdata/app.example/', host, s)).toMatchObject({ prefix: '/appdata/app.example/' })
    expect(parseScope('write:/.well-known/about.md', host, s)).toMatchObject({ prefix: '/.well-known/about.md' })
  })
  it.each([
    'write:/', 'write:/appdata/', 'write:/appdata/other.example/', 'write:/appdata/app.example/sub/', 'write:/appdata/app.example',
    'write:/feeds/', 'write:/.well-known/host-meta.json', 'write:/.well-known/', 'read:/appdata/app.example/', 'write:appdata',
    'write:/.well-known/about.md/x',
  ])('rejects %s', scope => expect(parseScope(scope, host, s)).toBeUndefined())
  it('accepts the standard feed paths', () => {
    expect(parseScope('write:/feed.json', host, s)).toBeDefined()
    expect(parseScope('write:/feed/', host, s)).toBeDefined()
    expect(parseScope('write:/feed/2026/', host, s)).toBeDefined()
    expect(parseScope('write:/feed', host, s)).toBeUndefined()
    expect(parseScope('write:/feed.xml', host, s)).toBeUndefined()
  })
  it('accepts the profile images and pages directories, nothing else under /pups/', () => {
    expect(parseScope('write:/pups/images/', host, s)).toMatchObject({ wellKnown: { urlProperties: ['https://bigwide.net/ns/avatar', 'https://bigwide.net/ns/banner'] } })
    expect(parseScope('write:/pups/pages/', host, s)).toMatchObject({ wellKnown: { linkProperties: ['https://bigwide.net/ns/webpup-hidden'] } })
    for (const scope of ['write:/pups/', 'write:/pups/assets/', 'write:/pups/apps', 'write:/pups/imagesx/', 'write:/pups/pagesx/']) expect(parseScope(scope, host, s), scope).toBeUndefined()
  })
  it('accepts files and subdirectories of a declared directory', () => {
    const s2 = settings({ OWNER_HOST: 'tim.example.com', WELL_KNOWN_PATHS: '[{"path":"/feeds/bigwide/","rels":["https://bigwide.net/ns/feed"]}]' } as any,
      new URL('https://tim.example.com/'))
    expect(parseScope('write:/feeds/bigwide/', host, s2)).toBeDefined()
    expect(parseScope('write:/feeds/bigwide/2026/', host, s2)).toBeDefined()
    expect(parseScope('write:/feeds/bigwide/feed.xml', host, s2)).toBeDefined()
    expect(parseScope('write:/feeds/', host, s2)).toBeUndefined()
    expect(parseScope('write:/feeds/bigwide/../x/', host, s2)).toBeUndefined()
  })
  it('rejects a scope string with any invalid scope', () => {
    expect(parseScopes('identify write:/', host, s)).toBeUndefined()
    expect(parseScopes('', host, s)).toBeUndefined()
    expect([...parseScopes('identify  write:/appdata/app.example/', host, s)!.keys()]).toEqual(['identify', 'write:/appdata/app.example/'])
  })
  it('compares segment by segment', () => {
    expect(covers('/appdata/app.example/', '/appdata/app.example/x.json')).toBe(true)
    expect(covers('/appdata/app.example/', '/appdata/app.example.evil/x.json')).toBe(false)
    expect(covers('/.well-known/about.md', '/.well-known/about.md')).toBe(true)
    expect(covers('/.well-known/about.md', '/.well-known/about.md.json')).toBe(false)
  })
})

describe('private areas', () => {
  it.each(['/pups/private/inbox/a.json', '/pups/private/x.json', '/appdata/app.example/private/a.json', '/appdata/a.example/private/b/c.json', '/APPDATA/app.example/PRIVATE/a.json', '/Pups/Private/inbox/a.json'])(
    '%s is private', p => expect(isPrivate(p)).toBe(true))
  it.each(['/pups/privatex/a.json', '/pups/images/private/a.png', '/appdata/app.example/private', '/appdata/app.example/private.json',
    '/appdata/app.example/sub/private/a.json', '/feed/private/a.json', '/private/a.json'])('%s is public', p => expect(isPrivate(p)).toBe(false))
  it('gives private files no public URL', () => {
    expect(publicUrl('/appdata/a.example/private/x.json', s)).toBeUndefined()
  })
})

describe('public URLs', () => {
  it('maps paths to public URLs and back', () => {
    expect(publicUrl('/appdata/a.example/x.json', s)).toBe('https://tim.example.com/files/appdata/a.example/x.json')
    expect(publicUrl('/.well-known/about.md', s)).toBe('https://tim.example.com/.well-known/about.md')
    expect(pathFromPublicUrl('https://tim.example.com/.well-known/about.md', s)).toBe('/.well-known/about.md')
    expect(pathFromPublicUrl('https://tim.example.com/files/appdata/a.example/x.json', s)).toBe('/appdata/a.example/x.json')
    expect(pathFromPublicUrl('https://other.example/files/x.json', s)).toBeUndefined()
    expect(pathFromPublicUrl('https://tim.example.com/files/a/../b.json', s)).toBeUndefined()
    expect(publicUrl('/pups/images/a.png', s)).toBe('https://tim.example.com/pups/images/a.png')
    expect(pathFromPublicUrl('https://tim.example.com/pups/images/a.png', s)).toBe('/pups/images/a.png')
  })
})

describe('file types', () => {
  it.each(['a.json', 'a.XML', 'a.opml', 'a.md', 'a.jpeg', 'a.webm', 'about.md'])('allows %s', f => expect(fileType('/x/' + f)).toBeDefined())
  it.each(['a.html', 'a.js', 'a.css', 'a.php', 'a.phtml', 'feed.php.json', 'feed.html.xml', 'a', 'a.exe', 'a.svgz', 'a.constructor'])(
    'rejects %s', f => expect(fileType('/x/' + f)).toBeUndefined())
})

describe('well-known configuration', () => {
  it.each([
    '[{"path":"/.well-known/host-meta.json"}]', '[{"path":"/.well-known/acme-challenge/x"}]', '[{"path":"/.well-known/x/"}]',
    '[{"path":"/appdata/x/"}]', '[{"path":"/"}]', '[{"path":"/.git/x"}]', '[{"path":"/a/../b"}]',
    '[{"path":"/pups/"}]', '[{"path":"/pups/x.json"}]', '[{"path":"/pups/apps"}]', '[{"path":"/pups/imagesx/"}]', '[{"path":"/pups/pagesx/"}]',
    '[{"path":"/pups/pages/","link_properties":["https://bigwide.net/ns/pups#client"]}]',
    '[{"path":"/pups/private/"}]', '[{"path":"/pups/private/inbox/","url":"https://tim.example.com/inbox/"}]',
    '[{"path":"/pups/private/inbox/","rels":["https://bigwide.net/ns/feed"]}]', '[{"path":"/pups/private/inbox/","properties":["https://x.example/p"]}]',
    '[{"path":"/pups/private/inbox/","link_properties":["https://x.example/p"]}]', '[{"path":"/pups/private/inbox/","url_properties":["https://x.example/p"]}]',
  ])('rejects %s', json => expect(() => parseWellKnown(json, 'https://tim.example.com')).toThrow())
  it('accepts private paths inside /pups/private/, without a url', () => {
    expect(parseWellKnown('[{"path":"/pups/private/inbox/"},{"path":"/pups/private/settings.json"}]', 'https://tim.example.com'))
      .toMatchObject([{ path: '/pups/private/inbox/', url: undefined }, { path: '/pups/private/settings.json', url: undefined }])
  })
  it('declares no private paths by default but the inbox, which the built-in receiver writes', () => {
    expect(s.wellKnown.filter(e => isPrivate(e.path)).map(e => e.path)).toEqual(['/pups/private/inbox.json'])
  })
  it('accepts /pups/images/ and /pups/pages/ with link properties', () => {
    expect(parseWellKnown('[{"path":"/pups/images/"}]', 'https://tim.example.com')[0].path).toBe('/pups/images/')
    expect(parseWellKnown('[{"path":"/pups/pages/","link_properties":["https://bigwide.net/ns/webpup-hidden"]}]', 'https://tim.example.com')[0].linkProperties)
      .toEqual(['https://bigwide.net/ns/webpup-hidden'])
  })
})

describe('client identity', () => {
  it('validates client_id URLs', () => {
    expect(parseClientId('https://app.example/oauth/client.json', s).host).toBe('app.example')
    for (const bad of ['http://app.example/c.json', 'https://app.example/', 'https://app.example', 'https://App.example/c.json',
      'https://app.example:8443/c.json', 'https://u@app.example/c.json', 'https://app.example/c.json?x', 'https://app.example/c.json#x',
      'https://127.0.0.1/c.json', 'https://[::1]/c.json', 'https://localhost/c.json', 'https://app.example/a/../c.json',
      'https://tim.example.com/c.json'])
      expect(() => parseClientId(bad, s), bad).toThrow(ClientError)
  })
  it('allows client_uri and logo_uri only on the client host, with or without www.', () => {
    expect(onClientHost('https://app.example.com/', 'app.example.com')).toBe(true)
    expect(onClientHost('https://www.app.example.com/', 'app.example.com')).toBe(true)
    expect(onClientHost('https://app.example.com/', 'www.app.example.com')).toBe(true)
    expect(onClientHost('https://example.com/', 'app.example.com')).toBe(false)
    expect(onClientHost('https://github.io/', 'alice.github.io')).toBe(false)
    expect(onClientHost('https://other.example.com/', 'app.example.com')).toBe(false)
    expect(onClientHost('http://app.example.com/', 'app.example.com')).toBe(false)
  })
  const id = 'https://app.example/oauth/client.json'
  it('validates the metadata document', () => {
    const doc = { client_id: id, client_name: 'App', redirect_uris: ['https://app.example/cb', 'http://127.0.0.1/cb'] }
    const c = validateMetadata(doc, id)
    expect(c.clientHost).toBe('app.example')
    expect(() => validateMetadata({ ...doc, client_id: 'https://app.example/other.json' }, id)).toThrow(ClientError)
    expect(() => validateMetadata({ ...doc, redirect_uris: ['http://localhost/cb'] }, id)).toThrow(ClientError)
    expect(() => validateMetadata({ ...doc, logo_uri: 'https://cdn.example/logo.png' }, id)).toThrow(ClientError)
    expect(() => validateMetadata({ ...doc, client_uri: 'https://example/' }, id)).toThrow(ClientError)
  })
  it('matches redirect URIs exactly, ignoring only loopback ports', () => {
    const c = validateMetadata({ client_id: id, redirect_uris: ['https://app.example/cb', 'http://127.0.0.1/cb', 'http://[::1]/cb'] }, id)
    expect(redirectUriAllowed(c, 'https://app.example/cb')).toBe(true)
    expect(redirectUriAllowed(c, 'https://app.example/cb/')).toBe(false)
    expect(redirectUriAllowed(c, 'https://app.example/cb?x=1')).toBe(false)
    expect(redirectUriAllowed(c, 'http://127.0.0.1:53124/cb')).toBe(true)
    expect(redirectUriAllowed(c, 'http://[::1]:5000/cb')).toBe(true)
    expect(redirectUriAllowed(c, 'http://127.0.0.1:53124/other')).toBe(false)
    expect(redirectUriAllowed(c, 'http://localhost:53124/cb')).toBe(false)
  })
})
