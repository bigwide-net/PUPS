import {
  allowsComments, archiveOwner, canonical, COMMENT_ID, commentFeedParts, commentFeedPath, commentsOf, type Committed, FEED_SPEC, FeedError,
  type FeedHost, type FeedPathEntry, isFeedPath, isKept, itemId, itemIndex, type JsonObject, keptFileOwner, KeptFeed, parseJsonFeed, replyFeeds,
  setComments,
} from './kept'

/**
 * Comment feeds (RFC-7 "Publishing comments"): the comments on the owner's posts, and the replies to them, that the
 * owner approved in the inbox, republished by the server (RFC-4 `republish: "full"` or `"summary"`); a port of
 * pups-php's lib/comments.php. Every post or comment with replies has one comment feed of its direct replies, newest
 * first: a post's is `<feed dir>/comments/<index>.json`, a comment's `<feed dir>/comments/<index>/<comment id>.json`,
 * whatever its depth (see commentFeedPath()). The item's `_source.comments` (RFC-1) names it with the counts, and the
 * comment feed names the item it answers in `_pups.inReplyTo`. Replies are nested as deep as the feed's policy allows
 * (RFC-4 `maxDepth`), and at most MAX_DEPTH_LIMIT levels.
 *
 * Like kept.ts, this does no I/O of its own but reading: publishComment() and unpublishComment() return what to write.
 */

/** RFC-4's default `commentLimit`: the comments a post may have, on all levels. */
export const COMMENT_LIMIT = 1000
/** RFC-4's default `maxDepth`, and the deepest nesting the server publishes. */
export const MAX_DEPTH = 5
export const MAX_DEPTH_LIMIT = 10
const RFC4_SPEC = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-4-Feed-Submissions.md'

/** A policy's `maxDepth` as the server applies it: RFC-4's default if it is missing, and between 1 and MAX_DEPTH_LIMIT. */
export const maxDepthOf = (v: unknown) => Number.isInteger(v) ? Math.max(1, Math.min(MAX_DEPTH_LIMIT, v as number)) : MAX_DEPTH

/** A comment feed of a thread: its path, the id of the item it answers, and the document as stored. */
interface Level {
  path: string
  parent: string
  doc?: JsonObject
}

/** Where a comment goes: see commentThread(). */
export interface Thread {
  /** The feed file. */
  path: string
  feed: KeptFeed
  post: JsonObject
  /** The post's index and address (its archive's URL + `#id`). */
  index: number
  address: string
  /** The item that the comment answers, the post or a comment, and its address. */
  parent: JsonObject
  parentAddress: string
  /** The new comment's depth, 1 for a comment on the post. */
  depth: number
  /** The comment feeds from the post's down to the one for the comment. Level k holds comments of depth k + 1, and the item it answers is in level k - 1. */
  levels: Level[]
}

/** What finding a thread needs from the server. */
export type ThreadHost = Pick<CommentFeedOptions, 'host' | 'wellKnown' | 'ownerPath'>

const isObject = (v: unknown): v is JsonObject => typeof v == 'object' && v != null && !Array.isArray(v)
const isoNow = (host: FeedHost) => new Date(host.now()).toISOString().slice(0, 19) + 'Z'
const last = <T>(a: T[]) => a[a.length - 1]!
const find = (doc: JsonObject | undefined, id: string) => (doc?.items as unknown[] ?? []).find(i => isObject(i) && itemId(i) == id) as JsonObject | undefined

/** A URL and the id in its fragment, if any. */
function splitRef(target: string): [string, string | undefined] {
  const i = target.indexOf('#')
  if (i < 0) return [target, undefined]
  try {
    return [target.slice(0, i), decodeURIComponent(target.slice(i + 1)) || undefined]
  } catch {
    return [target.slice(0, i), undefined]
  }
}

/** `url#id`, encoded as PHP's rawurlencode() does. */
const withId = (url: string, id: string) =>
  `${url}#${encodeURIComponent(id).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`

const commentPolicy = (feed: KeptFeed) => {
  const s = feed.doc._submissions
  return isObject(s) && isObject(s.policies) && isObject(s.policies.comments) ? s.policies.comments : undefined
}

/**
 * Where a comment on `target` goes: `target` is a post of a kept feed of the owner, or a comment published in one of
 * its comment feeds. Undefined otherwise, also for a comment that isn't published (anymore). Under the feed's lock if
 * anything is to be changed.
 */
