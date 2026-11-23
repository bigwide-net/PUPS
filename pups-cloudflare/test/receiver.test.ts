import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HOST_META_KEY } from '../src/hostmeta'
import { call, cimdFetches, form, jsonFeed, mockClientFetch, ORIGIN, PASSWORD, settle, setupOwner, useEnv, web } from './helpers'

/** The built-in receiver (pups-inbox) and the homepage (webpup) on Cloudflare. pups-inbox has the detailed tests. */
const MENTION = `${ORIGIN}/pups/mention`
const COMMENTS = `${ORIGIN}/pups/comments`
const INBOX_KEY = 'pups/private/inbox.json'

const send = (endpoint: string, source: string, target: string) =>
  call(endpoint, { method: 'POST', body: form({ source, target }), headers: { origin: 'https://bob.example' } })
const inbox = async () => {
  const obj = await env.FILES.get(INBOX_KEY)
  return obj ? await obj.json() as any : undefined
}
const stub = (): any => env.STORE.get(env.STORE.idFromName('owner'))
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
    const doc = { links: [{ rel: 'https://bigwide.net/ns/personal-storage', type: 'application/json', href: `${ORIGIN}/personal-storage.json` }] }
    await env.FILES.put(HOST_META_KEY, JSON.stringify(doc))
    await (runInDurableObject as any)(stub(), (o: any) => o.setSetting('mention-link', undefined))
    useEnv({ ...env })
    const links = async () => (await (await call('/.well-known/host-meta.json')).json() as any).links.map((l: any) => l.rel)
    expect(await links()).toEqual(['https://bigwide.net/ns/personal-storage', 'https://bigwide.net/ns/mention'])
    await env.FILES.put(HOST_META_KEY, JSON.stringify(doc))
    useEnv({ ...env })
    expect(await links()).toEqual(['https://bigwide.net/ns/personal-storage'])
    useEnv(undefined)
    await env.FILES.delete(HOST_META_KEY)
  })

  it('puts mentions into the inbox after the response, and dismisses them', async () => {
    const src = 'https://bob.example/feed.json'
    web.set(src, { headers: { 'content-type': 'application/feed+json' }, body: jsonFeed([{ id: 'p-1', title: 'Hi', content_text: 'Thanks, @tim.example.com!' }]) })
    const res = await send(MENTION, `${src}#p-1`, `${ORIGIN}/`)
    expect([res.status, res.headers.get('access-control-allow-origin')]).toEqual([202, '*'])
    await settle()
    expect(cimdFetches).toContain(src)
    const feed = await inbox()
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
    expect((await inbox()).items).toEqual([])
  })

  it("puts comments on the owner's posts into the inbox, with a status page", async () => {
    await env.FILES.put('feed.json', jsonFeed([{ id: 'p-12', content_text: 'Is RSS the better social network?' }], {
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
    expect((await inbox()).items.map((i: any) => [i._inbox.type, i.authors[0].name])).toEqual([['submission', 'Bob']])
    expect(await (await env.FILES.get('feed.json'))!.text()).not.toContain('Agreed')
    expect((await call(`${COMMENTS}/status/s-AAAAAAAAAAAAAAAA`)).status).toBe(404)
    await env.FILES.delete('feed.json')
  })

  it('can be switched off', async () => {
    useEnv({ ...env, MENTIONS: 'false', COMMENTS: 'false' })
    try {
      const c = await (await call('/personal-storage.json')).json() as any
      expect([c.mention_endpoint, c.comment_endpoint, c.well_known_paths.some((e: any) => e.path == '/pups/private/inbox.json')]).toEqual([undefined, undefined, false])
      const hm = await (await call('/.well-known/host-meta.json')).json() as any
      expect(hm.links.map((l: any) => l.rel), JSON.stringify(hm)).toEqual(['https://bigwide.net/ns/personal-storage'])
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
    expect(page).toContain('<input type="checkbox" name="theme_selector" value="1">')
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
    expect(await (await call('/index.html')).text()).toBe(html)
    expect((await call('/', { headers: { 'if-none-match': home.headers.get('etag')! } })).status).toBe(304)
    expect((await call('/webpups.js')).headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await (await call('/theme.css')).text()).toMatch(/^\/\* webpup theme: night\./)
    expect((await call('/webpup-themes/paper.css')).status).toBe(200)
    expect(await (await call('/webpup-config.json')).json())
      .toEqual({ 'theme-selector': true, 'settings-url': `${ORIGIN}/pups/homepage`, 'owner-link': `${ORIGIN}/pups/` })
    expect((await (await call('/.well-known/host-meta.json')).json() as any).properties[prop]).toBe(`${ORIGIN}/p/{feed}/post/{index}`)
    expect(await (await call('/pups/')).text()).toContain('Your homepage is <a href="https://tim.example.com/">webpup</a>')

    const page = await (await homepage({ show: '1' })).text()
    expect(page).toContain('<input type="radio" name="theme" value="night" checked>')
    expect(page).toContain('<input type="checkbox" name="theme_selector" value="1" checked>')
    expect(page).toContain('Remove webpup')

    expect(await (await homepage({ webpup: 'install', theme: 'default' })).text()).toContain('Saved.')
    expect((await call('/theme.css')).ok).toBe(true)
    expect((await call('/webpup-themes/paper.css')).status).toBe(404)
    expect((await homepage({ webpup: 'install', theme: '../config' })).status).toBe(400)

    expect(await (await homepage({ webpup: 'remove' })).text()).toContain('webpup was removed.')
    expect((await call('/', { redirect: 'manual' })).status).toBe(303)
    expect((await (await call('/.well-known/host-meta.json')).json() as any).properties?.[prop]).toBeUndefined()
  })

  it('leaves the owner link out with WEBPUP_OWNER_LINK=false, and / to an existing website with ORIGIN_FALLBACK', async () => {
    await homepage({ webpup: 'install', theme: 'paper' })
    useEnv({ ...env, WEBPUP_OWNER_LINK: 'false' })
    try {
      expect(await (await call('/webpup-config.json')).json()).toEqual({ 'theme-selector': false, 'settings-url': `${ORIGIN}/pups/homepage` })
      useEnv({ ...env, ORIGIN_FALLBACK: 'true' })
      expect(await (await call('/pups/')).text()).toContain('Your homepage is your own website')
      expect(await (await call('/pups/homepage', { method: 'POST', body: form({ password: PASSWORD, show: '1' }) })).text()).not.toContain('name="theme"')
    } finally {
      useEnv(undefined)
    }
  })
})
