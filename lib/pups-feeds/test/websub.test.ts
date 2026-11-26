import { describe, expect, it } from 'vitest'
import {
  callbackHost, type FeedHost, feedHubs, type Hub, HubError, hubRequest, MAX_LEASE, MAX_PER_HOST, MIN_LEASE, ping, pingAll, postItem, putKeptFeed, readItem,
  rewriteKeptFeed, signature, type Subscription, TRUSTED_READERS, verifyIntent, WEBSUB_DEFAULTS, webSubSettings, webSubSettingsFromForm,
} from '../src'

const ORIGIN = 'https://alice.pups.test'
const HUB = `${ORIGIN}/pups/websub`
const FEED = `${ORIGIN}/feed.json`
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString()
const FORM = 'application/x-www-form-urlencoded'

/** A hub with in-memory subscriptions, and callbacks that answer as `answer` says. */
function hub(settings = WEBSUB_DEFAULTS, answer: (url: URL, init?: RequestInit) => Response | Promise<Response> = url => new Response(url.searchParams.get('hub.challenge'))) {
  const subs = new Map<string, Subscription>()
  const key = (topic: string, callback: string) => `${topic} ${callback}`
  let now = Date.parse('2026-11-20T10:00:00Z')
  const calls: { url: string; init?: RequestInit }[] = []
  const logs: [string, Record<string, unknown>][] = []
  const live = () => [...subs.values()].filter(s => s.expiresAt > now)
  const h: Hub = {
    url: HUB, settings, ownHost: 'alice.pups.test',
    topic: async url => url == FEED || url == `${ORIGIN}/feed/photos.json` ? url : undefined,
    store: {
      get: async (t, c) => subs.get(key(t, c)),
      put: async s => void subs.set(key(s.topic, s.callback), s),
      delete: async (t, c) => void subs.delete(key(t, c)),
      count: async () => live().length,
      countHost: async (t, host) => live().filter(s => s.topic == t && s.host == host).length,
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return answer(new URL(String(input)), init)
    }) as typeof fetch,
    now: () => now,
    log: (event, data) => logs.push([event, data]),
  }
  const subscribe = async (callback: string, extra: Record<string, string> = {}) => {
    const intent = await hubRequest(h, FORM, form({ 'hub.mode': 'subscribe', 'hub.topic': FEED, 'hub.callback': callback, ...extra }))
    return verifyIntent(h, intent)
  }
  return { h, subs, calls, logs, subscribe, advance: (ms: number) => now += ms }
}

const refused = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    if (e instanceof HubError) return [e.status, e.code]
    throw e
  }
  return 'accepted'
}

describe('WebSub settings', () => {
  it('default to on, 1000 subscribers and the trusted readers', () => {
    expect(webSubSettings(undefined)).toEqual({ enabled: true, maxSubscribers: 1000, trustedDomains: TRUSTED_READERS })
    expect(webSubSettings({ enabled: false, maxSubscribers: 50000, trustedDomains: ['feedly.com', 'not a domain'] }))
      .toEqual({ enabled: false, maxSubscribers: 1000, trustedDomains: ['feedly.com'] })
  })

  it('come from the form, checked', () => {
    const f = (fields: Record<string, string>) => webSubSettingsFromForm(name => fields[name])
    expect(f({ websub_enabled: '1', websub_max: '250', websub_trusted: 'Feedly.com\n*.inoreader.com, feedly.com  \n\n' }))
      .toEqual({ enabled: true, maxSubscribers: 250, trustedDomains: ['feedly.com', 'inoreader.com'] })
    expect(f({ websub_max: '0' })).toEqual({ enabled: false, maxSubscribers: 0, trustedDomains: [] })
    expect(f({ websub_max: '10001' })).toMatch(/0 to 10,000/)
    expect(f({ websub_max: '-1' })).toMatch(/whole number/)
    expect(f({ websub_max: '10', websub_trusted: 'https://feedly.com/' })).toMatch(/not a domain/)
  })
})

