import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm } from 'cloudflare:test'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { bearer, call, connect, form, mockClientFetch, ORIGIN, ownerStore, PASSWORD, put, registerClient, settle, setupOwner } from './helpers'

/** The WebSub hub on the Worker. pups-feeds has the detailed tests of the requests and limits. */
const app = registerClient('websub-app.example')
const HUB = `${ORIGIN}/pups/websub`
const FEED = `${ORIGIN}/feed.json`
let token: string
/** Verification requests and pings to callbacks on reader.test hosts. */
const verified: URL[] = []
const pings: { url: string; headers: Headers }[] = []
const statuses = new Map<string, number>()

const feedBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'Notes', items: [], _pups: { pupsControlled: true }, ...extra })
const post = (item: unknown) =>
  call('/files/feed.json', { method: 'POST', body: JSON.stringify(item), headers: bearer(token, { 'content-type': 'application/json' }) })
const stored = async (path: string) => await (await env.FILES.get(path.slice(1)))!.json() as any
const subscribe = async (callback: string, extra: Record<string, string> = {}) => {
  const r = await call('/pups/websub', { method: 'POST', body: form({ 'hub.mode': 'subscribe', 'hub.topic': FEED, 'hub.callback': callback, ...extra }) })
  await settle()
  return r
}
const settings = (fields: Record<string, string>) => call('/pups/feed-settings', { method: 'POST', body: form({ password: PASSWORD, save_websub: '1', ...fields }) })
/** Runs the Durable Object's alarm until no pings are left. */
async function runAlarms() {
  for (let i = 0; i < 200 && await ownerStore().wsPending(); i++)
    if (!await runDurableObjectAlarm(ownerStore() as any)) await new Promise(r => setTimeout(r, 10))
}

beforeAll(async () => {
  mockClientFetch()
  const base = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = new URL(typeof input == 'string' ? input : input instanceof URL ? input.href : input.url)
    if (!url.hostname.endsWith('reader.test')) return base(input, init)
    if (init?.method == 'POST') {
      pings.push({ url: url.href, headers: new Headers(init.headers) })
      return new Response(null, { status: statuses.get(url.href) ?? 204 })
    }
    verified.push(url)
    return new Response(url.pathname.includes('liar') ? 'no' : url.searchParams.get('hub.challenge'))
  })
  await setupOwner()
  token = (await connect(app, 'write:/feed.json write:/feed/')).access_token
  expect((await put('/feed.json', token, feedBody(), { 'if-none-match': '*' })).status).toBe(201)
})

