import {
  archiveOwner, commentFeeds, type Committed, FeedError, type FeedHost, isFeedPath, isKeptText, keptFileOwner, postItem, putKeptFeed, readItem,
} from 'pups-feeds'
import { commentUrl } from 'pups-inbox'
import { POST_URL_TEMPLATE_PROP } from 'pups-ui'
import { authenticate, keyOf, requirePath, requireScope } from './files'
import { readHostMeta } from './hostmeta'
import { HttpError, json, readLimited } from './http'
import { pathFromPublicUrl, publicUrl } from './paths'
import { type Env, type Settings, store } from './settings'
import type { Grant } from './state'
import { feedHostWithHub, websubChanged } from './websub'

/**
 * Kept feeds (RFC-7, pups-feeds): feed files with the `_pups` marker, whose archives (RFC-13) the server writes.
 *
 * RFC-7 asks for a lock, so that concurrent posts never lose an item or give out an index twice. Bunny Storage has no
 * conditional writes, so the lock here is per script instance: requests to one instance take their turn, but two
 * instances can still write the same feed in the same instant (README, "Consistency").
 */

export const feedHost = (s: Settings, env: Env): FeedHost => ({
  me: s.me,
  publicUrl: path => publicUrl(path, s)!,
  pathFromPublicUrl: url => pathFromPublicUrl(url, s),
  read: async path => {
    const f = await env.files!.get(keyOf(path))
    return f ? new TextDecoder().decode(f.bytes) : undefined
  },
  postUrlTemplate: async () => {
    const hm = await readHostMeta(s, env)
    return hm.stored ? hm.doc.properties?.[POST_URL_TEMPLATE_PROP] : undefined
  },
  now: () => Date.now(),
  ...s.comments && { commentEndpoint: commentUrl({ base: s.ownerOrigin }) },
})

/** Turns the errors of pups-feeds into this server's. */
export async function feedErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof FeedError) throw new HttpError(e.status, e.code, e.message, e.headers)
    throw e
  }
}

/** The feed file whose lock a write of `path` needs: the feed file itself, or the one of an archive. */
export const feedOf = (path: string, s: Settings) => isFeedPath(path, s.wellKnown) ? path : archiveOwner(path, s.wellKnown)

/** The last request of this instance per feed: the next one waits for it. */
const queues = new Map<string, Promise<unknown>>()

/** Runs `fn` after the other requests of this instance for the same feed. */
export async function withFeedLock<T>(feedPath: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(feedPath) ?? Promise.resolve()).then(fn)
  const done = run.catch(() => undefined)
  queues.set(feedPath, done)
  try {
    return await run
  } finally {
    if (queues.get(feedPath) == done) queues.delete(feedPath)
  }
}

/** Refuses writes of a kept feed's archives and comment feeds (RFC-7 "Only the server writes archives", "Publishing comments"). */
export async function refuseKeptFileWrite(path: string, s: Settings, env: Env) {
  const owner = keptFileOwner(path, s.wellKnown)
  if (owner && isKeptText(await feedHost(s, env).read(owner)))
    throw new HttpError(403, 'forbidden', `This server writes the archives and comment feeds of ${owner} (RFC-7). Change its items with PUT or POST of ${owner}.`)
}

/**
 * Writes what a kept feed committed, the archives first and the feed file last. Throws 507 before writing anything if
 * the storage quota would be exceeded. Returns the ETag of the feed file.
 */
export async function writeCommitted(c: Committed, s: Settings, env: Env): Promise<string> {
  const files = env.files!
  const encoded = c.files.map(f => ({ ...f, bytes: new TextEncoder().encode(f.text) }))
  const sizes = await Promise.all(encoded.map(async f => (await files.stat(keyOf(f.path)))?.size ?? 0))
  const growth = encoded.reduce((sum, f, i) => sum + f.bytes.byteLength - sizes[i]!, 0)
  if (!await store(env).reserveStorage(growth, s.maxStorageBytes)) throw new HttpError(507, 'insufficient_storage', 'The storage quota is reached')
  let etag = ''
  for (const f of encoded) etag = await files.put(keyOf(f.path), f.bytes)
  for (const path of c.deletes) {
    const old = await files.stat(keyOf(path))
    if (!old) continue
    await files.delete(keyOf(path))
    await store(env).reserveStorage(-old.size, 0)
  }
  return etag
}