export async function commentThread(o: ThreadHost, target: string): Promise<Thread | undefined> {
  const [url, id] = splitRef(target)
  const path = id == undefined ? undefined : o.ownerPath(url)
  if (path == undefined) return
  const parts = commentFeedParts(path, o.wellKnown)
  const feedPath = parts?.feedPath ?? (isFeedPath(path, o.wellKnown) ? path : archiveOwner(path, o.wellKnown))
  const stored = feedPath ? parseJsonFeed(await o.host.read(feedPath)) : undefined
  if (!feedPath || !isKept(stored)) return
  const feed = await KeptFeed.open(o.host, feedPath, stored)
  const found = parts ? await feed.get(undefined, parts.index) : await feed.get(id)
  const index = found && itemIndex(found.item)
  if (index == undefined) return
  const postId = itemId(found!.item)!
  const thread = { path: feedPath, feed, post: found!.item, index, address: found!.address, parent: found!.item, parentAddress: found!.address }
  const levels: Level[] = []
  if (parts) {
    // The comment feed that holds the comment, and above it those of its ancestors, up to the post's.
    let p = path
    for (;;) {
      const doc = parseJsonFeed(await o.host.read(p))
      const at = commentFeedParts(p, o.wellKnown)
      if (!doc || at?.feedPath != feedPath || at.index != index || levels.length >= MAX_DEPTH_LIMIT) return
      levels.unshift({ path: p, parent: at.commentId ?? postId, doc })
      if (at.commentId == undefined) break
      const up = isObject(doc._pups) ? doc._pups.inReplyTo : undefined
      const [u, upId] = typeof up == 'string' ? splitRef(up) : ['', undefined]
      const next = upId == at.commentId ? o.ownerPath(u) : undefined
      if (next == undefined) return
      p = next
    }
    const comment = find(last(levels).doc, id!)
    if (!comment || !COMMENT_ID.test(id!)) return
    levels.push({ path: commentFeedPath(feedPath, index, id), parent: id! })
    thread.parent = comment
    thread.parentAddress = withId(o.host.publicUrl(path), id!)
  } else levels.push({ path: commentFeedPath(feedPath, index), parent: postId })
  last(levels).doc = parseJsonFeed(await o.host.read(last(levels).path))
  return { ...thread, levels, depth: levels.length }
}

/** A new comment feed, for the comments on what `t` answers. */
function newCommentFeed(host: FeedHost, t: Thread): JsonObject {
  const title = typeof t.post.title == 'string' && t.post.title ? t.post.title : undefined
  const feedTitle = typeof t.feed.doc.title == 'string' ? t.feed.doc.title : undefined
  const on = title != undefined ? `“${title}”` : feedTitle != undefined ? `a post in “${feedTitle}”` : undefined
  const by = (t.parent.authors as JsonObject[] | undefined)?.[0]?.name
  const name = t.depth == 1 ? on != undefined ? `Comments on ${on}` : 'Comments'
    : `Replies to a comment${typeof by == 'string' && by ? ` by ${by}` : ''}${on != undefined ? ` on ${on}` : ''}`
  const http = (u: unknown) => typeof u == 'string' && /^https?:\/\//i.test(u) ? u : undefined
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: name,
    home_page_url: http(t.parent.url) ?? http(t.post.url) ?? host.me,
    feed_url: host.publicUrl(last(t.levels).path),
    user_comment: `${t.depth == 1 ? 'The comments on' : 'The replies to'} ${t.parentAddress} that the owner approved, republished by a Personal Upload Server (PUPS) following ${FEED_SPEC} and ${RFC4_SPEC}.`,
    _pups: { about: FEED_SPEC, pupsControlled: true, inReplyTo: t.parentAddress },
    items: [],
  }
}

/**
 * Turns the target in a comment's `_source.inReplyTo` into RFC-1's object form, with the feed that holds what it answers
 * (the target without its `#id`) and a title, which a reader shows as "In reply to …": for a comment on a post, the
 * title of the post's feed; for a reply, the title of the comment it answers, if it has one, else none, so that the
 * reader names it.
 */
function setInReplyTo(comment: JsonObject, t: Thread) {
  const source = comment._source
  if (!isObject(source) || typeof source.inReplyTo != 'string') return
  const named = t.depth > 1 ? t.parent.title : t.feed.doc.title
  const title = typeof named == 'string' && named ? named : undefined
  source.inReplyTo = { value: source.inReplyTo, feedUrl: splitRef(source.inReplyTo)[0], ...title != undefined && { feedTitle: title } }
}

/** The counts of a comment feed for `_source.comments` (RFC-1): its items, and with all replies to them, as far as the items say. */
export function commentCounts(doc: JsonObject | undefined): [number, number] {
  const items = doc?.items as JsonObject[] ?? []
  let total = 0
  for (const item of items) {
    const c = isObject(item) ? commentsOf(item) : undefined
    total += 1 + Number(c?.total ?? c?.count ?? 0)
  }
  return [items.length, total]
}

