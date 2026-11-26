import {
  acceptedResponse, FEED_REL, type Hub, HubError, hubErrorResponse, type HubStore, hubLinks, hubRequest, hubUrl, isFeedPath, isKeptText, isTrustedHost,
  MAX_PER_HOST, MAX_SUBSCRIBERS, pingAll, rewriteKeptFeed, type Subscription, verifyIntent, type WebSubSettings, webSubSettings,
} from 'pups-feeds'
import type { WebSubView } from 'pups-ui'
import { b64url, hashToken, sha256, timingSafeEqual } from './crypto'
import { keyOf } from './files'
import { feedErrors, feedHost, withFeedLock, writeCommitted } from './feeds'
import { readLimited } from './http'
import { parsePath, pathFromPublicUrl, publicUrl } from './paths'
import { type Env, type Settings, store } from './settings'
import { assertPublicHost } from './ssrf'
import { STATE_PREFIX } from './state'

/**
 * The WebSub hub (pups-feeds' websub.ts) on Bunny. Every storage access is a subrequest, and a request may make at most
 * 50, so:
 *
 * - The subscriptions of a feed are one file, `_pups/websub/topics/<topic key>.json`, read and written whole. Bunny
 *   Storage has no conditional writes: changes take their turn within a script instance, and two instances changing
 *   the same feed's subscriptions in the same instant can lose one (README, "Consistency").
 * - A changed feed waits in `_pups/websub/pending/<topic key>.json` with the progress. Its subscribers are pinged after
 *   the response, 35 per run; a run that leaves some calls the script again (`/pups/websub/work`, with a key derived
 *   from the installation's secret), so that each run has its own subrequests. The next change of a feed also
 *   continues where an interrupted run stopped.
 * - The callback's host is checked for public addresses (DNS over HTTPS) when the subscription is verified, not before
 *   every ping.
 */

const DIR = `${STATE_PREFIX}websub/`
/** Pings per run: with the listing, the job, the subscriptions, writing them back and the next call, within the 50 subrequests. */
export const WEBSUB_BATCH = 35
export const WORK_PATH = '/pups/websub/work'

interface TopicFile { topic: string; subs: Subscription[] }
interface Pending { topic: string; hub: string; changedAt: number; cursor: string }

const topicKey = async (topic: string) => b64url(await sha256(new TextEncoder().encode(topic))).slice(0, 22)
const topicFile = async (topic: string) => `${DIR}topics/${await topicKey(topic)}.json`
const pendingFile = async (topic: string) => `${DIR}pending/${await topicKey(topic)}.json`

export const websubSettings = async (env: Env) => webSubSettings(await store(env).setting('websub'))

/** The hub's URL, on the owner's domain. */
export const hubOf = (s: Settings) => hubUrl(s.ownerOrigin)

/** The subscriptions of a feed that haven't expired, by callback. */
async function readTopic(env: Env, topic: string): Promise<Subscription[]> {
  const f = await env.files!.getJson<TopicFile>(await topicFile(topic))
  return (f?.subs ?? []).filter(s => s.expiresAt > Date.now())
}

/** Changes the subscriptions of a feed, in turn with the other changes of this instance. */
const changeTopic = (env: Env, topic: string, fn: (subs: Subscription[]) => Subscription[]) =>
  withFeedLock(`websub:${topic}`, async () => {
    const subs = fn(await readTopic(env, topic)).sort((a, b) => a.callback < b.callback ? -1 : a.callback > b.callback ? 1 : 0)
    const key = await topicFile(topic)
    if (subs.length) await env.files!.putJson(key, { topic, subs } satisfies TopicFile)
    else await env.files!.delete(key)
  })

function hubStore(env: Env): HubStore {
  const all = async () => {
    const out: Subscription[] = []
    for (const e of await env.files!.list(`${DIR}topics/`))
      if (!e.isDirectory) out.push(...(await env.files!.getJson<TopicFile>(`${DIR}topics/${e.name}`))?.subs ?? [])
    return out
  }
  return {
    get: async (topic, callback) => (await readTopic(env, topic)).find(s => s.callback == callback),
    put: sub => changeTopic(env, sub.topic, subs => [...subs.filter(s => s.callback != sub.callback), sub]),
    delete: (topic, callback) => changeTopic(env, topic, subs => subs.filter(s => s.callback != callback)),
    count: async now => (await all()).filter(s => s.expiresAt > now).length,
    countHost: async (topic, host, now) => (await readTopic(env, topic)).filter(s => s.host == host && s.expiresAt > now).length,
  }
}

