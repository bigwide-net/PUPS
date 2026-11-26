/**
 * A minimal WebSub hub (https://www.w3.org/TR/websub/) for the owner's kept feeds (RFC-7 "Real-time updates"); a port of
 * pups-php's lib/websub.php.
 *
 * - Only the feed files of kept feeds are topics: no archives, no comment feeds. While the hub is on, the server writes
 *   `hubs` into them (kept.ts) and serves them with `Link: <hub>; rel="hub", <feed>; rel="self"`.
 * - Subscribing: the hub checks the request, answers `202`, and verifies the intent after the response with the GET of
 *   WebSub ("Verifying intent"). Leases are at most 10 days.
 * - Distribution sends no content: each subscriber gets an empty POST with the Link header (a "thin ping"), and fetches
 *   the feed itself. A subscriber that answers `410` is removed; other failures change nothing.
 * - Limits: at most `maxSubscribers` subscriptions over all feeds, and 5 per callback host and feed. Callbacks on the
 *   owner's trusted domains (well-known cloud feed readers) are accepted beyond the total. The callback's domain, unlike a
 *   User-Agent or an address, can't be faked: the hub calls the callback, and it must echo a random challenge.
 *
 * The module does no I/O of its own: a server passes in a Hub with its store, its fetch and its settings. Notifying all
 * subscribers of a feed takes one request per subscriber, so each server spreads it over as many runs as its platform
 * needs (pingAll()).
 */

export const HUB_PATH = '/pups/websub'
export const DEFAULT_MAX_SUBSCRIBERS = 1000
/** The highest limit the owner can set. */
export const MAX_SUBSCRIBERS = 10_000
/** Subscriptions per callback host and feed. */
export const MAX_PER_HOST = 5
/** Leases, in seconds: what a subscriber asks for, within these bounds; without, the longest. */
export const MIN_LEASE = 3600
export const MAX_LEASE = 10 * 24 * 3600
/** WebSub: `hub.secret` must be less than 200 bytes. */
export const MAX_SECRET_BYTES = 199
export const MAX_CALLBACK = 2048
export const MAX_TRUSTED_DOMAINS = 100
const VERIFY_TIMEOUT = 10_000
const PING_TIMEOUT = 5_000
/** Pings sent at the same time. */
export const PING_CONCURRENCY = 8
/**
 * Cloud feed readers whose callbacks are always accepted, as domains (subdomains included). The owner can change the
 * list; the log names the callback host of every subscription.
 */
export const TRUSTED_READERS = ['downread.com', 'feedly.com', 'inoreader.com', 'feedbin.com', 'newsblur.com', 'theoldreader.com', 'bazqux.com']

export interface WebSubSettings {
  enabled: boolean
  maxSubscribers: number
  /** Domains, lowercase, without a leading dot. */
  trustedDomains: string[]
}

export const WEBSUB_DEFAULTS: WebSubSettings = { enabled: true, maxSubscribers: DEFAULT_MAX_SUBSCRIBERS, trustedDomains: TRUSTED_READERS }

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/

/** Stored settings, whatever was stored: what is missing or invalid takes its default. */
export function webSubSettings(stored: unknown): WebSubSettings {
  const s = typeof stored == 'object' && stored != null ? stored as Record<string, unknown> : {}
  const max = s.maxSubscribers
  return {
    enabled: s.enabled !== false,
    maxSubscribers: Number.isInteger(max) && (max as number) >= 0 && (max as number) <= MAX_SUBSCRIBERS ? max as number : DEFAULT_MAX_SUBSCRIBERS,
    trustedDomains: Array.isArray(s.trustedDomains) ? s.trustedDomains.filter(d => typeof d == 'string' && DOMAIN.test(d)) : TRUSTED_READERS,
  }
}

/**
 * The settings of the feeds page's form (`websub_enabled`, `websub_max`, `websub_trusted`: domains, one per line or
 * separated by spaces or commas), or an error message.
 */
export function webSubSettingsFromForm(field: (name: string) => string | undefined): WebSubSettings | string {
  const max = (field('websub_max') ?? '').trim()
  if (!/^\d{1,5}$/.test(max) || Number(max) > MAX_SUBSCRIBERS)
    return `The number of subscribers must be a whole number from 0 to ${MAX_SUBSCRIBERS.toLocaleString('en-US')}.`
  const domains: string[] = []
  for (let d of (field('websub_trusted') ?? '').toLowerCase().split(/[\s,]+/)) {
    d = d.replace(/^\*?\./, '').replace(/\.$/, '')
    if (!d) continue
    if (!DOMAIN.test(d)) return `“${d.slice(0, 100)}” is not a domain, such as feedly.com.`
    if (!domains.includes(d)) domains.push(d)
  }
  if (domains.length > MAX_TRUSTED_DOMAINS) return `At most ${MAX_TRUSTED_DOMAINS} trusted domains, please.`
  return { enabled: field('websub_enabled') != undefined, maxSubscribers: Number(max), trustedDomains: domains }
}

/** Whether a callback host is one of the trusted domains or below one. */
export const isTrustedHost = (host: string, domains: string[]) => domains.some(d => host == d || host.endsWith('.' + d))

