import { beforeAll, describe, expect, it } from 'vitest'
import { storage } from './fakes'
import { bearer, call, connect, form, mockClientFetch, ORIGIN, PASSWORD, put, registerClient, setupOwner, testEnv, useEnv } from './helpers'

/** Kept feeds (RFC-7) on Bunny. pups-feeds has the detailed tests of the archives. */
const app = registerClient('feed-app.example')
let token: string

const feedBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'Notes', items: [], _pups: { pupsControlled: true }, ...extra })
const post = (path: string, item: unknown, headers: Record<string, string> = {}) =>
  call(`/files${path}`, { method: 'POST', body: JSON.stringify(item), headers: bearer(token, { 'content-type': 'application/json', ...headers }) })
const stored = (path: string) => JSON.parse(new TextDecoder().decode(storage.get(path.slice(1))!.bytes))

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
    expect((await res.json() as any).feed_url).toBe(`${ORIGIN}/feed.json`)

    const first = await post('/feed.json', { id: 'p0', content_text: 'Post 0' })
    expect([first.status, first.headers.get('location')]).toEqual([201, `${ORIGIN}/feed/feed.000000.json#p0`])
    for (let i = 1; i < 25; i++) expect((await post('/feed.json', { id: `p${i}`, content_text: `Post ${i}` })).status).toBe(201)
    const feed = stored('/feed.json')
    expect([feed.items.length, feed.items[0].id, feed._archive.archive_url]).toEqual([25, 'p24', `${ORIGIN}/feed/feed.000001.json`])
    expect(stored('/feed/feed.000000.json').items).toHaveLength(20)

    const del = await post('/feed.json', { id: 'p3', _pups: { delete: true } })
    expect([del.status, (await del.json() as any).address]).toEqual([200, `${ORIGIN}/feed/feed.000000.json#p3`])

    const current = await call('/files/feed.json', { headers: bearer(token) })
    const renamed = { ...await current.json() as any, title: 'Renamed' }
    expect((await put('/feed.json', token, JSON.stringify(renamed), { 'if-match': current.headers.get('etag')! })).status).toBe(200)
    expect([stored('/feed.json').title, stored('/feed.json').items.length]).toEqual(['Renamed', 24])
  })

  it('take their turn within an instance when apps post at the same time', async () => {
    await put('/feed/burst.json', token, feedBody())
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => post('/feed/burst.json', { id: `b${i}`, content_text: `Burst ${i}` })))
    expect(results.map(r => r.status)).toEqual(Array(8).fill(201))
    expect(stored('/feed/burst.json').items.map((i: any) => i._archive.index).sort((a: number, b: number) => a - b)).toEqual([...Array(8).keys()])
  })

  it('refuse writes of archives, and POST to anything but a feed file', async () => {
    expect((await put('/feed/feed.000000.json', token, feedBody())).status).toBe(403)
    expect((await call('/files/feed/feed.000000.json', { method: 'DELETE', headers: bearer(token) })).status).toBe(403)
    const res = await post('/appdata/feed-app.example/x.json', { content_text: 'Hi' })
    expect([res.status, res.headers.get('allow')]).toEqual([405, 'GET, HEAD, PUT, DELETE, OPTIONS'])
    expect((await post('/feed.json', { content_text: 'Hi' }, { 'content-type': 'text/plain' })).status).toBe(415)
    const plain = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'By hand', items: [] })
    expect((await put('/feed/plain.json', token, plain)).status).toBe(201)
    expect(((await (await post('/feed/plain.json', { content_text: 'Hi' })).json()) as any).error).toBe('not_pups_controlled')
  })

  it('take items through the POST fallback', async () => {
    const res = await call('/pups/post?method=POST&path=%2Ffeed.json', { method: 'POST', body: '{"content_text":"Hi"}', headers: bearer(token, { 'content-type': 'application/json' }) })
    expect([res.status, (await res.json() as any).item.id]).toEqual([201, expect.stringMatching(/^p-[\w-]{16}$/)])
  })

  it('count against the storage quota', async () => {
    useEnv(testEnv({ MAX_STORAGE_BYTES: '1' }))
    try {
      const res = await post('/feed.json', { id: 'big', content_text: 'x'.repeat(5000) })
      expect([res.status, (await res.json() as any).error]).toEqual([507, 'insufficient_storage'])
    } finally {
      useEnv(undefined)
    }
  })

  it('link new items to their page while webpup is the homepage', async () => {
    await call('/pups/homepage', { method: 'POST', body: form({ password: PASSWORD, webpup: 'install', theme: 'default' }) })
    const item = (await (await post('/feed.json', { id: 'w1', content_text: 'With a page' })).json() as any).item
    expect(item.url).toBe(`${ORIGIN}/p/feed/post/${item._archive.index}`)
  })
})
