import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { bearer, call, connect, form, mockClientFetch, ORIGIN, PASSWORD, put, registerClient, settle, setupOwner, useEnv, web } from './helpers'

/** Kept feeds (RFC-7) on the Worker. pups-feeds has the detailed tests of the archives. */
const app = registerClient('feed-app.example')
let token: string

const feedBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'Notes', items: [], _pups: { pupsControlled: true }, ...extra })
const post = (path: string, item: unknown, headers: Record<string, string> = {}) =>
  call(`/files${path}`, { method: 'POST', body: JSON.stringify(item), headers: bearer(token, { 'content-type': 'application/json', ...headers }) })
const stored = async (path: string) => await (await env.FILES.get(path.slice(1)))!.json() as any

beforeAll(async () => {
  mockClientFetch()
  await setupOwner()
  token = (await connect(app, 'write:/feed.json write:/feed/ write:/appdata/feed-app.example/')).access_token
})

describe('kept feeds', () => {
  it('are announced in the configuration document', async () => {
    expect((await (await call('/personal-storage.json')).json() as any).kept_feeds).toBe(true)
  })

  it('take items by POST and keep the archives; the feed file is applied, not stored', async () => {
    const res = await put('/feed.json', token, feedBody({ description: 'Mine' }), { 'if-none-match': '*' })
    expect([res.status, res.headers.get('content-location'), res.headers.get('etag')]).toEqual([201, `${ORIGIN}/files/feed.json`, null])
    const doc = await res.json() as any
    expect([doc.feed_url, doc.home_page_url, doc.description, doc._pups.pupsControlled]).toEqual([`${ORIGIN}/feed.json`, `${ORIGIN}/`, 'Mine', true])

    const first = await post('/feed.json', { id: 'p0', content_text: 'Post 0' })
    const address = `${ORIGIN}/feed/feed.000000.json#p0`
    expect([first.status, first.headers.get('location'), first.headers.get('access-control-allow-origin')]).toEqual([201, address, '*'])
    expect((await first.json() as any).item._archive.index).toBe(0)
    for (let i = 1; i < 25; i++) expect((await post('/feed.json', { id: `p${i}`, content_text: `Post ${i}` })).status).toBe(201)
    const feed = await stored('/feed.json')
    expect([feed.items.length, feed.items[0].id, feed._archive.archive_url]).toEqual([25, 'p24', `${ORIGIN}/feed/feed.000001.json`])
    expect((await stored('/feed/feed.000000.json')).items).toHaveLength(20)
    // The archives are served like any file, at their public URL.
    expect((await (await call('/feed/feed.000001.json')).json() as any)._archive).toMatchObject({ number: 1, next_index: 25 })

    const del = await post('/feed.json', { id: 'p3', _pups: { delete: true } })
    expect([del.status, (await del.json() as any).address]).toEqual([200, `${ORIGIN}/feed/feed.000000.json#p3`])
    expect((await post('/feed.json', { id: 'p3', _pups: { delete: true } })).status).toBe(404)

    // A PUT that only renames the feed keeps every item.
    const current = await call('/files/feed.json', { headers: bearer(token) })
    const renamed = { ...await current.json() as any, title: 'Renamed' }
    expect((await put('/feed.json', token, JSON.stringify(renamed), { 'if-match': current.headers.get('etag')! })).status).toBe(200)
    expect([(await stored('/feed.json')).title, (await stored('/feed.json')).items.length]).toEqual(['Renamed', 24])
    expect((await put('/feed.json', token, JSON.stringify(renamed), { 'if-match': current.headers.get('etag')! })).status).toBe(412)
  })

  it('never lose an item or give out an index twice when apps post at the same time', async () => {
    await put('/feed/burst.json', token, feedBody())
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => post('/feed/burst.json', { id: `b${i}`, content_text: `Burst ${i}` })))
    expect(results.map(r => r.status)).toEqual(Array(12).fill(201))
    const feed = await stored('/feed/burst.json')
    expect(feed.items.map((i: any) => i._archive.index).sort((a: number, b: number) => a - b)).toEqual([...Array(12).keys()])
    expect((await stored('/feed/burst/feed.000000.json')).items).toHaveLength(12)
  })

  it('refuse writes of archives, and POST to anything but a feed file', async () => {
    expect((await put('/feed/feed.000000.json', token, feedBody())).status).toBe(403)
    expect((await call('/files/feed/feed.000000.json', { method: 'DELETE', headers: bearer(token) })).status).toBe(403)
    const res = await post('/appdata/feed-app.example/x.json', { content_text: 'Hi' })
    expect([res.status, res.headers.get('allow')]).toEqual([405, 'GET, HEAD, PUT, DELETE, OPTIONS'])
    expect((await post('/feed.json', { content_text: 'Hi' }, { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await post('/feed/nothing.json', { content_text: 'Hi' })).status).toBe(404)
    const plain = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'By hand', items: [] })
    expect((await put('/feed/plain.json', token, plain)).status).toBe(201)
    expect(await (await env.FILES.get('feed/plain.json'))!.text()).toBe(plain)
    expect(((await (await post('/feed/plain.json', { content_text: 'Hi' })).json()) as any).error).toBe('not_pups_controlled')
    expect((await put('/feed/plain/feed.000000.json', token, plain)).status).toBe(201)
    expect((await call('/files/feed.json', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(401)
  })

  it('take items through the POST fallback, and give them an id', async () => {
    const res = await call('/pups/post?method=POST&path=%2Ffeed.json', { method: 'POST', body: '{"content_text":"Hi"}', headers: bearer(token, { 'content-type': 'application/json' }) })
    const body = await res.json() as any
    expect(res.status).toBe(201)
    expect(body.item.id).toMatch(/^p-[\w-]{16}$/)
  })

  it('count against the storage quota', async () => {
    useEnv({ ...env, MAX_STORAGE_BYTES: '1' })
    try {
      const res = await post('/feed.json', { id: 'big', content_text: 'x'.repeat(5000) })
      expect([res.status, (await res.json() as any).error]).toEqual([507, 'insufficient_storage'])
      expect((await stored('/feed.json')).items.some((i: any) => i.id == 'big')).toBe(false)
    } finally {
      useEnv(undefined)
    }
  })

  it('link new items to their page while webpup is the homepage', async () => {
    await call('/pups/homepage', { method: 'POST', body: new URLSearchParams({ password: 'correct horse battery staple', webpup: 'install', theme: 'default' }) })
    const res = await post('/feed.json', { id: 'w1', content_text: 'With a page' })
    const item = (await res.json() as any).item
    expect(item.url).toBe(`${ORIGIN}/p/feed/post/${item._archive.index}`)
  })

  it('publish approved comments in comment feeds, which only the server writes', async () => {
    const COMMENTS = `${ORIGIN}/pups/comments`
    const submissions = { url: COMMENTS, republish: 'full', policies: { comments: { minLength: 2 } } }
    expect((await put('/feed/talk.json', token, feedBody({ _submissions: submissions }), { 'if-none-match': '*' })).status).toBe(201)
    expect((await post('/feed/talk.json', { id: 'p-1', content_text: 'Talk to me' })).status).toBe(201)
    expect((await stored('/feed/talk.json')).items[0]._source.comments).toEqual({ count: 0, total: 0 })

    const src = 'https://bob.example/talk.json'
    web.set(src, { body: JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'Bob', items: [
      { id: 'c-1', content_text: 'Agreed.', authors: [{ name: 'Bob' }], _source: { inReplyTo: `${ORIGIN}/feed/talk.json#p-1` } }] }) })
    const res = await call(COMMENTS, { method: 'POST', body: form({ source: `${src}#c-1`, target: `${ORIGIN}/feed/talk.json#p-1` }), headers: { origin: 'https://bob.example' } })
    expect(res.status).toBe(201)
    await settle()
    const statusUrl = res.headers.get('location')!
    expect((await (await call(statusUrl)).json() as any).status).toBe('pending')
    const inbox = await stored('/pups/private/inbox.json')
    const item = inbox.items.find((i: any) => i._inbox.target == `${ORIGIN}/feed/talk.json#p-1`)
    expect(item._actions.actions.map((a: any) => a.template ?? a.type)).toEqual(['display', 'approve', 'dismiss'])
    const approve = await call(inbox._actions.templates.approve.action.replace('{id}', item.id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const address = `${ORIGIN}/feed/talk/comments/0.json#${item.id}`
    expect([approve.status, (await approve.json() as any).actions[0].url]).toEqual([200, address])
    expect((await stored('/feed/talk/comments/0.json')).items.map((i: any) => [i.id, i.content_html])).toEqual([[item.id, '<p>Agreed.</p>']])
    expect((await stored('/feed/talk.json')).items[0]._source.comments).toEqual({ feedUrl: `${ORIGIN}/feed/talk/comments/0.json`, count: 1, total: 1 })
    expect(await (await call(statusUrl)).json()).toMatchObject({ status: 'success', pubUrl: address })
    expect((await put('/feed/talk/comments/0.json', token, feedBody())).status).toBe(403)
    expect((await call('/feed/talk/comments/0.json')).status).toBe(200)

    // A deleted post takes its comments along.
    expect((await post('/feed/talk.json', { id: 'p-1', _pups: { delete: true } })).status).toBe(200)
    expect((await call('/feed/talk/comments/0.json')).status).toBe(404)
  })

  it('auto-moderation: the owner turns it on, and comments rated acceptable are published at once', async () => {
    const COMMENTS = `${ORIGIN}/pups/comments`
    const submissions = { url: COMMENTS, republish: 'full', policies: { comments: { minLength: 2 } } }
    expect((await put('/feed/mod.json', token, feedBody({ _submissions: submissions }), { 'if-none-match': '*' })).status).toBe(201)
    expect((await post('/feed/mod.json', { id: 'p-1', content_text: 'Moderate me' })).status).toBe(201)

    const apps = (fields: Record<string, string>) => call('/pups/comment-settings', { method: 'POST', body: form({ password: PASSWORD, ...fields }) })
    let html = await (await call('/pups/apps', { method: 'POST', body: form({ password: PASSWORD, show: '1' }) })).text()
    expect([html.includes('<li><a href="/pups/comment-settings">Comments</a></li>'), html.includes('Auto-moderation')]).toEqual([true, false])
    html = await (await apps({ show: '1' })).text()
    expect(html).toContain('<li><a href="/pups/comment-settings" aria-current="page">Comments</a></li>')
    expect(html).toContain('<h2 id="moderation-heading">Auto-moderation</h2>')
    expect(html).toContain('Create a new key for this domain only, with a low spending limit')
    expect(html).not.toContain('name="moderation_enabled" value="1" checked')
    expect(await (await apps({ save_moderation: '1', moderation_enabled: '1' })).text()).toContain('Auto-moderation needs an API key.')
    html = await (await apps({ save_moderation: '1', moderation_enabled: '1', moderation_key: 'sk-or-v1-secret1234', moderation_daily_tokens: '20' })).text()
    expect(html).toContain('Auto-moderation is on: comments rated at least 90 % likely acceptable are published at once.')
    expect([html.includes('secret1234'), html.includes('ending in …1234'), html.includes('name="moderation_daily_tokens" min="1" max="10000" step="1" value="20"')])
      .toEqual([false, true, true])

    web.set('https://openrouter.ai/api/v1/chat/completions', { body: JSON.stringify({
      choices: [{ message: { content: '{"safe": 0.98, "reason": "Fine."}' } }], usage: { total_tokens: 700 } }) })
    const src = 'https://bob.example/mod.json'
    web.set(src, { body: JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'Bob', items: [
      { id: 'c-1', content_text: 'Well said.', authors: [{ name: 'Bob' }], _source: { inReplyTo: `${ORIGIN}/feed/mod.json#p-1` } }] }) })
    const res = await call(COMMENTS, { method: 'POST', body: form({ source: `${src}#c-1`, target: `${ORIGIN}/feed/mod.json#p-1` }), headers: { origin: 'https://bob.example' } })
    expect(res.status).toBe(201)
    await settle()
    const status = await (await call(res.headers.get('location')!)).json() as any
    expect([status.status, status.pubUrl]).toEqual(['success', `${ORIGIN}/feed/mod/comments/0.json#${status.guid}`])
    expect((await stored('/feed/mod/comments/0.json')).items[0].content_html).toBe('<p>Well said.</p>')
    expect(await (await apps({ show: '1' })).text()).toContain('Used today (UTC): 700 tokens.')
    await apps({ save_moderation: '1' })
  })
})