/** Is `body` a feed file with the marker, written to a feed path? Then the server keeps it instead of storing it. */
export function isKeptPut(path: string, body: Uint8Array, s: Settings): string | undefined {
  if (!isFeedPath(path, s.wellKnown)) return
  const text = new TextDecoder().decode(body)
  let doc: any
  try {
    doc = JSON.parse(text)
  } catch {
    return
  }
  return doc?._pups?.pupsControlled === true ? text : undefined
}

/**
 * PUT of a kept feed file (RFC-7 "Writing the feed file"), under the lock and after the preconditions. The response
 * holds the feed file as stored; it has an ETag only if that is the body that was sent.
 */
export async function putKept(path: string, rawPath: string, text: string, exists: boolean, s: Settings, env: Env): Promise<Response> {
  const host = await feedHostWithHub(s, env)
  const c = await feedErrors(async () => putKeptFeed(host, path, text, exists ? await host.read(path) : undefined))
  const etag = await writeCommitted(c, s, env)
  await websubChanged(path, s, env)
  const url = s.storageBase + rawPath.slice(1)
  return new Response(c.text, {
    status: exists ? 200 : 201,
    headers: {
      'Content-Type': 'application/json; charset=utf-8', 'Content-Location': url,
      ...c.text == text && { ETag: etag }, ...!exists && { Location: url },
    },
  })
}

/**
 * POST of an item to a kept feed file (RFC-7 "Posting items"): adds, replaces or deletes an item, and answers with it
 * and its address. `rawPath` is percent-encoded and relative to storage_base.
 */
export async function postItemEndpoint(req: Request, rawPath: string, s: Settings, env: Env): Promise<Response> {
  const grant: Grant = await authenticate(req, s, env, true)
  const path = requirePath(rawPath, s)
  requireScope(grant, path)
  if (!isFeedPath(path, s.wellKnown))
    throw new HttpError(405, 'method_not_allowed', 'POST is accepted only on feed files (RFC-7)', { Allow: 'GET, HEAD, PUT, DELETE, OPTIONS' })
  const body = await readLimited(req.body, s.maxUploadBytes)
  if (!body) throw new HttpError(413, 'too_large', `Items may be at most ${s.maxUploadBytes} bytes`)
  const item = await feedErrors(async () => readItem(req.headers.get('content-type'), new TextDecoder().decode(body)))
  const host = await feedHostWithHub(s, env)
  return withFeedLock(path, async () => {
    const r = await feedErrors(async () => postItem(host, path, item, await host.read(path)))
    if (r.committed) {
      await writeCommitted(r.committed, s, env)
      await websubChanged(path, s, env)
    }
    console.log(r.event, JSON.stringify({ client: grant.clientId, path, id: r.id }))
    return json(r.body, r.status, r.headers)
  })
}

/**
 * The comment feeds of the owner's kept feeds (RFC-7 "Publishing comments", pups-feeds) for the built-in receiver: approved
 * comments are published under the lock of their post's feed. `ownerPath` maps the URLs of posts to storage paths.
 */
export const serverCommentFeeds = async (s: Settings, env: Env, ownerPath: (url: string) => string | undefined) => commentFeeds({
  host: await feedHostWithHub(s, env), wellKnown: s.wellKnown, ownerPath,
  withLock: (feedPath, fn) => withFeedLock(feedPath, fn),
  write: async c => void await feedErrors(async () => writeCommitted(c, s, env)),
})
