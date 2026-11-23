import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { store } from '../src/settings'
import { privateHosts, storage, web } from './fakes'
import { call, cimdFetches, env, form, mockClientFetch, ORIGIN, PASSWORD, settle, setupOwner, testEnv, useEnv } from './helpers'

/** The built-in receiver (pups-inbox) and the homepage (webpup) on Bunny. pups-inbox has the detailed tests. */
const MENTION = `${ORIGIN}/pups/mention`
const COMMENTS = `${ORIGIN}/pups/comments`
const HOST_META = '.well-known/host-meta.json'

const send = (endpoint: string, source: string, target: string) =>
  call(endpoint, { method: 'POST', body: form({ source, target }), headers: { origin: 'https://bob.example' } })
const putFile = (key: string, text: string) => storage.set(key, { bytes: new TextEncoder().encode(text), changed: Date.now() })
const readFile = (key: string) => {
  const f = storage.get(key)
  return f && new TextDecoder().decode(f.bytes)
}
const inbox = () => {
  const text = readFile('pups/private/inbox.json')
  return text ? JSON.parse(text) : undefined
}
const jsonFeed = (items: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'A feed', ...extra, items })
const homepage = (fields: Record<string, string>) => call('/pups/homepage', { method: 'POST', body: form({ password: PASSWORD, ...fields }) })

beforeAll(async () => {
  mockClientFetch()
  await setupOwner()
})

