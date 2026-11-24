import { isCleanUrlString, sanitizeText } from 'pups-ui'
import { accountHost, handles, handleText, plainText, postHtml } from './content'
import { type Feed, FetchError, type FeedSource, findItem, loadFeed, type Post, readLimited, resolveUrl, sameRef, splitRef, urlHost } from './feeds'
import { type CommentFeeds, isSameComment, PUBLISHING } from './comments'
import {
  checkRoomForSubmission, excerptHtml, findInboxItem, ForeignInbox, type InboxContext, InboxFull, inboxItem, putInboxItem, removeInboxItem,
} from './inbox'

/**
 * The built-in receiver: mentions of the owner (RFC-11) at /pups/mention, linked from host-meta.json, and comments on
 * the owner's posts (RFC-4) at /pups/comments, named in the feeds' `_submissions` by the client. Both go into the
 * inbox (RFC-12). Comments on a feed with `republish: "full"` or `"summary"` wait there for the owner's approval, and
 * are then published in the post's comment feed (Receiver.commentFeeds), in full or as an abstract; with
 * `republish: "no"` (or a value this server doesn't know), the owner only reads them.
 *
 * The endpoints do the cheap checks and queue the rest. The queue is worked through after the response has been
 * sent (processQueue(), with the platform's waitUntil), because every check fetches documents from other servers.
 */

export const MENTION_REL = 'https://bigwide.net/ns/mention'
/** At most this many webmentions wait, and at most this many from one source host. */
export const MAX_QUEUE = 100
export const MAX_QUEUE_PER_HOST = 5
/** A job that fails this often (e.g. because it crashed the worker) is dropped. */
const MAX_ATTEMPTS = 3
/** Comment status pages are kept this long (RFC-4: at least an hour); those of comments waiting for approval longer. */
export const STATUS_KEEP_MS = 24 * 3600_000
export const PENDING_KEEP_MS = 30 * 24 * 3600_000
/** A comment keeps its own date if it is at most this far from the time of submission (RFC-4). */
const DATE_SLACK_MS = 30 * 60_000
/** The policy defaults of RFC-4 "Policies". */
const POLICY_DEFAULTS = { title: 'none', minLength: 2, maxLength: 2000, requireSocialSpec: false, allowEdit: false, allowDelete: false, commentLimit: 1000, maxDepth: 5 }
/** The deepest nesting of replies that the server publishes. */
const MAX_DEPTH_LIMIT = 10
type Policy = typeof POLICY_DEFAULTS
const MAX_TITLE_CHARS = 300
const URL_LIMIT = 2048
const BODY_LIMIT = 16 * 1024

export interface Job {
  kind: 'mention' | 'comment'
  source: string
  target: string
  /** Comments: the id of the submission. */
  id?: string
  receivedAt: number
  attempts: number
}

/** The waiting webmentions. Keys start with a hash of the source host, `<host key>-<job key>`. */
export interface JobQueue {
  get(key: string): Promise<Job | undefined>
  put(key: string, job: Job): Promise<void>
  delete(key: string): Promise<void>
  /** The number of jobs, or of those whose key starts with `prefix`. */
  count(prefix?: string): Promise<number>
  /** The job that was put first. */
  oldest(): Promise<{ key: string; job: Job } | undefined>
}

export type Status = Record<string, unknown> & { status: string }

/** The status pages of comments, each with its expiry. */
export interface StatusStore {
  put(id: string, status: Status, expiresAt: number): Promise<void>
  /** Undefined if there is none, or it has expired. */
  get(id: string): Promise<Status | undefined>
}

/** Everything the receiver needs from the server. */
export interface Receiver extends InboxContext {
  /** The owner's host as handles name it: lowercase, without port. */
  ownerHost: string
  /** The owner's identity, `https://<host>/`. */
  me: string
  feeds: FeedSource
  queue: JobQueue
  statuses: StatusStore
  /** The comment feeds of the owner's kept feeds, if the server keeps feeds: approved comments are published there. */
  commentFeeds?: CommentFeeds
  log(event: string, data?: Record<string, unknown>): void
}

export const mentionUrl = (r: { base: string }) => `${r.base}/pups/mention`
export const commentUrl = (r: { base: string }) => `${r.base}/pups/comments`
export const mentionLink = (r: { base: string }) => ({ rel: MENTION_REL, href: mentionUrl(r) })

