import { beforeAll, describe, expect, it, vi } from 'vitest'
import { pingRun, WEBSUB_BATCH } from '../src/websub'
import { settings as serverSettings } from '../src/settings'
import { storage } from './fakes'
import { bearer, call, connect, env, form, mockClientFetch, ORIGIN, PASSWORD, put, registerClient, settle, setupOwner } from './helpers'

/** The WebSub hub on Bunny. pups-feeds has the detailed tests of the requests and limits. */
const app = registerClient('websub-app.example')
const HUB = `${ORIGIN}/pups/websub`
const FEED = `${ORIGIN}/feed.json`
let token: string
const verified: URL[] = []
const pings: { url: string; headers: Headers }[] = []
const statuses = new Map<string, number>()
/** Every fetch, to count the subrequests of a run. */
let fetches = 0

const feedBody = () => JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'Notes', items: [], _pups: { pupsControlled: true } })
const post = (item: unknown) =>
  call('/files/feed.json', { method: 'POST', body: JSON.stringify(item), headers: bearer(token, { 'content-type': 'application/json' }) })
const stored = (path: string) => JSON.parse(new TextDecoder().decode(storage.get(path.slice(1))!.bytes))
const subscribe = async (callback: string, extra: Record<string, string> = {}) => {
  const r = await call('/pups/websub', { method: 'POST', body: form({ 'hub.mode': 'subscribe', 'hub.topic': FEED, 'hub.callback': callback, ...extra }) })
  await settle()
  return r
}
const settings = (fields: Record<string, string>) => call('/pups/feed-settings', { method: 'POST', body: form({ password: PASSWORD, save_websub: '1', ...fields }) })

beforeAll(async () => {
  mockClientFetch()
  const base = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    fetches++
    const url = new URL(input instanceof Request ? input.url : String(input))
    // The script calling itself.
    if (url.origin == ORIGIN) return call(url.pathname, { method: init?.method, headers: init?.headers })
    if (!url.hostname.endsWith('reader.test')) return base(input, init)
    if (init?.method == 'POST') {
      pings.push({ url: url.href, headers: new Headers(init.headers) })
      return new Response(null, { status: statuses.get(url.href) ?? 204 })
    }
    verified.push(url)
    return new Response(url.searchParams.get('hub.challenge'))
  })
  await setupOwner()
  token = (await connect(app, 'write:/feed.json write:/feed/')).access_token
  expect((await put('/feed.json', token, feedBody(), { 'if-none-match': '*' })).status).toBe(201)
})

