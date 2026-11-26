import { INBOX_PATH, inboxKey, isOwnEndpoint, processQueue, type Receiver } from 'pups-inbox'
import { keyOf } from './files'
import { serverCommentFeeds } from './feeds'
import { isPrivate, parsePath, pathFromPublicUrl } from './paths'
import { type Env, type Settings, store } from './settings'
import { assertPublicHost } from './ssrf'

/**
 * The built-in receiver (pups-inbox) on Bunny: the inbox in the storage zone, the queue and the comment status pages
 * as files under _pups/mentions/, and fetch() for other servers' documents after the same DNS check as client metadata
 * documents (ssrf.ts). The queue is worked through after the response, with Bunny.v1.waitUntil().
 *
 * Bunny Storage has no conditional writes: the inbox is re-read right before it is written, and the write skipped if it
 * changed. Two writes in the same instant can still both pass (README, "Consistency").
 */

/**
 * Jobs per run: each makes about a dozen subrequests (queue, inbox, status, DNS, the post and the owner's feed), and a
 * request may make at most 50.
 */
const JOBS_PER_RUN = 2

/** The storage path of a URL that this server serves publicly (the owner's feeds and other files), or undefined. */
function ownerPath(url: string, s: Settings): string | undefined {
  url = url.split('#')[0]!
  if (url.includes('?')) return
  let path = pathFromPublicUrl(url, s)
  if (path == undefined && url.startsWith(s.storageBase)) {
    const p = parsePath('/' + url.slice(s.storageBase.length), s)
    path = 'path' in p ? p.path : undefined
  }
  return path != undefined && !isPrivate(path) ? path : undefined
}

export async function receiver(s: Settings, env: Env): Promise<Receiver> {
  const db = store(env), files = env.files!
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
  return {
    base: s.ownerOrigin, ownerHost: s.ownerHost.replace(/:\d+$/, ''), me: s.me, mentions: s.mentions, comments: s.comments,
    maxUploadBytes: s.maxUploadBytes, key: await inboxKey(await db.secret()), now: () => Date.now(),
    inbox: {
      async read() {
        const f = await files.get(keyOf(INBOX_PATH))
        return f ? { text: text(f.bytes), version: f.etag } : {}
      },
      async write(content, version) {
        if ((await files.get(keyOf(INBOX_PATH)))?.etag != version) return false
        await files.put(keyOf(INBOX_PATH), content)
        return true
      },
    },
    feeds: {
      ownerPath: url => ownerPath(url, s),
      readOwnerFile: async path => {
        const f = await files.get(keyOf(path))
        return f ? text(f.bytes) : undefined
      },
      fetch: (input, init) => fetch(input, init),
      isOwnEndpoint: url => isOwnEndpoint(url, s.ownerOrigin),
      checkUrl: url => assertPublicHost(new URL(url).hostname.replace(/^\[|\]$/g, ''), env, 'the URL'),
    },
    queue: {
      get: key => db.queueGet(key),
      put: (key, job) => db.queuePut(key, job),
      delete: key => db.queueDelete(key),
      count: async prefix => (await db.queueKeys(prefix)).length,
      oldest: async () => {
        for (const key of await db.queueKeys()) {
          const job = await db.queueGet(key)
          if (job) return { key, job }
        }
      },
    },
    statuses: {
      put: (id, status, expiresAt) => db.statusPut(id, status, expiresAt),
      get: id => db.statusGet(id),
    },
    commentFeeds: await serverCommentFeeds(s, env, url => ownerPath(url, s)),
    moderation: {
      load: async () => await db.moderationSettings() ?? undefined,
      save: json => db.setModerationSettings(json),
      tokens: day => db.moderationTokens(day),
      addTokens: (day, n) => db.addModerationTokens(day, n),
      fetch: (input, init) => fetch(input, init),
    },
    log: (event, data) => console.log(event, JSON.stringify(data ?? {})),
  }
}

/** Works through the queue after a response; errors are logged, never thrown. */
export async function work(r: Receiver): Promise<void> {
  try {
    await processQueue(r, { maxJobs: JOBS_PER_RUN })
  } catch (e) {
    console.error('mention queue', e)
  }
}
