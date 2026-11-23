import {
  archiveOwner, canonical, commentFeedPath, commentsOf, type Committed, FEED_SPEC, FeedError, type FeedHost, type FeedPathEntry,
  isFeedPath, isKept, itemId, itemIndex, type JsonObject, keptFileOwner, KeptFeed, parseJsonFeed, setComments,
} from './kept'

/**
 * Comment feeds (RFC-7 "Publishing comments"): the comments on the owner's posts that the owner approved in the inbox,
 * republished by the server (RFC-4 `republish: "full"`); a port of pups-php's lib/comments.php. A post of a kept feed
 * has at most one comment feed, `<feed dir>/comments/<index>.json`, newest first, and its `_source.comments` (RFC-1)
 * names it with the counts. Only comments on posts are accepted so far; replies to comments will get comment feeds of
 * their own (see commentFeedPath()).
 *
 * Like kept.ts, this does no I/O of its own: publishComment() and unpublishComment() return what to write.
 */

/** RFC-4's default `commentLimit`: the comments a post may have on all levels. */
export const COMMENT_LIMIT = 1000
const RFC4_SPEC = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-4-Feed-Submissions.md'

export interface KeptPost {
  /** The feed file. */
  path: string
  feed: KeptFeed
  post: JsonObject
  /** The post's address: its archive's URL + `#id`. */
  address: string
  index: number
}

const isObject = (v: unknown): v is JsonObject => typeof v == 'object' && v != null && !Array.isArray(v)
const isoNow = (host: FeedHost) => new Date(host.now()).toISOString().slice(0, 19) + 'Z'

/** The post `id` in the kept feed that `storagePath`, a feed file or one of its archives, belongs to. */
export async function keptPost(host: FeedHost, wellKnown: FeedPathEntry[], storagePath: string, id: string): Promise<KeptPost | undefined> {
  const path = isFeedPath(storagePath, wellKnown) ? storagePath : archiveOwner(storagePath, wellKnown)
  const stored = path ? parseJsonFeed(await host.read(path)) : undefined
  if (!path || !isKept(stored)) return
  const feed = await KeptFeed.open(host, path, stored)
  const found = await feed.get(id)
  const index = found && itemIndex(found.item)
  return index == undefined ? undefined : { path, feed, post: found!.item, address: found!.address, index }
}

const commentFeedOf = (p: KeptPost) => commentFeedPath(p.path, p.index)

/** The comment feed of a post as stored. */
const loadCommentFeed = async (host: FeedHost, p: KeptPost) => parseJsonFeed(await host.read(commentFeedOf(p)))

/** A new comment feed for a post. */
function newCommentFeed(host: FeedHost, p: KeptPost): JsonObject {
  const title = typeof p.post.title == 'string' && p.post.title ? p.post.title : undefined
  const feedTitle = typeof p.feed.doc.title == 'string' ? p.feed.doc.title : undefined
  const url = p.post.url
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: title != undefined ? `Comments on “${title}”` : feedTitle != undefined ? `Comments on a post in “${feedTitle}”` : 'Comments',
    home_page_url: typeof url == 'string' && /^https?:\/\//i.test(url) ? url : host.me,
    feed_url: host.publicUrl(commentFeedOf(p)),
    user_comment: `The comments on ${p.address} that the owner approved, republished by a Personal Upload Server (PUPS) following ${FEED_SPEC} and ${RFC4_SPEC}.`,
    _pups: { about: FEED_SPEC, pupsControlled: true },
    items: [],
  }
}

/** The counts of a comment feed for `_source.comments` (RFC-1): its items, and with all replies to them, as far as the items say. */
export function commentCounts(doc: JsonObject): [number, number] {
  const items = doc.items as JsonObject[]
  let total = 0
  for (const item of items) {
    const c = isObject(item) ? commentsOf(item) : undefined
    total += 1 + Number(c?.total ?? c?.count ?? 0)
  }
  return [items.length, total]
}

/** What writing a comment feed means: the comment feed, or its deletion when empty, then the post's counts. */
async function writeCommentFeed(host: FeedHost, p: KeptPost, doc: JsonObject): Promise<Committed> {
  const path = commentFeedOf(p)
  const [count, total] = commentCounts(doc)
  await p.feed.setCommentCounts(itemId(p.post)!, host.publicUrl(path), count, total)
  const c = await p.feed.commit()
  return count
    ? { ...c, files: [{ path, text: JSON.stringify(doc, null, 4) }, ...c.files] }
    : { ...c, deletes: [...await host.read(path) != undefined ? [path] : [], ...c.deletes] }
}

/** The comment `id` as published on the post, and its address. */
export async function publishedComment(host: FeedHost, p: KeptPost | undefined, id: string): Promise<{ item: JsonObject; address: string } | undefined> {
  const item = p && ((await loadCommentFeed(host, p))?.items as JsonObject[] ?? []).find(i => itemId(i) == id)
  return item && { item, address: commentAddress(host, p!, id) }
}

/** The address of a comment on a post: its comment feed's URL + `#id`. */
export const commentAddress = (host: FeedHost, p: KeptPost, id: string) =>
  `${host.publicUrl(commentFeedOf(p))}#${encodeURIComponent(id).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`