export const hubUrl = (base: string) => base + HUB_PATH

/** The Link header of a topic: the hub and the topic itself (WebSub "Discovery"). */
export const hubLinks = (hub: string, topic: string) => `<${hub}>; rel="hub", <${topic}>; rel="self"`

/** The `hubs` of a feed file while the hub is on (JSON Feed 1.1). */
export const feedHubs = (hub: string) => [{ type: 'WebSub', url: hub }]

export interface Subscription {
  /** The feed's public URL. */
  topic: string
  callback: string
  /** The callback's host, lowercase. */
  host: string
  secret?: string
  /** ms since the epoch. */
  expiresAt: number
  createdAt: number
}

/** Where a server keeps the subscriptions. Expired subscriptions don't count, and may be removed whenever convenient. */
export interface HubStore {
  get(topic: string, callback: string): Promise<Subscription | undefined>
  put(sub: Subscription): Promise<void>
  delete(topic: string, callback: string): Promise<void>
  /** The subscriptions of all feeds that haven't expired. */
  count(now: number): Promise<number>
  /** Those of one callback host and feed. */
  countHost(topic: string, host: string, now: number): Promise<number>
}

/** What the hub needs from the server. */
export interface Hub {
  /** `https://tim.example.com/pups/websub` */
  url: string
  settings: WebSubSettings
  store: HubStore
  /** A topic as the hub knows it, the feed file's public URL, if `url` names a kept feed file of this server; else undefined. */
  topic(url: string): Promise<string | undefined>
  /** The owner's host: callbacks there are refused. */
  ownHost: string
  /** fetch() limited to public addresses. */
  fetch: typeof fetch
  now(): number
  log(event: string, data: Record<string, unknown>): void
}

/** A refused request: the hub answers with the status and the RFC-6 error code. */
export class HubError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

/** A request the hub accepted, to verify after the response. */
export interface Intent {
  mode: 'subscribe' | 'unsubscribe'
  topic: string
  callback: string
  host: string
  /** Seconds. */
  lease: number
  secret?: string
}