describe('the hub', () => {
  it('checks the request', async () => {
    const t = hub()
    const req = (fields: Record<string, string>, type = FORM) =>
      refused(hubRequest(t.h, type, form({ 'hub.mode': 'subscribe', 'hub.topic': FEED, 'hub.callback': 'https://reader.example/cb/1', ...fields })))
    expect(await req({})).toBe('accepted')
    expect(await req({}, 'application/json')).toEqual([415, 'unsupported_type'])
    expect(await req({ 'hub.mode': 'publish' })).toEqual([400, 'invalid_request'])
    for (const callback of ['ftp://reader.example/', 'https://user:pw@reader.example/', 'https://reader.example/#x', 'https://alice.pups.test/cb', 'not a url', 'https://r.example/' + 'x'.repeat(2048)])
      expect(await req({ 'hub.callback': callback }), callback).toEqual([400, 'invalid_request'])
    // Only feed files are topics: no archives, no comment feeds, no other sites.
    for (const topic of [`${ORIGIN}/feed/feed.000000.json`, `${ORIGIN}/feed/comments/3.json`, 'https://other.example/feed.json'])
      expect(await req({ 'hub.topic': topic }), topic).toEqual([400, 'invalid_request'])
    expect(await req({ 'hub.lease_seconds': 'soon' })).toEqual([400, 'invalid_request'])
    expect(await req({ 'hub.secret': 'x'.repeat(200) })).toEqual([400, 'invalid_request'])
    expect(callbackHost('http://Reader.Example:8080/cb?a=1', 'alice.pups.test')).toBe('reader.example')
  })

  it('verifies the intent at the callback, then subscribes, renews and unsubscribes', async () => {
    const t = hub()
    expect(await t.subscribe('https://reader.example/cb?feed=1', { 'hub.lease_seconds': '60' })).toBe(true)
    const v = new URL(t.calls[0]!.url)
    expect([v.origin + v.pathname, v.searchParams.get('feed'), v.searchParams.get('hub.mode'), v.searchParams.get('hub.topic'), v.searchParams.get('hub.lease_seconds')])
      .toEqual(['https://reader.example/cb', '1', 'subscribe', FEED, String(MIN_LEASE)])
    const sub = [...t.subs.values()][0]!
    expect(sub).toMatchObject({ topic: FEED, callback: 'https://reader.example/cb?feed=1', host: 'reader.example', expiresAt: sub.createdAt + MIN_LEASE * 1000 })
    t.advance(1000)
    expect(await t.subscribe('https://reader.example/cb?feed=1', { 'hub.lease_seconds': '99999999' })).toBe(true)
    expect([...t.subs.values()][0]).toMatchObject({ createdAt: sub.createdAt, expiresAt: sub.createdAt + 1000 + MAX_LEASE * 1000 })
    expect(t.logs.map(l => l[0])).toEqual(['websub.subscribed', 'websub.renewed'])
    const intent = await hubRequest(t.h, FORM, form({ 'hub.mode': 'unsubscribe', 'hub.topic': FEED, 'hub.callback': 'https://reader.example/cb?feed=1' }))
    expect(await verifyIntent(t.h, intent)).toBe(true)
    expect(t.subs.size).toBe(0)
  })

  it('subscribes nobody whose callback doesn’t echo the challenge', async () => {
    for (const answer of [() => new Response('nope'), () => new Response('', { status: 404 }), () => new Response(null, { status: 302, headers: { location: 'https://x.example/' } }),
      () => Promise.reject(new Error('timeout'))]) {
      const t = hub(WEBSUB_DEFAULTS, answer)
      expect(await t.subscribe('https://reader.example/cb')).toBe(false)
      expect(t.subs.size).toBe(0)
      expect(t.logs[0]![0]).toBe('websub.unverified')
    }
  })

  it('turns new subscribers away when it is full, except trusted readers', async () => {
    const t = hub({ ...WEBSUB_DEFAULTS, maxSubscribers: 2 })
    expect(await t.subscribe('https://a.example/cb')).toBe(true)
    expect(await t.subscribe('https://b.example/cb')).toBe(true)
    expect(await refused(t.subscribe('https://c.example/cb'))).toEqual([403, 'subscriber_limit'])
    expect(await t.subscribe('https://push.feedly.com/cb')).toBe(true)
    expect(await t.subscribe('https://a.example/cb')).toBe(true)
    // An expired subscription makes room.
    t.advance(MAX_LEASE * 1000 + 1)
    expect(await t.subscribe('https://c.example/cb')).toBe(true)
  })

  it('takes at most five subscriptions per callback host and feed', async () => {
    const t = hub({ ...WEBSUB_DEFAULTS, trustedDomains: ['example.net'] })
    for (let i = 0; i < MAX_PER_HOST; i++) expect(await t.subscribe(`https://r.example.net/cb/${i}`)).toBe(true)
    expect(await refused(t.subscribe('https://r.example.net/cb/x'))).toEqual([403, 'too_many_subscriptions'])
    const photos = await hubRequest(t.h, FORM, form({ 'hub.mode': 'subscribe', 'hub.topic': `${ORIGIN}/feed/photos.json`, 'hub.callback': 'https://r.example.net/cb/x' }))
    expect(await verifyIntent(t.h, photos)).toBe(true)
  })

  it('checks the limits again when the callback answers', async () => {
    const t = hub({ ...WEBSUB_DEFAULTS, maxSubscribers: 1 })
    const first = await hubRequest(t.h, FORM, form({ 'hub.mode': 'subscribe', 'hub.topic': FEED, 'hub.callback': 'https://a.example/cb' }))
    const second = await hubRequest(t.h, FORM, form({ 'hub.mode': 'subscribe', 'hub.topic': FEED, 'hub.callback': 'https://b.example/cb' }))
    expect([await verifyIntent(t.h, first), await verifyIntent(t.h, second)]).toEqual([true, false])
    expect(t.logs[1]).toEqual(['websub.refused', { topic: FEED, callbackHost: 'b.example', reason: 'subscriber_limit' }])
  })
})