/**
 * Publishes an approved comment in the comment feed of its post, or replaces it there (an approved edit, which keeps
 * the date of publication), and updates the post's counts. Under the feed's lock. `build` makes the comment for the
 * feed's current RFC-4 `republish`, `full` or `summary`. Returns the comment's address and what to write. Throws 409 if
 * the feed doesn't publish comments anymore, or the post has as many comments as its policy allows.
 */
export async function publishComment(host: FeedHost, p: KeptPost, build: (republish: 'full' | 'summary') => JsonObject)
  : Promise<{ address: string; committed: Committed }> {
  const s = p.feed.doc._submissions
  const republish = isObject(s) ? s.republish : undefined
  if (republish != 'full' && republish != 'summary') throw new FeedError(409, 'conflict', "The feed doesn't publish comments anymore.")
  const comment = build(republish)
  const doc = await loadCommentFeed(host, p) ?? newCommentFeed(host, p)
  const items = doc.items as JsonObject[]
  const id = itemId(comment)!
  const at = items.findIndex(i => itemId(i) == id)
  if (at < 0) {
    const limit = isObject(s) && isObject(s.policies) && isObject(s.policies.comments) && Number.isInteger(s.policies.comments.commentLimit)
      ? s.policies.comments.commentLimit as number : COMMENT_LIMIT
    if (commentCounts(doc)[1] >= limit) throw new FeedError(409, 'comment-limit', `The post has ${limit} comments, as many as the feed allows.`)
    items.unshift(comment)
  } else {
    // An edit keeps the date of publication (RFC-4 "Edits and deletes").
    const old = items[at]!
    if (typeof old.date_published == 'string') comment.date_published = old.date_published
    const replies = commentsOf(old)
    if (replies) setComments(comment, replies)
    const { date_modified: _, ...oldRest } = old
    if (canonical(comment) != canonical(oldRest)) comment.date_modified = isoNow(host)
    else if (old.date_modified != undefined) comment.date_modified = old.date_modified
    items[at] = comment
  }
  return { address: commentAddress(host, p, id), committed: await writeCommentFeed(host, p, doc) }
}

/** Removes a published comment from the comment feed of its post and updates the post's counts. Undefined if it wasn't there. */
export async function unpublishComment(host: FeedHost, p: KeptPost, id: string): Promise<Committed | undefined> {
  const doc = await loadCommentFeed(host, p)
  const items = doc?.items as JsonObject[] | undefined
  if (!items?.some(i => itemId(i) == id)) return
  doc!.items = items.filter(i => itemId(i) != id)
  return writeCommentFeed(host, p, doc!)
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
 * The comment feeds of a server's kept feeds, by the URLs of the posts that comments answer: what the built-in receiver
 * (pups-inbox) needs to publish approved comments. Refusals are FeedErrors, with an HTTP `status` and a `code`.
 */
export function commentFeeds(o: CommentFeedOptions) {
  const locate = (target: string) => {
    const i = target.indexOf('#')
    const id = i < 0 ? '' : decodeURIComponent(target.slice(i + 1))
    const path = id ? o.ownerPath(target.slice(0, i)) : undefined
    return path == undefined ? undefined : { path, id, feedPath: isFeedPath(path, o.wellKnown) ? path : archiveOwner(path, o.wellKnown) }
  }
  const post = async (target: string) => {
    const t = locate(target)
    return t && keptPost(o.host, o.wellKnown, t.path, t.id)
  }
  const locked = async <T>(target: string, fn: (p: KeptPost | undefined) => Promise<T>) => {
    const t = locate(target)
    return t?.feedPath ? o.withLock(t.feedPath, async () => fn(await post(target))) : fn(undefined)
  }
  return {
    /** Whether `target` is a post of a kept feed, whose comments can be published. */
    isKeptPost: async (target: string) => !!await post(target),
    /** Whether a URL is in a comment feed: comments on it would be replies to comments. */
    isCommentFeed(url: string) {
      const path = o.ownerPath(url.split('#')[0]!)
      return path != undefined && keptFileOwner(path, o.wellKnown) != undefined && archiveOwner(path, o.wellKnown) == undefined
    },
    /** The comment `id` as published on the post `target`, and its address. */
    published: async (target: string, id: string) => publishedComment(o.host, await post(target), id),
    /** Publishes or replaces a comment on the post `target`, made by `build` for the feed's `republish`; returns its address. */
    publish: (target: string, build: (republish: 'full' | 'summary') => JsonObject) => locked(target, async p => {
      if (!p) throw new FeedError(409, 'conflict', "The post doesn't exist anymore, or its feed isn't kept by this server.")
      const r = await publishComment(o.host, p, build)
      await o.write(r.committed)
      return r.address
    }),
    /** Removes a published comment from the post `target`. Returns whether it was there. */
    unpublish: (target: string, id: string) => locked(target, async p => {
      const c = p && await unpublishComment(o.host, p, id)
      if (c) await o.write(c)
      return !!c
    }),
  }
}

export type CommentFeeds = ReturnType<typeof commentFeeds>
