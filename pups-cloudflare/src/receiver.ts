import { INBOX_PATH, inboxKey, isOwnEndpoint, type Job, processQueue, type Receiver, type Status } from 'pups-inbox'
import { keyOf } from './files'
import { isPrivate, parsePath, pathFromPublicUrl } from './paths'
import { type Env, type Settings, store } from './settings'

/**
 * The built-in receiver (pups-inbox) on Cloudflare: the inbox in R2 with conditional writes, the queue and the
 * comment status pages in the Durable Object, and fetch() for other servers' documents, which
 * global_fetch_strictly_public limits to public addresses. The queue is worked through with waitUntil() after the
 * response.
 */

/** Jobs per waitUntil(): each fetches a few documents, and a request may make at most 50 subrequests on the free plan. */
const JOBS_PER_RUN = 4

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
  const db = store(env)
  return {
    base: s.ownerOrigin, ownerHost: s.ownerHost.replace(/:\d+$/, ''), me: s.me, mentions: s.mentions, comments: s.comments,
    maxUploadBytes: s.maxUploadBytes, key: await inboxKey(await db.secret()), now: () => Date.now(),
    inbox: {
      async read() {
        const obj = await env.FILES.get(keyOf(INBOX_PATH))
        return obj ? { text: await obj.text(), version: obj.etag } : {}
      },
      async write(text, version) {
        return !!await env.FILES.put(keyOf(INBOX_PATH), text, {
          onlyIf: version ? { etagMatches: version } : new Headers({ 'if-none-match': '*' }),
          httpMetadata: { contentType: 'application/feed+json' },
        })
      },
    },
    feeds: {
      ownerPath: url => ownerPath(url, s),
      readOwnerFile: async path => (await env.FILES.get(keyOf(path)))?.text(),
      fetch: (input, init) => fetch(input, init),
      isOwnEndpoint: url => isOwnEndpoint(url, s.ownerOrigin),
    },
    queue: {
      get: async key => {
        const job = await db.queueGet(key)
        return job ? JSON.parse(job) as Job : undefined
      },
      put: (key, job) => db.queuePut(key, JSON.stringify(job), job.receivedAt),
      delete: key => db.queueDelete(key),
      count: prefix => db.queueCount(prefix),
      oldest: async () => {
        const r = await db.queueOldest()
        return r && { key: r.key, job: JSON.parse(r.job) as Job }
      },
    },
    statuses: {
      put: (id, status, expiresAt) => db.statusPut(id, JSON.stringify(status), expiresAt),
      get: async id => {
        const status = await db.statusGet(id)
        return status ? JSON.parse(status) as Status : undefined
      },
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