/** URLs of this server that it must never fetch: its own receiving endpoints. */
export const isOwnEndpoint = (url: string, base: string) =>
  ['/pups/mention', '/pups/comments', '/pups/inbox'].some(p => url.toLowerCase().startsWith((base + p).toLowerCase()))

/** A short, stable id for inbox items and jobs. */
export async function refId(...parts: string[]): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('\n'))))
  return btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 16)
}

// --- HTTP ----------------------------------------------------------------------------------

/** A request error; becomes `{"error", "message"}`. */
export class ReceiverError extends Error {
  constructor(public status: number, public code: string, message: string, public headers: Record<string, string> = {}) {
    super(message)
  }
}

export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })

/** Runs an endpoint: ReceiverErrors become JSON error responses. */
export async function answer(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ReceiverError) return jsonResponse({ error: e.code, message: e.message }, e.status, e.headers)
    throw e
  }
}

const methodNotAllowed = (allow: string) => new ReceiverError(405, 'method_not_allowed', 'Method not allowed', { Allow: allow })

/** A request body as text, at most BODY_LIMIT bytes. Throws 413. */
async function bodyText(req: Request): Promise<string> {
  const bytes = await readLimited(req.body, BODY_LIMIT)
  if (!bytes) throw new ReceiverError(413, 'too_large', 'The request body is too large')
  return new TextDecoder().decode(bytes)
}

/** The fields of a form-encoded body (GET: the query), each at most `max` characters. Throws 400. */
export async function formFields(req: Request, max = URL_LIMIT): Promise<URLSearchParams> {
  const params = req.method == 'GET' || req.method == 'HEAD' ? new URL(req.url).searchParams : new URLSearchParams(await bodyText(req))
  let n = 0
  for (const [name, value] of params)
    if (++n > 100 || name.length > 256 || value.length > max) throw new ReceiverError(400, 'invalid_request', `${name.slice(0, 50)} is too long`)
  return params
}

