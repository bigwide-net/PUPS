import { INBOX_PATH, inboxKey, isOwnEndpoint, type Job, type Receiver, type Status } from '../src'

export const ORIGIN = 'https://alice.pups.test'
export const MENTION = `${ORIGIN}/pups/mention`
export const COMMENTS = `${ORIGIN}/pups/comments`

export interface WebDoc {
  status: number
  headers?: Record<string, string>
  body: string
}

/** A receiver with in-memory storage, queue and status pages, a fake network and a clock tests can move. */
export async function testReceiver(o: Partial<Pick<Receiver, 'mentions' | 'comments'>> = {}) {
  const files = new Map<string, string>()
  const web = new Map<string, WebDoc>()
  const fetched: string[] = []
  /** The POST requests, such as mentions sent: URL and body. */
  const posted: { url: string; body: string }[] = []
  const jobs = new Map<string, Job>()
  const statuses = new Map<string, { status: Status; expiresAt: number }>()
  const t = { now: Date.parse('2026-11-20T10:00:00Z') }
  const r: Receiver = {
    base: ORIGIN, ownerHost: 'alice.pups.test', me: `${ORIGIN}/`, mentions: o.mentions ?? true, comments: o.comments ?? true,
    maxUploadBytes: 26214400, key: await inboxKey('a secret'), now: () => t.now,
    inbox: {
      read: async () => ({ text: files.get(INBOX_PATH), version: files.get(INBOX_PATH) }),
      write: async (text, version) => {
        if (files.get(INBOX_PATH) !== version) return false
        files.set(INBOX_PATH, text)
        return true
      },
    },
    feeds: {
      ownerPath(url) {
        const u = new URL(url)
        if (u.origin != ORIGIN || u.search || u.pathname.startsWith('/pups/private/')) return
        return decodeURIComponent(u.pathname)
      },
      readOwnerFile: async path => files.get(path),
      fetch: async (input, init) => {
        const url = String(input)
        fetched.push(url)
        if (init?.method == 'POST') posted.push({ url, body: String(init.body) })
        const d = web.get(url)
        if (!d) return new Response('not found', { status: 404 })
        return new Response(d.status == 301 || d.status == 302 ? null : d.body, { status: d.status, headers: d.headers })
      },
      isOwnEndpoint: url => isOwnEndpoint(url, ORIGIN),
    },
    queue: {
      get: async key => jobs.get(key),
      // A job with a new receivedAt goes to the back, as on the platforms.
      put: async (key, job) => {
        if (jobs.get(key)?.receivedAt != job.receivedAt) jobs.delete(key)
        jobs.set(key, job)
      },
      delete: async key => void jobs.delete(key),
      count: async prefix => [...jobs.keys()].filter(k => !prefix || k.startsWith(prefix)).length,
      oldest: async () => {
        const [first] = [...jobs].sort((a, b) => a[1].receivedAt - b[1].receivedAt)
        return first && { key: first[0], job: first[1] }
      },
    },
    statuses: {
      put: async (id, status, expiresAt) => void statuses.set(id, { status, expiresAt }),
      get: async id => {
        const s = statuses.get(id)
        return s && s.expiresAt >= t.now ? s.status : undefined
      },
    },
    log: () => {},
  }
  return { r, files, web, fetched, posted, jobs, t }
}

export const jsonFeed = (items: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'A feed', ...extra, items })

export const feedDoc = (items: unknown[], extra: Record<string, unknown> = {}): WebDoc =>
  ({ status: 200, headers: { 'content-type': 'application/feed+json' }, body: jsonFeed(items, extra) })

export const webmention = (endpoint: string, source: string, target: string) => new Request(endpoint, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ source, target }),
})

export function inbox(files: Map<string, string>): any {
  const text = files.get(INBOX_PATH)
  return text == undefined ? undefined : JSON.parse(text)
}