describe('the WebSub hub', () => {
  it('is named in the kept feed file and its Link header, not in archives', async () => {
    expect((await post({ id: 'a', content_text: 'Hi' })).status).toBe(201)
    await settle()
    expect(stored('/feed.json').hubs).toEqual([{ type: 'WebSub', url: HUB }])
    expect(stored('/feed/feed.000000.json').hubs).toBeUndefined()
    expect((await call('/feed.json')).headers.get('link')).toBe(`<${HUB}>; rel="hub", <${FEED}>; rel="self"`)
    expect((await call('/feed/feed.000000.json')).headers.get('link')).toBeNull()
  })

  it('verifies subscriptions at the callback, and refuses callbacks on private addresses', async () => {
    expect((await subscribe('https://a.reader.test/cb', { 'hub.secret': 's3cret' })).status).toBe(202)
    expect(verified.at(-1)!.searchParams.get('hub.topic')).toBe(FEED)
    expect((await subscribe('https://private.example/cb')).status).toBe(202)
    const bad = await call('/pups/websub', { method: 'POST', body: form({ 'hub.mode': 'subscribe', 'hub.topic': `${ORIGIN}/feed/comments/1.json`, 'hub.callback': 'https://b.reader.test/' }) })
    expect(bad.status).toBe(400)
    expect(await (await call('/pups/feed-settings', { method: 'POST', body: form({ password: PASSWORD, show: '1' }) })).text()).toContain('1 subscription now')
  })

  it('pings the subscribers after a post, and drops those that are gone', async () => {
    await subscribe('https://b.reader.test/gone')
    statuses.set('https://b.reader.test/gone', 410)
    pings.length = 0
    await post({ id: 'b', content_text: 'Again' })
    await settle()
    expect(pings.map(p => p.url).sort()).toEqual(['https://a.reader.test/cb', 'https://b.reader.test/gone'])
    const a = pings.find(p => p.url.startsWith('https://a.'))!
    expect(a.headers.get('link')).toBe(`<${HUB}>; rel="hub", <${FEED}>; rel="self"`)
    expect(a.headers.get('x-hub-signature')).toMatch(/^sha256=[0-9a-f]{64}$/)
    pings.length = 0
    await post({ id: 'c', content_text: 'Once more' })
    await settle()
    expect(pings.map(p => p.url)).toEqual(['https://a.reader.test/cb'])
  })

  it('pings many subscribers in runs that call the script again, each within 50 subrequests', async () => {
    const subs = Array.from({ length: 100 }, (_, i) => ({ topic: FEED, callback: `https://m${String(i).padStart(3, '0')}.reader.test/cb`,
      host: `m${i}.reader.test`, expiresAt: Date.now() + 3600_000, createdAt: Date.now() }))
    const key = [...storage.keys()].find(k => k.includes('_pups/websub/topics/'))!
    const file = JSON.parse(new TextDecoder().decode(storage.get(key)!.bytes))
    file.subs = [...file.subs, ...subs].sort((x: any, y: any) => x.callback < y.callback ? -1 : 1)
    storage.set(key, { bytes: new TextEncoder().encode(JSON.stringify(file)), changed: Date.now() })
    pings.length = 0
    // One run on its own: the pings, and the call of the next run.
    storage.set('_pups/websub/pending/x.json', { bytes: new TextEncoder().encode(JSON.stringify({ topic: FEED, hub: HUB, changedAt: 1, cursor: '' })), changed: Date.now() })
    fetches = 0
    const before = vi.mocked(fetch).mock.calls.length
    expect(await pingRun(serverSettings(env, new URL(ORIGIN)), env)).toBe(WEBSUB_BATCH)
    const calls = vi.mocked(fetch).mock.calls.slice(before).map(([u]) => String(u instanceof Request ? u.url : u))
    expect(calls.filter(u => u == `${ORIGIN}/pups/websub/work`)).toHaveLength(1)
    // The subrequests of the run, without those of the next one (which starts with the call).
    expect(calls.indexOf(`${ORIGIN}/pups/websub/work`) + 1).toBeLessThanOrEqual(50)
    await settle()
    expect(new Set(pings.map(p => p.url)).size).toBe(101)
    expect(pings).toHaveLength(101)
    expect([...storage.keys()].some(k => k.includes('/websub/pending/'))).toBe(false)
  })

  it('is turned off and on on the feeds page; off, feeds lose their hubs and nobody is pinged', async () => {
    expect(await (await settings({ websub_max: '1000', websub_trusted: '' })).text()).toContain('WebSub is off')
    expect(stored('/feed.json').hubs).toBeUndefined()
    expect((await call('/feed.json')).headers.get('link')).toBeNull()
    expect((await call('/pups/websub', { method: 'POST', body: form({ 'hub.mode': 'subscribe', 'hub.topic': FEED, 'hub.callback': 'https://z.reader.test/' }) })).status).toBe(404)
    pings.length = 0
    await post({ id: 'd', content_text: 'Quiet' })
    await settle()
    expect(pings).toHaveLength(0)
    await settings({ websub_enabled: '1', websub_max: '1000', websub_trusted: 'feedly.com' })
    expect(stored('/feed.json').hubs).toEqual([{ type: 'WebSub', url: HUB }])
    expect(stored('/feed.json').items.map((i: any) => i.id)).toEqual(['d', 'c', 'b', 'a'])
  })

  it('runs only with the installation\'s key', async () => {
    expect((await call('/pups/websub/work', { method: 'POST', headers: { 'pups-work': 'guess' } })).status).toBe(404)
  })
})