describe('pings', () => {
  it('are empty POSTs with the Link header, signed with the secret', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return new Response(null, { status: url.includes('gone') ? 410 : url.includes('down') ? 503 : 204 })
    }) as unknown as typeof fetch
    expect(await pingAll(HUB, [
      { topic: FEED, callback: 'https://a.example/cb' }, { topic: FEED, callback: 'https://b.example/gone' },
      { topic: FEED, callback: 'https://c.example/down', secret: 's3cret' },
    ], fetchFn)).toEqual(['sent', 'gone', 'failed'])
    const h = (i: number) => seen[i]!.init.headers as Record<string, string>
    expect([seen[0]!.init.method, seen[0]!.init.body, h(0).link, h(0)['x-hub-signature']]).toEqual(['POST', '', `<${HUB}>; rel="hub", <${FEED}>; rel="self"`, undefined])
    // HMAC-SHA256 of the empty body with the key "s3cret".
    expect(h(2)['x-hub-signature']).toBe(await signature('s3cret'))
    expect(await signature('s3cret')).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(await ping(HUB, { topic: FEED, callback: 'https://x.example/' }, (() => Promise.reject(new Error('down'))) as unknown as typeof fetch)).toBe('failed')
  })
})

describe('hubs in kept feeds', () => {
  const files = new Map<string, string>()
  const host = (hub?: string): FeedHost => ({
    me: `${ORIGIN}/`, publicUrl: p => ORIGIN + p, pathFromPublicUrl: u => u.startsWith(ORIGIN) ? u.slice(ORIGIN.length) : undefined,
    read: async p => files.get(p), postUrlTemplate: async () => undefined, now: () => Date.parse('2026-11-20T10:00:00Z'), ...hub && { hub },
  })
  const write = (c: { files: { path: string; text: string }[] }) => c.files.forEach(f => files.set(f.path, f.text))

  it('are set by the server while the hub is on, in the feed file only', async () => {
    write(await putKeptFeed(host(HUB), '/feed.json', JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'Notes', _pups: { pupsControlled: true },
      hubs: [{ type: 'WebSub', url: 'https://elsewhere.example/hub' }], items: [{ id: 'a', content_text: 'Hi' }] }), undefined))
    expect(JSON.parse(files.get('/feed.json')!).hubs).toEqual(feedHubs(HUB))
    expect(JSON.parse(files.get('/feed/feed.000000.json')!).hubs).toBeUndefined()
    const r = await postItem(host(HUB), '/feed.json', readItem('application/json', '{"id":"b","content_text":"Again"}'), files.get('/feed.json'))
    write(r.committed!)
    expect(JSON.parse(files.get('/feed.json')!).hubs).toEqual(feedHubs(HUB))
  })

  it('go when the hub is turned off, and come back', async () => {
    const off = await rewriteKeptFeed(host(), '/feed.json', files.get('/feed.json'))
    expect(off!.files.map(f => f.path)).toEqual(['/feed.json'])
    write(off!)
    expect(JSON.parse(files.get('/feed.json')!).hubs).toBeUndefined()
    expect(JSON.parse(files.get('/feed.json')!).items.map((i: any) => i.id)).toEqual(['b', 'a'])
    expect(await rewriteKeptFeed(host(), '/feed.json', files.get('/feed.json'))).toBeUndefined()
    write((await rewriteKeptFeed(host(HUB), '/feed.json', files.get('/feed.json')))!)
    expect(JSON.parse(files.get('/feed.json')!).hubs).toEqual(feedHubs(HUB))
    expect(await rewriteKeptFeed(host(HUB), '/other.json', '{"version":"https://jsonfeed.org/version/1.1","items":[]}')).toBeUndefined()
  })
})
