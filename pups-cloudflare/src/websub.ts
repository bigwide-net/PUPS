import {
  acceptedResponse, FEED_REL, type Hub, HubError, hubErrorResponse, hubLinks, hubRequest, hubUrl, isFeedPath, isKeptText, isTrustedHost, MAX_PER_HOST,
  MAX_SUBSCRIBERS, rewriteKeptFeed, verifyIntent, type WebSubSettings, webSubSettings,
} from 'pups-feeds'
import type { WebSubView } from 'pups-ui'
import { keyOf } from './files'
import { feedErrors, feedHost, withFeedLock, writeCommitted } from './feeds'
import { readLimited } from './http'
import { parsePath, pathFromPublicUrl, publicUrl } from './paths'
import { type Env, type Settings, store } from './settings'

/**
 * The WebSub hub (pups-feeds' websub.ts) on Cloudflare: the subscriptions in the Durable Object, the verification with
 * waitUntil() after the 202, and the pings from the Durable Object's alarm, 40 per run (store.ts).
 */

export const websubSettings = async (env: Env) => webSubSettings(await store(env).setting('websub'))

/** The hub's URL, on the owner's domain. */
export const hubOf = (s: Settings) => hubUrl(s.ownerOrigin)

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
  const db = store(env)
  return {
    url: hubOf(s), settings, ownHost: s.ownerHost,
    topic: async url => {
      const path = url.length <= 2048 ? feedPath(url, s) : undefined
      return path && isKeptText(await feedHost(s, env).read(path)) ? publicUrl(path, s) : undefined
    },
    store: {
      get: (topic, callback) => db.wsGet(topic, callback),
      put: sub => db.wsPut(sub),
      delete: (topic, callback) => db.wsDelete(topic, callback),
      count: now => db.wsCount(now),
      countHost: (topic, host, now) => db.wsCount(now, topic, host),
    },
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    log: (event, data) => console.log(event, JSON.stringify(data)),
  }
}

/** /pups/websub: checks a subscription request, answers 202 and verifies it after the response. Not there while the hub is off. */
export async function hubEndpoint(req: Request, s: Settings, env: Env, ctx: ExecutionContext): Promise<Response | undefined> {
  const settings = await websubSettings(env)
  if (!settings.enabled) return
  try {
    if (req.method != 'POST') throw new HubError(405, 'method_not_allowed', 'Method not allowed')
    const body = await readLimited(req.body, 16384)
    if (!body) throw new HubError(413, 'too_large', 'The request body is too large')
    const h = hub(s, env, settings)
    const intent = await hubRequest(h, req.headers.get('content-type'), new TextDecoder().decode(body))
    ctx.waitUntil(verifyIntent(h, intent))
    return acceptedResponse()
  } catch (e) {
    if (e instanceof HubError) return hubErrorResponse(e)
    throw e
  }
}

/** After an app changed a kept feed: its subscribers are pinged by the Durable Object's alarm. */
export async function websubChanged(path: string, s: Settings, env: Env) {
  if ((await websubSettings(env)).enabled) await store(env).wsChanged(publicUrl(path, s)!, hubOf(s))
}

/** The Link header of a kept feed file while the hub is on (WebSub "Discovery"), else undefined. */
export async function feedLinks(path: string, kept: boolean, s: Settings, env: Env): Promise<string | undefined> {
  return kept && isFeedPath(path, s.wellKnown) && (await websubSettings(env)).enabled ? hubLinks(hubOf(s), publicUrl(path, s)!) : undefined
}

/** The kept feed files: declared feed files, and `<name>.json` in declared feed directories. */
async function keptFeedPaths(s: Settings, env: Env): Promise<string[]> {
  const out = new Set<string>()
  for (const e of s.wellKnown) {
    if (!e.rels.includes(FEED_REL)) continue
    let candidates = [e.path]
    if (e.path.endsWith('/')) {
      candidates = []
      let cursor: string | undefined
      do {
        const page = await env.FILES.list({ prefix: keyOf(e.path), delimiter: '/', cursor })
        candidates.push(...page.objects.map(o => '/' + o.key))
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
    }
    for (const p of candidates)
      if (isFeedPath(p, s.wellKnown) && isKeptText(await feedHost(s, env).read(p))) out.add(p)
  }
  return [...out]
}

/** Writes the kept feed files again without changing their items, so that their `hubs` follow the setting. */
async function rewriteFeeds(s: Settings, env: Env) {
  const host = await feedHostWithHub(s, env)
  for (const path of await keptFeedPaths(s, env))
    await withFeedLock(env, path, async () => {
      const c = await feedErrors(async () => rewriteKeptFeed(host, path, await host.read(path)))
      if (c) await writeCommitted(c, undefined, s, env)
    })
}

/** The FeedHost of kept feeds, with the hub while it is on. */
export async function feedHostWithHub(s: Settings, env: Env) {
  return { ...feedHost(s, env), ...(await websubSettings(env)).enabled && { hub: hubOf(s) } }
}

/** The feeds page's view of the hub. `form` is a submitted form that was refused, shown again. */
export async function websubView(env: Env, form?: FormData): Promise<WebSubView> {
  const settings = await websubSettings(env)
  const hosts = await store(env).wsHosts(Date.now())
  return {
    enabled: form ? form.has('websub_enabled') : settings.enabled,
    max: form ? String(form.get('websub_max') ?? '') : settings.maxSubscribers,
    domains: form ? String(form.get('websub_trusted') ?? '') : settings.trustedDomains.join('\n'),
    total: hosts.reduce((n, h) => n + h.n, 0),
    trusted: hosts.reduce((n, h) => n + (isTrustedHost(h.host, settings.trustedDomains) ? h.n : 0), 0),
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