describe('the receiver', () => {
  it('is declared in the configuration document, host-meta.json and the well-known paths', async () => {
    const c = await (await call('/personal-storage.json')).json() as any
    expect([c.mention_endpoint, c.comment_endpoint]).toEqual([MENTION, COMMENTS])
    expect(c.well_known_paths).toContainEqual({ path: '/pups/private/inbox.json' })
    const hm = await (await call('/.well-known/host-meta.json')).json() as any
    expect(hm.links).toContainEqual({ rel: 'https://bigwide.net/ns/mention', href: MENTION })
  })

  it('adds the mention link to a stored host-meta.json once, and never again after the owner removed it', async () => {
    const doc = JSON.stringify({ links: [{ rel: 'https://bigwide.net/ns/personal-storage', type: 'application/json', href: `${ORIGIN}/personal-storage.json` }] })
    putFile(HOST_META, doc)
    await store(env).setSetting('mention-link', undefined)
    const links = async () => (await (await call('/.well-known/host-meta.json')).json() as any).links.map((l: any) => l.rel)
    useEnv(testEnv())
    expect(await links()).toEqual(['https://bigwide.net/ns/personal-storage', 'https://bigwide.net/ns/mention'])
    putFile(HOST_META, doc)
    useEnv(testEnv())
    expect(await links()).toEqual(['https://bigwide.net/ns/personal-storage'])
    useEnv(undefined)
    storage.delete(HOST_META)
  })

  it('puts mentions into the inbox after the response, and dismisses them', async () => {
    const src = 'https://bob.example/feed.json'
    web.set(src, { headers: { 'content-type': 'application/feed+json' }, body: jsonFeed([{ id: 'p-1', title: 'Hi', content_text: 'Thanks, @tim.example.com!' }]) })
    const res = await send(MENTION, `${src}#p-1`, `${ORIGIN}/`)
    expect([res.status, res.headers.get('access-control-allow-origin')]).toEqual([202, '*'])
    await settle()
    expect(cimdFetches).toContain(src)
    const feed = inbox()
    expect(feed._inbox.writer).toBe('pups')
    const item = feed.items[0]
    expect([item.title, item._inbox.type, item._inbox.source]).toEqual(['Hi', 'mention', `${src}#p-1`])

    const apps = await (await call('/pups/apps', { method: 'POST', body: form({ password: PASSWORD }) })).text()
    expect(apps).toContain('<h2 id="inbox-heading">Inbox</h2>')

    const link = /href="([^"]+)">Dismiss</.exec(item.content_html)![1]!.replace(/&amp;/g, '&')
    const page = await call(link)
    expect([page.status, page.headers.get('access-control-allow-origin')]).toEqual([200, null])
    expect(await page.text()).toContain('Dismiss this mention?')
    const action = feed._actions.templates.dismiss.action.replace('{id}', encodeURIComponent(item.id))
    expect((await call(action.replace(/key=[\w-]+/, 'key=wrong'), { method: 'POST', body: '{}' })).status).toBe(403)
    const done = await call(action, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    expect([done.status, (await done.json() as any).message]).toEqual([200, 'Removed from your inbox'])
    expect(inbox().items).toEqual([])
  })

  it('never fetches posts from hosts with private addresses', async () => {
    privateHosts.add('intranet.example')
    web.set('https://intranet.example/feed.json', { body: jsonFeed([{ id: 'x', content_text: 'Hi @tim.example.com' }]) })
    expect((await send(MENTION, 'https://intranet.example/feed.json#x', `${ORIGIN}/`)).status).toBe(202)
    await settle()
    expect(cimdFetches).not.toContain('https://intranet.example/feed.json')
    expect(inbox().items).toEqual([])
  })

  it("puts comments on the owner's posts into the inbox, with a status page", async () => {
    putFile('feed.json', jsonFeed([{ id: 'p-12', content_text: 'Is RSS the better social network?' }], {
      _submissions: { url: COMMENTS, republish: 'no', policies: { comments: { minLength: 2 } } },
    }))
    const src = 'https://bob.example/comments.json'
    web.set(src, { body: jsonFeed([{ id: 'c-1', content_text: 'Agreed.', authors: [{ name: 'Bob' }], _source: { inReplyTo: `${ORIGIN}/feed.json#p-12` } }]) })
    const res = await send(COMMENTS, `${src}#c-1`, `${ORIGIN}/feed.json#p-12`)
    expect(res.status).toBe(201)
    const status = res.headers.get('location')!
    expect(status).toMatch(new RegExp(`^${COMMENTS}/status/s-[\\w-]{16}$`))
    await settle()
    expect((await (await call(status)).json() as any).status).toBe('success')
    expect(inbox().items.map((i: any) => [i._inbox.type, i.authors[0].name])).toEqual([['submission', 'Bob']])
    expect(readFile('feed.json')).not.toContain('Agreed')
    expect((await call(`${COMMENTS}/status/s-AAAAAAAAAAAAAAAA`)).status).toBe(404)
    expect([...storage.keys()].filter(k => k.startsWith('_pups/mentions/queue/'))).toEqual([])
    storage.delete('feed.json')
  })

  it('can be switched off', async () => {
    useEnv(testEnv({ MENTIONS: 'false', COMMENTS: 'false' }))
    try {
      const c = await (await call('/personal-storage.json')).json() as any
      expect([c.mention_endpoint, c.comment_endpoint, c.well_known_paths.some((e: any) => e.path == '/pups/private/inbox.json')]).toEqual([undefined, undefined, false])
      const hm = await (await call('/.well-known/host-meta.json')).json() as any
      expect(hm.links.map((l: any) => l.rel)).toEqual(['https://bigwide.net/ns/personal-storage'])
      expect((await send(MENTION, 'https://bob.example/f.json#1', `${ORIGIN}/`)).status).toBe(404)
      expect((await send(COMMENTS, 'https://bob.example/f.json#1', `${ORIGIN}/feed.json#p-12`)).status).toBe(404)
    } finally {
      useEnv(undefined)
    }
  })
})