/** The host of a callback URL, if the hub may call it: http(s), no credentials, no fragment, not the owner's host. */
export function callbackHost(callback: string, ownHost: string): string | undefined {
  if (callback.length > MAX_CALLBACK || /[\s#]/.test(callback) || !/^https?:\/\//i.test(callback)) return
  let u: URL
  try {
    u = new URL(callback)
  } catch {
    return
  }
  const host = u.hostname.toLowerCase()
  return u.username || u.password || !host || host == ownHost.replace(/:\d+$/, '').toLowerCase() ? undefined : host
}

/**
 * Checks a subscription request (WebSub "Subscriber Sends Subscription Request"), a form-encoded POST. Returns the intent
 * to verify, after answering `202`. Throws HubError.
 */
export async function hubRequest(hub: Hub, contentType: string | null, body: string): Promise<Intent> {
  if ((contentType ?? '').split(';')[0]!.trim().toLowerCase() != 'application/x-www-form-urlencoded')
    throw new HubError(415, 'unsupported_type', 'Send the request form-encoded (application/x-www-form-urlencoded)')
  const form = new URLSearchParams(body)
  const mode = form.get('hub.mode')
  if (mode != 'subscribe' && mode != 'unsubscribe') throw new HubError(400, 'invalid_request', 'hub.mode must be subscribe or unsubscribe')
  const callback = form.get('hub.callback') ?? ''
  const host = callbackHost(callback, hub.ownHost)
  if (!host) throw new HubError(400, 'invalid_request', `hub.callback must be an http or https URL of another host, at most ${MAX_CALLBACK} characters, without a fragment`)
  const topic = await hub.topic(form.get('hub.topic') ?? '')
  if (!topic) throw new HubError(400, 'invalid_request', 'hub.topic must be the URL of a feed file of this server, not an archive or a comment feed')
  const lease = form.get('hub.lease_seconds')
  if (lease != undefined && !/^\d{1,10}$/.test(lease)) throw new HubError(400, 'invalid_request', 'hub.lease_seconds must be a number of seconds')
  const secret = form.get('hub.secret') ?? undefined
  if (secret != undefined && new TextEncoder().encode(secret).byteLength > MAX_SECRET_BYTES)
    throw new HubError(400, 'invalid_request', `hub.secret must be less than ${MAX_SECRET_BYTES + 1} bytes`)
  const intent: Intent = {
    mode, topic, callback, host, lease: lease == undefined ? MAX_LEASE : Math.min(MAX_LEASE, Math.max(MIN_LEASE, Number(lease))),
    ...mode == 'subscribe' && secret && { secret },
  }
  if (mode == 'subscribe') await checkRoom(hub, intent)
  return intent
}

/** Throws 403 if a new subscription would exceed a limit. Renewals always pass. */
async function checkRoom(hub: Hub, i: Intent) {
  const now = hub.now()
  if (await hub.store.get(i.topic, i.callback)) return
  if (await hub.store.countHost(i.topic, i.host, now) >= MAX_PER_HOST)
    throw new HubError(403, 'too_many_subscriptions', `${i.host} has ${MAX_PER_HOST} subscriptions to this feed already`)
  if (!isTrustedHost(i.host, hub.settings.trustedDomains) && await hub.store.count(now) >= hub.settings.maxSubscribers)
    throw new HubError(403, 'subscriber_limit', 'This hub takes no more subscribers. Poll the feed instead.')
}

const randomToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('')

/** Reads at most `max` bytes of a body as text; undefined if it is longer. */
async function readText(res: Response, max: number): Promise<string | undefined> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(all)
}

/**
 * Verifies an intent (WebSub "Hub Verifies Intent of the Subscriber"): the callback must echo the challenge. Then the
 * subscription is stored, renewed or removed; a new one only if there is still room. Returns whether it worked. Never
 * throws.
 */
export async function verifyIntent(hub: Hub, i: Intent): Promise<boolean> {
  const challenge = randomToken()
  const query = new URLSearchParams({
    'hub.mode': i.mode, 'hub.topic': i.topic, 'hub.challenge': challenge, ...i.mode == 'subscribe' && { 'hub.lease_seconds': String(i.lease) },
  })
  const log = { topic: i.topic, callbackHost: i.host }
  let reason: string | undefined
  try {
    const res = await hub.fetch(i.callback + (i.callback.includes('?') ? '&' : '?') + query, {
      redirect: 'manual', signal: AbortSignal.timeout(VERIFY_TIMEOUT), headers: { accept: 'text/plain, */*' },
    })
    const text = res.status >= 200 && res.status < 300 ? await readText(res, 1024) : (await res.body?.cancel(), undefined)
    if (text?.trim() != challenge) reason = res.status >= 200 && res.status < 300 ? 'wrong challenge' : `HTTP ${res.status}`
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e)
  }
  if (reason) {
    hub.log('websub.unverified', { ...log, mode: i.mode, reason })
    return false
  }
  try {
    if (i.mode == 'unsubscribe') {
      await hub.store.delete(i.topic, i.callback)
      hub.log('websub.unsubscribed', log)
      return true
    }
    try {
      await checkRoom(hub, i)
    } catch (e) {
      if (!(e instanceof HubError)) throw e
      hub.log('websub.refused', { ...log, reason: e.code })
      return false
    }
    const now = hub.now(), old = await hub.store.get(i.topic, i.callback)
    await hub.store.put({
      topic: i.topic, callback: i.callback, host: i.host, ...i.secret && { secret: i.secret }, expiresAt: now + i.lease * 1000, createdAt: old?.createdAt ?? now,
    })
    hub.log(old ? 'websub.renewed' : 'websub.subscribed', { ...log, lease: i.lease, trusted: isTrustedHost(i.host, hub.settings.trustedDomains) })
    return true
  } catch (e) {
    hub.log('websub.error', { ...log, error: e instanceof Error ? e.message : String(e) })
    return false
  }
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('')

/** The X-Hub-Signature of an empty body (WebSub "Authenticated Content Distribution"). */
export async function signature(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return 'sha256=' + hex(await crypto.subtle.sign('HMAC', key, new Uint8Array(0)))
}

export type PingResult = 'sent' | 'gone' | 'failed'

/** Tells a subscriber that its topic changed: an empty POST with the Link header. */
export async function ping(hubUrl: string, sub: Pick<Subscription, 'topic' | 'callback' | 'secret'>, fetchFn: typeof fetch): Promise<PingResult> {
  try {
    const res = await fetchFn(sub.callback, {
      method: 'POST', body: '', redirect: 'manual', signal: AbortSignal.timeout(PING_TIMEOUT),
      headers: { link: hubLinks(hubUrl, sub.topic), ...sub.secret && { 'x-hub-signature': await signature(sub.secret) } },
    })
    await res.body?.cancel()
    return res.status >= 200 && res.status < 300 ? 'sent' : res.status == 410 ? 'gone' : 'failed'
  } catch {
    return 'failed'
  }
}

/** Pings subscribers, `PING_CONCURRENCY` at a time. Returns the results in their order. */
export async function pingAll(hubUrl: string, subs: Pick<Subscription, 'topic' | 'callback' | 'secret'>[], fetchFn: typeof fetch): Promise<PingResult[]> {
  const out: PingResult[] = []
  for (let i = 0; i < subs.length; i += PING_CONCURRENCY)
    out.push(...await Promise.all(subs.slice(i, i + PING_CONCURRENCY).map(s => ping(hubUrl, s, fetchFn))))
  return out
}

/** The hub's answer to a refused request or to a method other than POST. */
export function hubErrorResponse(e: HubError): Response {
  return new Response(JSON.stringify({ error: e.code, message: e.message }), {
    status: e.status, headers: { 'content-type': 'application/json; charset=utf-8', ...e.status == 405 && { allow: 'POST' } },
  })
}

/** `202`: the request is accepted and will be verified. */
export const acceptedResponse = () => new Response('The request will be verified at the callback.\n', { status: 202, headers: { 'content-type': 'text/plain; charset=utf-8' } })