describe('the WebSub hub', () => {
  it('is named in the kept feed file and its Link header, not in archives', async () => {
    expect((await post({ id: 'a', content_text: 'Hi' })).status).toBe(201)
    expect((await stored('/feed.json')).hubs).toEqual([{ type: 'WebSub', url: HUB }])
    expect((await stored('/feed/feed.000000.json')).hubs).toBeUndefined()
    expect((await call('/feed.json')).headers.get('link')).toBe(`<${HUB}>; rel="hub", <${FEED}>; rel="self"`)
    expect((await call('/feed.json', { method: 'HEAD' })).headers.get('link')).toBe(`<${HUB}>; rel="hub", <${FEED}>; rel="self"`)
    expect((await call('/feed/feed.000000.json')).headers.get('link')).toBeNull()
  })

  it('verifies subscriptions at the callback', async () => {
    const r = await subscribe('https://a.reader.test/cb?x=1', { 'hub.lease_seconds': '7200', 'hub.secret': 's3cret' })
    expect(r.status).toBe(202)
    const v = verified.at(-1)!
    expect([v.searchParams.get('x'), v.searchParams.get('hub.mode'), v.searchParams.get('hub.topic'), v.searchParams.get('hub.lease_seconds')]).toEqual(['1', 'subscribe', FEED, '7200'])
    expect(await ownerStore().wsGet(FEED, 'https://a.reader.test/cb?x=1')).toMatchObject({ host: 'a.reader.test', secret: 's3cret' })
    expect((await subscribe('https://liar.reader.test/liar')).status).toBe(202)
    expect(await ownerStore().wsGet(FEED, 'https://liar.reader.test/liar')).toBeUndefined()
    const bad = await call('/pups/websub', { method: 'POST', body: form({ 'hub.mode': 'subscribe', 'hub.topic': `${ORIGIN}/feed/feed.000000.json`, 'hub.callback': 'https://b.reader.test/' }) })
    expect([bad.status, (await bad.json() as any).error]).toEqual([400, 'invalid_request'])
    expect((await call('/pups/websub')).status).toBe(405)
  })

  it('pings the subscribers from the alarm after a post, and drops those that are gone', async () => {
    await subscribe('https://b.reader.test/gone')
    statuses.set('https://b.reader.test/gone', 410)
    pings.length = 0
    await post({ id: 'b', content_text: 'Again' })
    await runAlarms()
    expect(pings.map(p => p.url).sort()).toEqual(['https://a.reader.test/cb?x=1', 'https://b.reader.test/gone'])
    const a = pings.find(p => p.url.startsWith('https://a.'))!
    expect(a.headers.get('link')).toBe(`<${HUB}>; rel="hub", <${FEED}>; rel="self"`)
    expect(a.headers.get('x-hub-signature')).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(await ownerStore().wsGet(FEED, 'https://b.reader.test/gone')).toBeUndefined()
  })

  it('pings many subscribers over several alarms', async () => {
    for (let i = 0; i < 90; i++) await ownerStore().wsPut({ topic: FEED, callback: `https://m${i}.reader.test/cb`, host: `m${i}.reader.test`, expiresAt: Date.now() + 3600_000, createdAt: Date.now() })
    pings.length = 0
    await post({ id: 'c', content_text: 'Many' })
    // The alarms also run on their own here; each pings at most 40.
    await runAlarms()
    expect(new Set(pings.map(p => p.url)).size).toBe(91)
    expect(pings).toHaveLength(91)
  })

  it('turns new subscribers away when full, except trusted feed readers', async () => {
    const page = await settings({ websub_enabled: '1', websub_max: '91', websub_trusted: 'trusted.reader.test' })
    expect(page.status).toBe(200)
    const full = await subscribe('https://new.reader.test/cb')
    expect([full.status, (await full.json() as any).error]).toEqual([403, 'subscriber_limit'])
    expect((await subscribe('https://push.trusted.reader.test/cb')).status).toBe(202)
    expect(await ownerStore().wsGet(FEED, 'https://push.trusted.reader.test/cb')).toBeDefined()
    expect(await (await call('/pups/feed-settings', { method: 'POST', body: form({ password: PASSWORD, show: '1' }) })).text())
      .toContain('92 subscriptions now, 1 of them from trusted feed readers.')
  })

  it('is turned off and on on the feeds page; off, feeds lose their hubs and nobody is pinged', async () => {
    const page = await settings({ websub_max: '1000', websub_trusted: '' })
    expect(await page.text()).toContain('WebSub is off')
    expect((await stored('/feed.json')).hubs).toBeUndefined()
    expect((await call('/feed.json')).headers.get('link')).toBeNull()
    expect((await call('/pups/websub', { method: 'POST', body: form({ 'hub.mode': 'subscribe', 'hub.topic': FEED, 'hub.callback': 'https://z.reader.test/' }) })).status).toBe(404)
    pings.length = 0
    await post({ id: 'd', content_text: 'Quiet' })
    await runAlarms()
    expect(pings).toHaveLength(0)
    expect(await (await settings({ websub_max: '10001' })).text()).toContain('from 0 to 10,000')
    await settings({ websub_enabled: '1', websub_max: '1000', websub_trusted: 'feedly.com' })
    expect((await stored('/feed.json')).hubs).toEqual([{ type: 'WebSub', url: HUB }])
    expect((await stored('/feed.json')).items.map((i: any) => i.id)).toEqual(['d', 'c', 'b', 'a'])
  })
})