/** The `source` and `target` of a webmention, form-encoded or JSON. Throws 400. */
async function webmentionParams(req: Request): Promise<[string, string]> {
  if (req.method != 'POST') throw methodNotAllowed('POST, OPTIONS')
  let source: unknown, target: unknown
  if ((req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    let j: any
    try {
      j = JSON.parse(await bodyText(req))
    } catch (e) {
      if (e instanceof ReceiverError) throw e
    }
    source = j?.source
    target = j?.target
  } else {
    const form = await formFields(req)
    source = form.get('source')
    target = form.get('target')
  }
  for (const [name, v] of [['source', source], ['target', target]] as const)
    if (!isCleanUrlString(v, URL_LIMIT) || !/^https?:\/\/[^/?#]+/i.test(v))
      throw new ReceiverError(400, 'invalid_request', `${name} must be an absolute http(s) URL of at most ${URL_LIMIT} characters`)
  if (source == target) throw new ReceiverError(400, 'invalid_request', 'source and target must differ')
  return [source as string, target as string]
}

// --- Endpoints -----------------------------------------------------------------------------

/** POST /pups/mention (RFC-11 "Receiving"): checks the request, queues it and answers 202. Undefined if mentions are off. */
export async function mentionEndpoint(req: Request, r: Receiver): Promise<Response | undefined> {
  if (!r.mentions) return
  return answer(async () => {
    const [source, target] = await webmentionParams(req)
    if (!target.includes('#') && target != `https://${r.ownerHost}/` && target != r.me)
      throw new ReceiverError(400, 'invalid_request', `target must be https://${r.ownerHost}/ or a feed item (feed URL + #id)`)
    await enqueue(r, { kind: 'mention', source, target })
    return jsonResponse({ message: 'Accepted. The mention is checked shortly.' }, 202)
  })
}

/**
 * POST /pups/comments (RFC-4 "Submitting"): only comments on posts of the owner's feeds whose `_submissions.url` is
 * this endpoint. Answers 201 with a status page. Undefined if comments are off.
 */
export async function commentEndpoint(req: Request, r: Receiver): Promise<Response | undefined> {
  if (!r.comments) return
  return answer(async () => {
    const [source, target] = await webmentionParams(req)
    const post = await commentTarget(r, target)
    const id = `s-${await refId(source)}`
    const existing = await findInboxItem(r, id).catch(e => {
      if (e instanceof ForeignInbox) throw new ReceiverError(400, 'moderation-unavailable', "The owner's inbox is not available.")
      throw e
    })
    if (existing && !sameRef(existing._inbox?.target, target))
      throw new ReceiverError(400, 'in-reply-to-mismatch', 'This source was submitted to another post')
    if ((existing || await r.commentFeeds?.published(target, id)) && !post.policy.allowEdit && !post.policy.allowDelete)
      throw new ReceiverError(400, 'edit-not-allowed', 'This comment was submitted already, and the feed allows neither edits nor deletes')
    try {
      await checkRoomForSubmission(r, id, urlHost(source))
    } catch (e) {
      if (e instanceof InboxFull) throw new ReceiverError(400, 'moderation-unavailable', `${e.message} Try again later.`)
      throw e
    }
    await writeStatus(r, id, { status: 'waiting' })
    await enqueue(r, { kind: 'comment', source, target, id })
    const statusUrl = `${commentUrl(r)}/status/${id}`
    return jsonResponse({ status: 'waiting', guid: id, statusUrl }, 201, { Location: statusUrl })
  })
}

/** GET /pups/comments/status/<id> (RFC-4 "Response and status"). Undefined for ids that can't exist. */
export async function commentStatusEndpoint(req: Request, id: string, r: Receiver): Promise<Response | undefined> {
  if (!r.comments || !/^s-[A-Za-z0-9_-]{16}$/.test(id)) return
  return answer(async () => {
    if (req.method != 'GET' && req.method != 'HEAD') throw methodNotAllowed('GET, HEAD')
    const s = await r.statuses.get(id)
    if (!s) throw new ReceiverError(404, 'not_found', 'No such submission, or its status has expired')
    return jsonResponse(s, 200, { 'Cache-Control': 'no-store' })
  })
}

/**
 * What a comment answers, if it may be commented on here: a post, or a comment published in a comment feed of a kept
 * feed (a reply). Returns the policy and `republish` of the post's feed. Throws 400 otherwise (RFC-4: the cheap checks
 * are synchronous).
 */
async function commentTarget(r: Receiver, target: string): Promise<{ policy: Policy; republish: string }> {
  const [url, id] = splitRef(target)
  if (id == undefined) throw new ReceiverError(400, 'invalid_request', 'Only comments on posts and comments are accepted: target must be a feed URL + #id')
  if (r.feeds.ownerPath(url) == undefined) throw new ReceiverError(400, 'invalid_request', 'target is not a feed on this server')
  let s, exists, open, depth
  if (r.commentFeeds?.isCommentFeed(url)) {
    // A reply: the feed's rules apply, also to the post that the thread belongs to.
    const reply = await r.commentFeeds.reply(target)
    if (!reply) throw new ReceiverError(400, 'target-gone', "The comment isn't published (anymore)")
    ;[s, exists, open, depth] = [reply.submissions, true, reply.open, reply.depth]
  } else {
    let found
    try {
      found = await findItem(r.feeds, target)
    } catch (e) {
      if (e instanceof FetchError) throw new ReceiverError(400, 'target-gone', `The target feed can't be read: ${e.message}`)
      throw e
    }
    ;[s, exists, open, depth] = [await submissionsOf(r, found.feed), !!found.item, !!found.item?.allowComments, 1]
  }
  if (s?.url !== commentUrl(r)) throw new ReceiverError(400, 'invalid_request', "This feed doesn't accept comments at this endpoint")
  const policy = s.policies && typeof s.policies == 'object' && s.policies.comments && typeof s.policies.comments == 'object' && !Array.isArray(s.policies.comments)
    ? toPolicy(s.policies.comments) : undefined
  if (!policy) throw new ReceiverError(400, 'comments-disabled', 'This feed accepts no comments')
  if (!exists) throw new ReceiverError(400, 'target-gone', "The post doesn't exist")
  if (!open) throw new ReceiverError(400, 'comments-disabled', 'The post is closed for comments')
  if (depth > policy.maxDepth) throw new ReceiverError(400, 'max-depth', `Replies are nested at most ${policy.maxDepth} levels deep here`)
  return { policy, republish: typeof s.republish == 'string' ? s.republish : 'no' }
}

/**
 * The `_submissions` that apply to a feed of the owner. For an RFC-13 archive, those of its feed file at
 * `_archive.updates_url`: archives don't carry their own (RFC-7 "Receiving comments", RFC-13).
 */
async function submissionsOf(r: Receiver, feed: Feed): Promise<Record<string, any> | undefined> {
  if (feed.updates == undefined) return feed.submissions
  const main = resolveUrl(feed.url, feed.updates)
  if (r.feeds.ownerPath(main) == undefined) return
  try {
    return (await loadFeed(r.feeds, main)).submissions
  } catch (e) {
    if (e instanceof FetchError) throw new ReceiverError(400, 'target-gone', `The feed of the archive can't be read: ${e.message}`)
    throw e
  }
}

/** A comments policy with the defaults of RFC-4, and values of the wrong type ignored. */
function toPolicy(p: Record<string, unknown>): Policy {
  const out = { ...POLICY_DEFAULTS }
  for (const [k, dflt] of Object.entries(POLICY_DEFAULTS) as [keyof Policy, unknown][])
    if (typeof p[k] == typeof dflt && (k != 'title' || ['required', 'allowed', 'none'].includes(p[k] as string)))
      (out as Record<string, unknown>)[k] = p[k]
  out.maxDepth = Number.isInteger(out.maxDepth) ? Math.max(1, Math.min(MAX_DEPTH_LIMIT, out.maxDepth)) : POLICY_DEFAULTS.maxDepth
  return out
}

export const writeStatus = (r: Receiver, id: string, status: Status) =>
  r.statuses.put(id, { ...status, guid: id }, r.now() + (status.status == 'pending' ? PENDING_KEEP_MS : STATUS_KEEP_MS))

// --- Queue ---------------------------------------------------------------------------------

/**
 * Queues a job. The key starts with a hash of the source host, so that the limit per host is a prefix count; the
 * same source and target replace a waiting job instead of adding one. Throws 429 if the queue is full.
 */
async function enqueue(r: Receiver, job: Omit<Job, 'receivedAt' | 'attempts'>) {
  const hostKey = await refId(urlHost(job.source) ?? '')
  const key = `${hostKey}-${await refId(job.kind, job.source, job.target)}`
  if (!await r.queue.get(key)) {
    const retry = { 'Retry-After': '60' }
    if (await r.queue.count() >= MAX_QUEUE)
      throw new ReceiverError(429, 'too_many_requests', 'Too many webmentions are waiting. Try again later.', retry)
    if (await r.queue.count(`${hostKey}-`) >= MAX_QUEUE_PER_HOST)
      throw new ReceiverError(429, 'too_many_requests', 'Too many webmentions from this host are waiting. Try again later.', retry)
  }
  await r.queue.put(key, { ...job, receivedAt: r.now(), attempts: 0 })
  r.log('mention.queued', { kind: job.kind, source: job.source, target: job.target })
}

/**
 * Works through the queue, oldest first, within a time budget and a number of jobs (every job fetches documents,
 * and platforms limit the subrequests of a request). Returns the number of jobs done.
 */
export async function processQueue(r: Receiver, { maxJobs = 20, budgetMs = 20_000 } = {}): Promise<number> {
  const start = Date.now()
  let done = 0
  while (done < maxJobs && Date.now() - start < budgetMs) {
    const next = await r.queue.oldest()
    if (!next) break
    const { key } = next
    const job = { ...next.job, attempts: next.job.attempts + 1 }
    if (job.attempts > MAX_ATTEMPTS) {
      r.log('mention.dropped', { job })
      if (job.kind == 'comment' && job.id)
        await writeStatus(r, job.id, { status: 'failure', code: 'moderation-unavailable', text: 'The comment could not be processed.' })
      await r.queue.delete(key)
      continue
    }
    // Counted before the work, so that a job that crashes the worker is dropped eventually.
    await r.queue.put(key, job)
    try {
      await (job.kind == 'comment' ? processComment(r, job) : processMention(r, job))
    } catch (e) {
      if (!(e instanceof ForeignInbox)) throw e
      r.log('inbox.foreign', { error: e.message })
      if (job.kind == 'comment' && job.id)
        await writeStatus(r, job.id, { status: 'failure', code: 'moderation-unavailable', text: "The owner's inbox is not available." })
    }
    // A job that was queued again while it ran (an edit) stays for the next round.
    const again = await r.queue.get(key)
    if (!again || again.receivedAt == job.receivedAt) await r.queue.delete(key)
    done++
  }
  return done
}

// --- Mentions (RFC-11 "Verifying") ---------------------------------------------------------

async function processMention(r: Receiver, { source, target }: Job) {
  const reply = target.includes('#')
  const id = (reply ? 'r-' : 'm-') + await refId(source, target)
  const log = (result: string, extra: Record<string, unknown> = {}) => r.log(`mention.${result}`, { source, target, ...extra })
  let found
  try {
    found = await findItem(r.feeds, source)
  } catch (e) {
    if (!(e instanceof FetchError)) throw e
    // A deleted post withdraws its mention; any other error changes nothing (RFC-11 "Delivering").
    if (e.gone && await removeInboxItem(r, id)) log('removed', { reason: e.message })
    else log('invalid', { reason: e.message })
    return
  }
  const post = found.item
  if (!post) {
    if (found.complete && await removeInboxItem(r, id)) log('removed', { reason: 'item not found' })
    else log('invalid', { reason: 'item not found' })
    return
  }
  if (urlHost(source) == r.ownerHost) return log('ignored', { reason: "the owner's own post" })
  const valid = reply ? await replyTargetsOwner(r, post, found.feed, target) : handles(handleText(post)).includes(r.ownerHost)
  if (valid == undefined) return log('invalid', { reason: 'the target could not be checked' })
  if (!valid) {
    if (await removeInboxItem(r, id)) log('removed', { reason: 'no longer mentions the owner' })
    else log('invalid', { reason: "doesn't mention the owner" })
    return
  }
  const [author, account] = attribution(post, found.feed, found.feed.url)
  try {
    await putInboxItem(r, inboxItem(r, id, reply ? 'reply' : 'mention', source, target, post, excerptHtml(post), author, account))
  } catch (e) {
    if (!(e instanceof InboxFull)) throw e
    return log('refused', { reason: e.message })
  }
  log('delivered', { type: reply ? 'reply' : 'mention' })
}

/**
 * Does a post answer the target, and is the target the owner's item (RFC-11 "Verifying a reply")? Undefined if that
 * can't be decided now.
 */
async function replyTargetsOwner(r: Receiver, post: Post, feed: Feed, target: string): Promise<boolean | undefined> {
  let t
  try {
    t = await findItem(r.feeds, target)
  } catch (e) {
    if (!(e instanceof FetchError)) throw e
    return e.gone ? false : undefined
  }
  if (!t.item) return t.complete ? false : undefined
  const answers = feed.page
    // An HTML page links to the target, or to the target item's permalink.
    ? post.links.some(l => sameRef(l, target) || (t.item!.url != undefined && l == t.item!.url))
    : sameRef(post.inReplyTo, target)
  if (!answers) return false
  const [url] = splitRef(target)
  if (urlHost(url) == r.ownerHost || r.feeds.ownerPath(url) != undefined) return true
  // Republished for the owner: a feed with submissions, and the item carries the owner's account.
  return t.feed.submissions != undefined && accountHost(t.item.account) == r.ownerHost
}

/**
 * The author's name and account for the inbox (RFC-11 "Delivering", RFC-4 "Authorship"). An account on the
 * source's own host is the author's; one on another host only if the source is a feed that republishes submissions,
 * which checked it. The feed's account is the author's only in a feed without submissions.
 */
function attribution(post: Post, feed: Feed, sourceUrl: string): [string | undefined, string | undefined] {
  const account = post.account ?? (feed.submissions == undefined ? feed.account : undefined)
  const host = accountHost(account)
  const trusted = host != undefined && (host == urlHost(sourceUrl) || feed.submissions != undefined)
  return [post.author ?? urlHost(sourceUrl), trusted ? `@${host}` : undefined]
}

// --- Comments (RFC-4) ----------------------------------------------------------------------

async function processComment(r: Receiver, job: Job) {
  const { source } = job
  const id = job.id!
  const fail = async (code: string, text: string) => {
    await writeStatus(r, id, { status: 'failure', code, text })
    r.log('comment.rejected', { source, code, text })
  }
  let target
  try {
    target = await commentTarget(r, job.target)
  } catch (e) {
    if (!(e instanceof ReceiverError)) throw e
    return fail(e.code == 'invalid_request' ? 'target-gone' : e.code, e.message)
  }
  const { policy } = target
  const existing = await findInboxItem(r, id)
  const published = await r.commentFeeds?.published(job.target, id)
  let found, gone = false
  try {
    found = await findItem(r.feeds, source)
    gone = !found.item && found.complete
  } catch (e) {
    if (!(e instanceof FetchError)) throw e
    if (!e.gone) return fail('fetch-failed', e.message)
    gone = true
  }
  if (gone) {
    if ((existing || published) && policy.allowDelete) {
      await removeInboxItem(r, id)
      await r.commentFeeds?.unpublish(job.target, id)
      await writeStatus(r, id, { status: 'deleted' })
      r.log('comment.deleted', { source })
      return
    }
    return fail('item-not-found', 'The comment is not in the author feed.')
  }
  const post = found!.item
  if (!post) return fail(found!.feed.page ? 'invalid-feed' : 'ambiguous-source', 'The comment could not be found in the author feed.')
  if (found!.feed.page) return fail('invalid-feed', 'The author feed must be an RSS 2.0 or JSON Feed.')
  if ((existing || published) && !policy.allowEdit) return fail('edit-not-allowed', "This comment was submitted already, and the feed doesn't allow edits.")
  if (post.inReplyTo == undefined) return fail('in-reply-to-missing', 'The comment has no inReplyTo.')
  if (!sameRef(post.inReplyTo, job.target)) return fail('in-reply-to-mismatch', "The comment's inReplyTo is not the post it was submitted to.")
  if (target.republish == 'summary' && !(typeof post.url == 'string' && /^https?:\/\//i.test(post.url) && isCleanUrlString(post.url)))
    return fail('link-missing', 'Only an abstract of the comment is published here, so it needs a link to its full text.')
  let account = post.account ?? found!.feed.account
  const sourceHost = urlHost(found!.feed.url)
  if (policy.requireSocialSpec && account == undefined) return fail('socialspec-missing', 'The comment needs a socialspec account.')
  if (account != undefined && accountHost(account) != sourceHost) {
    if (policy.requireSocialSpec) return fail('socialspec-mismatch', 'The socialspec account must be on the host of the author feed.')
    account = undefined
  }
  const title = sanitizeText(post.title, 1000)
  if (policy.title == 'required' && title == undefined) return fail('title-required', 'The comment needs a title.')
  if (policy.title == 'none' && title != undefined) return fail('title-not-allowed', 'Comments here have no title.')
  if (title != undefined && [...title].length > MAX_TITLE_CHARS) return fail('title-too-long', `The title is longer than ${MAX_TITLE_CHARS} characters.`)
  const length = [...plainText(post)].length
  if (!length) return fail('empty-content', 'The comment is empty.')
  if (length < policy.minLength) return fail('too-short', `The comment is shorter than ${policy.minLength} characters.`)
  if (length > policy.maxLength) return fail('too-long', `The comment is longer than ${policy.maxLength} characters.`)

  const now = r.now()
  const date = post.date != undefined && Math.abs(Date.parse(post.date) - now) <= DATE_SLACK_MS ? post.date
    : new Date(Math.floor(now / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  // Published after the owner approves it, in full or as an abstract, and only in a kept feed, which has comment feeds.
  const approve = PUBLISHING.includes(target.republish) && !!await r.commentFeeds?.isPublishable(job.target)
  const item = inboxItem(r, id, 'submission', source, job.target, { ...post, date }, postHtml(post), post.author ?? sourceHost,
    account == undefined ? undefined : `@${accountHost(account)}`, approve ? target.republish : undefined, !!published, !!r.commentFeeds?.isCommentFeed(job.target))
  if (published && isSameComment(item, published.item)) {
    // Sent again without a change: nothing to approve.
    await removeInboxItem(r, id)
    await writeStatus(r, id, { status: 'success', pubDate: published.item.date_published ?? date, pubUrl: published.address })
    r.log('comment.unchanged', { source, target: job.target })
    return
  }
  try {
    await putInboxItem(r, item)
  } catch (e) {
    if (!(e instanceof InboxFull)) throw e
    return fail('moderation-unavailable', e.message)
  }
  await writeStatus(r, id, approve ? { status: 'pending' } : { status: 'success', pubDate: date })
  r.log('comment.delivered', { source, target: job.target, edit: !!(existing || published), approve })
}