describe('the homepage', () => {
  afterAll(() => homepage({ webpup: 'remove' }))

  it('/ forwards to the owner pages at /pups/ while there is none', async () => {
    const res = await call('/', { redirect: 'manual' })
    expect([res.status, res.headers.get('location')]).toEqual([303, '/pups/'])
    const start = await (await call('/pups/')).text()
    expect(start).toContain('Your domain has no homepage yet')
    expect(start).toContain('<a href="/pups/homepage">Install webpup</a>')
    expect(await (await call('/pups/homepage')).text()).toContain('<a href="/pups/homepage" aria-current="page">Homepage</a>')
    expect((await call('/p/about')).status).toBe(404)
    expect((await call('/webpup-config.json')).status).toBe(404)
  })

  it('lists the themes with their thumbnails, for the owner', async () => {
    expect(await (await call('/pups/homepage')).text()).not.toContain('name="theme"')
    expect((await homepage({ password: 'wrong', show: '1' })).status).toBe(401)
    const page = await (await homepage({ show: '1' })).text()
    expect(page).toContain('<input type="radio" name="theme" value="default" checked>')
    expect(page).toContain('<img src="/pups/assets/themes/night.jpg"')
    expect(page).not.toContain('Remove webpup')
    const jpg = await call('/pups/assets/themes/night.jpg')
    expect([jpg.status, jpg.headers.get('content-type')]).toEqual([200, 'image/jpeg'])
    expect((await call('/pups/assets/themes/..%2Fnight.jpg')).status).toBe(404)
  })

  it('installs webpup with a theme and the theme browser, changes it, and removes it', async () => {
    const prop = 'https://bigwide.net/ns/post-url-template'
    expect(await (await homepage({ webpup: 'install', theme: 'night', theme_selector: '1' })).text()).toContain('webpup is now the homepage of tim.example.com.')
    const home = await call('/')
    const html = await home.text()
    expect([home.status, home.headers.get('content-type'), home.headers.get('content-security-policy')]).toEqual([200, 'text/html; charset=utf-8', null])
    expect(html).toContain('<meta name="generator" content="webpup">')
    expect(await (await call('/p/feed/photos/post/3')).text()).toBe(html)
    expect((await call('/', { headers: { 'if-none-match': home.headers.get('etag')! } })).status).toBe(304)
    expect(await (await call('/theme.css')).text()).toMatch(/^\/\* webpup theme: night\./)
    expect((await call('/webpup-themes/paper.css')).status).toBe(200)
    expect(await (await call('/webpup-config.json')).json())
      .toEqual({ 'theme-selector': true, 'settings-url': `${ORIGIN}/pups/homepage`, 'owner-link': `${ORIGIN}/pups/` })
    expect((await (await call('/.well-known/host-meta.json')).json() as any).properties[prop]).toBe(`${ORIGIN}/p/{feed}/post/{index}`)
    expect(await (await call('/pups/')).text()).toContain('Your homepage is <a href="https://tim.example.com/">webpup</a>')

    expect(await (await homepage({ webpup: 'install', theme: 'default' })).text()).toContain('Saved.')
    expect((await call('/webpup-themes/paper.css')).status).toBe(404)
    expect((await homepage({ webpup: 'install', theme: '../config' })).status).toBe(400)

    expect(await (await homepage({ webpup: 'remove' })).text()).toContain('webpup was removed.')
    expect((await call('/', { redirect: 'manual' })).status).toBe(303)
    expect((await (await call('/.well-known/host-meta.json')).json() as any).properties?.[prop]).toBeUndefined()
  })

  it('leaves the owner link out with WEBPUP_OWNER_LINK=false, and / to an existing website with ORIGIN_URL', async () => {
    await homepage({ webpup: 'install', theme: 'paper' })
    useEnv(testEnv({ WEBPUP_OWNER_LINK: 'false' }))
    try {
      expect(await (await call('/webpup-config.json')).json()).toEqual({ 'theme-selector': false, 'settings-url': `${ORIGIN}/pups/homepage` })
      useEnv(testEnv({ ORIGIN_URL: 'https://origin.test' }))
      expect(await (await call('/pups/')).text()).toContain('Your homepage is your own website')
    } finally {
      useEnv(undefined)
    }
  })
})