/**
 * What writing the comment feeds of a thread means after the deepest one changed, from the bottom up: each one, or its
 * deletion when it is empty, then the counts of the item it answers in the level above, and last the post's. A comment
 * without replies has `{count: 0, total: 0}` while it can get replies, at a depth below the policy's `maxDepth`.
 * `drop` are further files to delete.
 */
async function writeThread(host: FeedHost, t: Thread, drop: string[] = []): Promise<Committed> {
  const maxDepth = maxDepthOf(commentPolicy(t.feed)?.maxDepth)
  const files: Committed['files'] = []
  const deletes = [...drop]
  for (let k = t.levels.length - 1; k >= 0; k--) {
    const { path, parent, doc } = t.levels[k]!
    const [count, total] = commentCounts(doc)
    if (count) files.push({ path, text: JSON.stringify(doc, null, 4) })
    else if (await host.read(path) != undefined) deletes.push(path)
    const url = host.publicUrl(path)
    if (!k) await t.feed.setCommentCounts(parent, url, count, total)
    else {
      const item = find(t.levels[k - 1]!.doc, parent)
      if (item) setComments(item, count ? { feedUrl: url, count, total } : k < maxDepth ? { count: 0, total: 0 } : undefined)
    }
  }
  const c = await t.feed.commit()
  return { ...c, files: [...files, ...c.files], deletes: [...deletes, ...c.deletes] }
}

/**
 * Publishes an approved comment in the comment feed of the post or comment it answers, or replaces it there (an approved
 * edit, which keeps the date of publication and the replies), and updates the counts up to the post. Under the feed's
 * lock. `build` makes the comment for the feed's current RFC-4 `republish`, `full` or `summary`. Returns the comment's
 * address and what to write. Throws 409 if the feed doesn't publish comments (this deep) anymore, or the post has as
 * many comments, on all levels, as its policy allows.
 */
export async function publishComment(host: FeedHost, t: Thread, build: (republish: 'full' | 'summary') => JsonObject)
  : Promise<{ address: string; committed: Committed }> {
  const s = t.feed.doc._submissions
  const republish = isObject(s) ? s.republish : undefined
  if (republish != 'full' && republish != 'summary') throw new FeedError(409, 'conflict', "The feed doesn't publish comments anymore.")
  const policy = commentPolicy(t.feed)
  const maxDepth = maxDepthOf(policy?.maxDepth)
  if (t.depth > maxDepth) throw new FeedError(409, 'max-depth', "The feed doesn't take replies this deep anymore.")
  const level = last(t.levels)
  const doc = level.doc ??= newCommentFeed(host, t)
  const comment = build(republish)
  setInReplyTo(comment, t)
  const open = t.depth < maxDepth ? { count: 0, total: 0 } : undefined
  const items = doc.items as JsonObject[]
  const id = itemId(comment)!
  const at = items.findIndex(i => itemId(i) == id)
  if (at < 0) {
    const limit = Number.isInteger(policy?.commentLimit) ? policy!.commentLimit as number : COMMENT_LIMIT
    if (commentCounts(t.levels[0]!.doc)[1] >= limit) throw new FeedError(409, 'comment-limit', `The post has ${limit} comments, as many as the feed allows.`)
    setComments(comment, open)
    items.unshift(comment)
  } else {
    // An edit keeps the date of publication and the replies (RFC-4 "Edits and deletes").
    const old = items[at]!
    if (typeof old.date_published == 'string') comment.date_published = old.date_published
    setComments(comment, commentsOf(old) ?? open)
    const { date_modified: _, ...oldRest } = old
    if (canonical(comment) != canonical(oldRest)) comment.date_modified = isoNow(host)
    else if (old.date_modified != undefined) comment.date_modified = old.date_modified
    items[at] = comment
  }
  return { address: withId(host.publicUrl(level.path), id), committed: await writeThread(host, t) }
}

/**
 * Removes a published comment, with all replies to it (RFC-4 "Edits and deletes"), from the comment feed of what it
 * answers, and updates the counts up to the post. Returns what to write, and what was removed, each with its address:
 * the comment first, and every reply after what it answers. Undefined if it wasn't there.
 */
