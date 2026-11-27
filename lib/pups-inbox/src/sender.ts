import { isCleanUrlString } from 'pups-ui'
import { accountHost, handles, handleText } from './content'
import { FEED_TIMEOUT_MS, fetchDoc, FetchError, replyRef, splitRef, urlHost } from './feeds'
import { type Job, MENTION_REL, type Receiver, refId } from './receiver'

/**
 * Sending mentions (RFC-11 "Sending") for the comments that the server publishes: a reply mention to the author of the
 * item a comment answers, unless that item opted out with RFC-4 `notifyReplies: false`, and a mention by name to every
 * handle in the comment. They wait in the receiver's queue as jobs of the kind `send`, and are sent when it is worked
 * through; a delivery that fails for a reason that may pass is tried again later.
 */

/** At most this many accounts are notified per comment (RFC-11 "Both"). */
const MAX_ACCOUNTS = 20
/** At most this many mentions wait to be sent. */
export const MAX_SENDS = 200
/** The keys of send jobs start with this; those of incoming webmentions with a base64url hash, which has no dot. */
export const SEND_PREFIX = 'out.'
/** How long a domain's mention endpoint, or that it has none, is remembered (RFC-11 "Discovery"). */
const DISCOVERY_KEEP_MS = 3600_000
/** The waits before the retries of a delivery that failed with a network error, a 5xx or a 429: about a day (RFC-11 "When"). */
export const RETRY_MS = [2, 15, 60, 240, 720].map(m => m * 60_000)
const URL_LIMIT = 2048

/** A published comment, or a post, as stored. */
type Item = Record<string, any>

const str = (v: unknown) => typeof v == 'string' ? v : undefined

/**
 * Whom a published comment notifies, as [host, target] (RFC-11 "Who is mentioned"): the author of the item it answers,
 * with that item as the target, unless the item opted out; and the handles in its title and text, with the domain's
 * root. Never the comment's own author nor the owner, every host once, at most 20.
 */
export function notified(r: Receiver, comment: Item, answered: Item | undefined): [string, string][] {
  const skip = new Set([r.ownerHost, accountHost(comment._source?.accounts?.socialspec)])
  const out = new Map<string, string>()
  const inReplyTo = replyRef(comment._source?.inReplyTo)
  const author = accountHost(answered?._source?.accounts?.socialspec)
  if (inReplyTo && splitRef(inReplyTo)[1] != undefined && author && !skip.has(author) && answered!._commenting?.notifyReplies !== false)
    out.set(author, inReplyTo)
  for (const host of handles(handleText({ title: str(comment.title), html: str(comment.content_html), text: str(comment.content_text) })))
    if (!skip.has(host) && !out.has(host)) out.set(host, `https://${host}/`)
  return [...out].slice(0, MAX_ACCOUNTS)
}

/** A comment that was published, changed or deleted: its address, its versions before and after, and the item it answers. */
export interface CommentChange {
  address: string
  before?: Item
  after?: Item
  answered?: Item
}

/**
 * Queues the mentions of comments that were published, changed or deleted: to every account that the version before
 * or after notifies, so that the receivers add, update or remove them (RFC-11 "Edits and deletes").
 */
export async function queueMentions(r: Receiver, changes: CommentChange[]) {
  for (const { address, before, after, answered } of changes) {
    const all = new Map([...before ? notified(r, before, answered) : [], ...after ? notified(r, after, answered) : []].map(([host, target]) => [`${host} ${target}`, { host, target }]))
    for (const { host, target } of all.values()) {
      const key = SEND_PREFIX + await refId('send', address, target)
      if (!await r.queue.get(key) && await r.queue.count(SEND_PREFIX) >= MAX_SENDS) {
        r.log('send.dropped', { source: address, target, reason: 'too many mentions waiting' })
        continue
      }
      await r.queue.put(key, { kind: 'send', source: address, target, host, receivedAt: r.now(), attempts: 0 })
    }
  }
}

/**
 * A domain's mention endpoint (RFC-11 "Discovery"): the first link with the relation in its host-meta.json, fetched over
 * HTTPS and from the domain itself. Remembered for an hour, as is a domain without one, in the status store.
 */
async function endpointOf(r: Receiver, host: string): Promise<string | undefined> {
  const key = `d-${await refId(host)}`
  const known = await r.statuses.get(key)
  if (known) return str(known.endpoint)
  let endpoint: string | undefined
  try {
    const doc = await fetchDoc(r.feeds, `https://${host}/.well-known/host-meta.json`)
    if (doc.url.startsWith('https://') && urlHost(doc.url) == host) {
      const links = JSON.parse(doc.body)?.links
      const href = Array.isArray(links) ? links.find(l => l?.rel == MENTION_REL)?.href : undefined
      if (isCleanUrlString(href, URL_LIMIT) && /^https:\/\/[^/?#]+/i.test(href) && !r.feeds.isOwnEndpoint(href)) endpoint = href
    }
  } catch (e) {
    if (!(e instanceof FetchError || e instanceof SyntaxError)) throw e
  }
  await r.statuses.put(key, { status: 'discovered', ...endpoint && { endpoint } }, r.now() + DISCOVERY_KEEP_MS)
  return endpoint
}

/** Sends a queued mention (RFC-11 "Request"). Returns whether to try again later: after a network error, a 5xx or a 429. */
export async function processSend(r: Receiver, { source, target, host }: Job): Promise<boolean> {
  const log = (result: string, extra: Record<string, unknown> = {}) => r.log(`send.${result}`, { source, target, host, ...extra })
  const endpoint = await endpointOf(r, host!)
  if (!endpoint) return log('no-endpoint'), false
  try {
    await r.feeds.checkUrl?.(endpoint)
  } catch (e) {
    return log('refused', { error: (e as Error).message }), false
  }
  let status = 0, error
  try {
    const res = await r.feeds.fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ source, target }).toString(),
      redirect: 'manual', signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    })
    status = res.status
    await res.body?.cancel()
  } catch (e) {
    error = (e as Error).message
  }
  if (status >= 200 && status < 300) return log('sent', { status }), false
  const again = !status || status == 429 || status >= 500
  log(again ? 'failed' : 'rejected', { status, error })
  return again
}