/** The storage path of a public or storage URL of a feed file. */
function feedPath(url: string, s: Settings): string | undefined {
  let path = pathFromPublicUrl(url, s)
  if (path == undefined && url.startsWith(s.storageBase) && !/[?#]/.test(url)) {
    const p = parsePath('/' + url.slice(s.storageBase.length), s)
    path = 'path' in p ? p.path : undefined
  }
  return path != undefined && isFeedPath(path, s.wellKnown) ? path : undefined
}

export function hub(s: Settings, env: Env, settings: WebSubSettings): Hub {
  return {
    url: hubOf(s), settings, ownHost: s.ownerHost, store: hubStore(env),
    topic: async url => {
      const path = url.length <= 2048 ? feedPath(url, s) : undefined
      return path && isKeptText(await feedHost(s, env).read(path)) ? publicUrl(path, s) : undefined
    },
    // Edge Scripts can't keep fetch() to public addresses: the callback's host is checked first.
    fetch: async (input, init) => {
      await assertPublicHost(new URL(String(input)).hostname.replace(/^\[|\]$/g, ''), env, 'the callback')
      return fetch(input, init)
    },
    now: () => Date.now(),
    log: (event, data) => console.log(event, JSON.stringify(data)),
  }
}

/** Runs work after the response; without waitUntil (outside Bunny), while the response is sent, as far as the runtime lets it. */
const later = (env: Env, work: Promise<unknown>) => env.waitUntil?.(work.catch(e => console.error('websub', e)))

/** /pups/websub: checks a subscription request, answers 202 and verifies it after the response. Not there while the hub is off. */
export async function hubEndpoint(req: Request, s: Settings, env: Env): Promise<Response | undefined> {
  const settings = await websubSettings(env)
  if (!settings.enabled) return
  try {
    if (req.method != 'POST') throw new HubError(405, 'method_not_allowed', 'Method not allowed')
    const body = await readLimited(req.body, 16384)
    if (!body) throw new HubError(413, 'too_large', 'The request body is too large')
    const h = hub(s, env, settings)
    const intent = await hubRequest(h, req.headers.get('content-type'), new TextDecoder().decode(body))
    later(env, verifyIntent(h, intent))
    return acceptedResponse()
  } catch (e) {
    if (e instanceof HubError) return hubErrorResponse(e)
    throw e
  }
}

/** The key of /pups/websub/work: derived from the installation's secret. */
const workKey = async (env: Env) => hashToken(`websub-work ${await store(env).secret()}`)

/** /pups/websub/work: the script calling itself, to ping the next subscribers with a new set of subrequests. */
export async function workEndpoint(req: Request, s: Settings, env: Env): Promise<Response | undefined> {
  if (req.method != 'POST' || !timingSafeEqual(req.headers.get('pups-work') ?? '', await workKey(env))) return
  later(env, pingRun(s, env))
  return new Response(null, { status: 202 })
}

/** After an app changed a kept feed: its subscribers are pinged after the response. A feed that changes again starts over. */
export async function websubChanged(path: string, s: Settings, env: Env) {
  if (!(await websubSettings(env)).enabled) return
  const topic = publicUrl(path, s)!
  if (!(await readTopic(env, topic)).length) return
  await env.files!.putJson(await pendingFile(topic), { topic, hub: hubOf(s), changedAt: Date.now(), cursor: '' } satisfies Pending)
  later(env, pingRun(s, env))
}

/**
 * Pings the next subscribers of a changed feed, and calls the script again while there are more. Returns the number
 * of pings sent.
 */
export async function pingRun(s: Settings, env: Env): Promise<number> {
  const files = env.files!
  const entry = (await files.list(`${DIR}pending/`)).find(e => !e.isDirectory)
  if (!entry) return 0
  const key = `${DIR}pending/${entry.name}`
  const job = await files.getJson<Pending>(key)
  if (!job) return 0
  const all = await readTopic(env, job.topic)
  const subs = all.filter(sub => sub.callback > job.cursor).slice(0, WEBSUB_BATCH)
  if (subs.length) {
    const results = await pingAll(job.hub, subs, fetch)
    const gone = new Set(subs.filter((_, i) => results[i] == 'gone').map(sub => sub.callback))
    results.forEach((r, i) => r != 'sent' && console.log(`websub.${r}`, JSON.stringify({ topic: job.topic, callbackHost: subs[i]!.host })))
    if (gone.size) await changeTopic(env, job.topic, list => list.filter(sub => !gone.has(sub.callback)))
  }
  const done = subs.length < WEBSUB_BATCH || subs.at(-1) == all.at(-1)
  // A change meanwhile wrote a new job, which starts over; it isn't overwritten here.
  const now = await files.getJson<Pending>(key)
  if (now?.changedAt == job.changedAt) {
    if (done) {
      await files.delete(key)
      console.log('websub.notified', JSON.stringify({ topic: job.topic }))
    } else await files.putJson(key, { ...job, cursor: subs.at(-1)!.callback })
  }
  if (!done || now?.changedAt != job.changedAt || (await files.list(`${DIR}pending/`)).some(e => !e.isDirectory && e.name != entry.name))
    later(env, fetch(s.ownerOrigin + WORK_PATH, { method: 'POST', headers: { 'pups-work': await workKey(env) } }).then(r => r.body?.cancel()))
  return subs.length
}

/** The Link header of a kept feed file while the hub is on (WebSub "Discovery"), else undefined. */
export async function feedLinks(path: string, text: string, s: Settings, env: Env): Promise<string | undefined> {
  return isFeedPath(path, s.wellKnown) && isKeptText(text) && (await websubSettings(env)).enabled ? hubLinks(hubOf(s), publicUrl(path, s)!) : undefined
}

/** The FeedHost of kept feeds, with the hub while it is on. */
export async function feedHostWithHub(s: Settings, env: Env) {
  return { ...feedHost(s, env), ...(await websubSettings(env)).enabled && { hub: hubOf(s) } }
}

/** The kept feed files: declared feed files, and `<name>.json` in declared feed directories. */
async function keptFeedPaths(s: Settings, env: Env): Promise<string[]> {
  const out = new Set<string>()
  for (const e of s.wellKnown) {
    if (!e.rels.includes(FEED_REL)) continue
    const candidates = e.path.endsWith('/') ? (await env.files!.list(keyOf(e.path))).filter(f => !f.isDirectory).map(f => e.path + f.name) : [e.path]
    for (const p of candidates)
      if (isFeedPath(p, s.wellKnown) && isKeptText(await feedHost(s, env).read(p))) out.add(p)
  }
  return [...out]
}

/** Writes the kept feed files again without changing their items, so that their `hubs` follow the setting. */
async function rewriteFeeds(s: Settings, env: Env) {
  const host = await feedHostWithHub(s, env)
  for (const path of await keptFeedPaths(s, env))
    await withFeedLock(path, async () => {
      const c = await feedErrors(async () => rewriteKeptFeed(host, path, await host.read(path)))
      if (c) await writeCommitted(c, s, env)
    })
}

/** The feeds page's view of the hub. `form` is a submitted form that was refused, shown again. */
export async function websubView(env: Env, form?: FormData): Promise<WebSubView> {
  const settings = await websubSettings(env)
  const subs: Subscription[] = []
  for (const e of await env.files!.list(`${DIR}topics/`))
    if (!e.isDirectory) subs.push(...((await env.files!.getJson<TopicFile>(`${DIR}topics/${e.name}`))?.subs ?? []).filter(x => x.expiresAt > Date.now()))
  return {
    enabled: form ? form.has('websub_enabled') : settings.enabled,
    max: form ? String(form.get('websub_max') ?? '') : settings.maxSubscribers,
    domains: form ? String(form.get('websub_trusted') ?? '') : settings.trustedDomains.join('\n'),
    total: subs.length, trusted: subs.filter(x => isTrustedHost(x.host, settings.trustedDomains)).length,
    maxLimit: MAX_SUBSCRIBERS, maxPerHost: MAX_PER_HOST,
  }
}

/** Saves the hub's settings; turning it on or off rewrites the feed files, for their `hubs`. */
export async function saveWebsub(settings: WebSubSettings, s: Settings, env: Env) {
  const was = (await websubSettings(env)).enabled
  await store(env).setSetting('websub', settings)
  console.log('websub.settings', JSON.stringify({ enabled: settings.enabled, maxSubscribers: settings.maxSubscribers, trusted: settings.trustedDomains.length }))
  if (was != settings.enabled) await rewriteFeeds(s, env)
}