export async function unpublishComment(host: FeedHost, t: Thread, id: string)
  : Promise<{ committed: Committed; removed: { item: JsonObject; address: string }[] } | undefined> {
  const level = last(t.levels)
  const items = level.doc?.items as JsonObject[] | undefined
  const comment = items?.find(i => itemId(i) == id)
  if (!comment) return
  const removed = [{ item: comment, address: withId(host.publicUrl(level.path), id) }]
  for (let i = 0; i < removed.length && i < 10_000; i++) {
    const rid = itemId(removed[i]!.item)
    const path = rid != undefined && COMMENT_ID.test(rid) ? commentFeedPath(t.path, t.index, rid) : undefined
    for (const reply of path == undefined ? [] : parseJsonFeed(await host.read(path))?.items as JsonObject[] ?? [])
      if (isObject(reply) && itemId(reply) != undefined) removed.push({ item: reply, address: withId(host.publicUrl(path!), itemId(reply)!) })
  }
  level.doc!.items = items!.filter(i => i != comment)
  return { committed: await writeThread(host, t, await replyFeeds(host, t.path, t.index, [id])), removed }
}

/** What the comment feeds need from the server. */
export interface CommentFeedOptions {
  host: FeedHost
  wellKnown: FeedPathEntry[]
  /** The storage path of a URL that the server serves for the owner, or undefined. */
  ownerPath(url: string): string | undefined
  /** Runs `fn` under the lock of a feed file. */
  withLock<T>(feedPath: string, fn: () => Promise<T>): Promise<T>
  /** Writes what was committed, in order, and deletes what it says; throws an error with an HTTP `status` (507) if the storage quota would be exceeded. */
  write(c: Committed): Promise<void>
}

/**
 * The comment feeds of a server's kept feeds, by the URLs of the posts and comments that comments answer: what the
 * built-in receiver (pups-inbox) needs to publish approved comments. Refusals are FeedErrors, with an HTTP `status` and
 * a `code`.
 */
export function commentFeeds(o: CommentFeedOptions) {
  const thread = (target: string) => commentThread(o, target)
  /** The feed file whose lock covers comments on `target`. */
  const feedOf = (target: string) => {
    const path = o.ownerPath(splitRef(target)[0])
    return path == undefined ? undefined
      : commentFeedParts(path, o.wellKnown)?.feedPath ?? (isFeedPath(path, o.wellKnown) ? path : archiveOwner(path, o.wellKnown))
  }
  const locked = async <T>(target: string, fn: (t: Thread | undefined) => Promise<T>) => {
    const feedPath = feedOf(target)
    return feedPath ? o.withLock(feedPath, async () => fn(await thread(target))) : fn(undefined)
  }
  return {
    /** Whether comments on `target` can be published: it is a post of a kept feed, or a comment published in one of its comment feeds. */
    isPublishable: async (target: string) => !!await thread(target),
    /** Whether a URL is in a comment feed: comments on it would be replies to comments. */
    isCommentFeed(url: string) {
      const path = o.ownerPath(splitRef(url)[0])
      return path != undefined && keptFileOwner(path, o.wellKnown) != undefined && archiveOwner(path, o.wellKnown) == undefined
    },
    /**
     * For a reply to the published comment `target`: its depth, the `_submissions` of the post's feed, and whether the
     * post takes comments. Undefined if the comment isn't published.
     */
    async reply(target: string) {
      const t = await thread(target)
      return t && { depth: t.depth, submissions: isObject(t.feed.doc._submissions) ? t.feed.doc._submissions : undefined, open: allowsComments(t.post) }
    },
    /** The title and URL of the post that `target`, a post or a comment in its thread, belongs to. */
    async post(target: string) {
      const t = await thread(target)
      const str = (v: unknown) => typeof v == 'string' && v ? v : undefined
      return t && { title: str(t.post.title), url: str(t.post.url) }
    },
    /** The comment `id` as published in answer to `target`, and its address. */
    async published(target: string, id: string) {
      const t = await thread(target)
      const item = t && find(last(t.levels).doc, id)
      return item && { item, address: withId(o.host.publicUrl(last(t!.levels).path), id) }
    },
    /** Publishes or replaces a comment in answer to `target`, made by `build` for the feed's `republish`; returns its address. */
    publish: (target: string, build: (republish: 'full' | 'summary') => JsonObject) => locked(target, async t => {
      if (!t) throw new FeedError(409, 'conflict', "What the comment answers doesn't exist anymore, or its feed isn't kept by this server.")
      const r = await publishComment(o.host, t, build)
      await o.write(r.committed)
      return r.address
    }),
    /** The item that `target` names: a post of a kept feed, or a published comment. */
    item: async (target: string) => (await thread(target))?.parent,
    /** Removes a published comment, with its replies, from those on `target`. Returns what was removed, the comment first. */
    unpublish: (target: string, id: string) => locked(target, async t => {
      const r = t && await unpublishComment(o.host, t, id)
      if (r) await o.write(r.committed)
      return r?.removed ?? []
    }),
  }
}

export type CommentFeeds = ReturnType<typeof commentFeeds>
