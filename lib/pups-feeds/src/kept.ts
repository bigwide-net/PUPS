/**
 * The owner's feeds, kept by the server (RFC-7 "Kept feeds"); a port of pups-php's lib/archive.php. Apps write a feed
 * file with PUT, or send single items with POST; the server keeps the archives of RFC-13. It gives new items their
 * index and post URL, puts every item into exactly one archive, starts a new archive when the newest is full, applies
 * edits and deletes in the item's archive, and writes the feed file with copies of the newest items. Apps never write
 * archives.
 *
 * If the feed's `_submissions` names the server's comment endpoint, the server also keeps the posts'
 * `_source.comments` (RFC-1): the comment feed and the counts that comments.ts writes.
 *
 * Only feed files with `"_pups": { "pupsControlled": true }` are kept; others are ordinary files. Documents stay plain
 * JSON values, so that fields the server doesn't know survive unchanged.
 *
 * The package does no I/O of its own: the server reads files through a FeedHost, writes what commit() returns, and
 * does both under its lock.
 */

export const FEED_REL = 'https://bigwide.net/ns/feed'
export const FEED_SPEC = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-7-Feed-Publishing-with-PUPS.md'
export const ARCHIVE_SPEC = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-13-JSON-Feed-Archives.md'
export const POST_URL_TEMPLATE_PROP = 'https://bigwide.net/ns/post-url-template'
export const SOURCE_SPEC = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-1-Source-for-JSON-Feeds.md'
const JSON_FEED_VERSION = 'https://jsonfeed.org/version/1.1'
/** Items in the feed file (RFC-7 "Feed size"). */
export const FEED_ITEMS = 30
/** Items in an archive of a new feed (RFC-7 "Archives"). */
export const ARCHIVE_SIZE = 20
const FEED_NAME = '[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?'
const MAX_ITEM_ID = 200
const FEED_COMMENT = `This feed is kept by a Personal Upload Server (PUPS), following ${FEED_SPEC}. ` +
  'It contains the newest items; all items are in the archives, starting with the one at _archive.archive_url.'
/** Top-level fields of the feed file that the server sets, not the apps. */
const MANAGED_FIELDS = ['version', 'home_page_url', 'feed_url', 'user_comment', 'next_url', 'items', '_archive']
/** Names in `/feed/` that belong to the main feed, so no named feed can have them (RFC-7 "Named feeds"). */
export const RESERVED_FEED_NAMES = ['images', 'media', 'comments']

export type Json = null | boolean | number | string | Json[] | JsonObject
export interface JsonObject { [key: string]: Json }
type Item = JsonObject

/** An error with an HTTP status and an RFC-6 error code; the server answers with it. */
export class FeedError extends Error {
  constructor(public status: number, public code: string, message: string, public headers: Record<string, string> = {}) {
    super(message)
  }
}

/** What a kept feed needs from the server. */
export interface FeedHost {
  /** The owner's identity, `https://tim.example.com/`: the `home_page_url` of feeds and archives. */
  me: string
  /** The public URL of a storage path. */
  publicUrl(path: string): string
  /** The storage path of a public URL, or undefined. */
  pathFromPublicUrl(url: string): string | undefined
  /** A stored file as text, or undefined if it doesn't exist. */
  read(path: string): Promise<string | undefined>
  /** The value of the post URL template property in the stored host-meta.json, if any (RFC-6 "Post URLs"). */
  postUrlTemplate(): Promise<unknown>
  /** ms since the epoch. */
  now(): number
  /**
   * The built-in receiver's comment endpoint, if it takes comments (RFC-6 "Built-in receiver"). Posts of feeds whose
   * `_submissions.url` names it get their `_source.comments` from the server.
   */
  commentEndpoint?: string
}

/** A declared well-known path, as far as kept feeds care. */
export interface FeedPathEntry {
  path: string
  rels: string[]
}

const isObject = (v: unknown): v is JsonObject => typeof v == 'object' && v != null && !Array.isArray(v)

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
/** A new item id: `p-` and 16 random URL-safe characters. */
export const newItemId = () => 'p-' + b64url(crypto.getRandomValues(new Uint8Array(12)))

/** Percent-encodes like PHP's rawurlencode() (RFC 3986). */
const rawurlencode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())

/**
 * Whether `path` is a feed file (RFC-7 "Feeds and their files"): a declared file with the feed relation, such as
 * /feed.json, or `<name>.json` directly in a declared directory with it.
 */
export function isFeedPath(path: string, wellKnown: FeedPathEntry[]): boolean {
  for (const e of wellKnown) {
    if (!e.rels.includes(FEED_REL)) continue
    if (e.path == path && path.endsWith('.json')) return true
    const m = e.path.endsWith('/') && path.startsWith(e.path) ? new RegExp(`^(${FEED_NAME})\\.json$`).exec(path.slice(e.path.length)) : null
    if (m && !RESERVED_FEED_NAMES.includes(m[1]!)) return true
  }
  return false
}

/** The feed file that `path` is an archive of (`/feed/feed.000002.json` → `/feed.json`), or undefined. */
export function archiveOwner(path: string, wellKnown: FeedPathEntry[]): string | undefined {
  const m = /^(\/.+)\/feed\.\d{6,}\.json$/.exec(path)
  return m && isFeedPath(`${m[1]}.json`, wellKnown) ? `${m[1]}.json` : undefined
}

/**
 * The feed file whose archives or comment feeds `path` belongs to, if it were kept (`/feed/feed.000002.json`,
 * `/feed/comments/47.json` → `/feed.json`), or undefined. Only the server writes these.
 */
export function keptFileOwner(path: string, wellKnown: FeedPathEntry[]): string | undefined {
  const m = /^(\/.+?)\/comments\/.+$/.exec(path)
  return archiveOwner(path, wellKnown) ?? (m && isFeedPath(`${m[1]}.json`, wellKnown) ? `${m[1]}.json` : undefined)
}

/**
 * The comment feed of a post: `<feed dir>/comments/<index>.json`, e.g. /feed/comments/47.json (RFC-7 "Comment
 * feeds"). Replies to a comment will go to `<feed dir>/comments/<index>/<comment id>.json`; the servers accept
 * comments on posts only so far.
 */
export const commentFeedPath = (feedPath: string, index: number) => `${feedPath.slice(0, -5)}/comments/${index}.json`

export const archivePath = (feedPath: string, n: number) => `${feedPath.slice(0, -5)}/feed.${String(n).padStart(6, '0')}.json`

/** A JSON Feed, or undefined if `text` isn't one. */
export function parseJsonFeed(text: string | undefined): JsonObject | undefined {
  if (text == undefined) return
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return
  }
  return isObject(doc) && typeof doc.version == 'string' && doc.version.startsWith('https://jsonfeed.org/version/1') && Array.isArray(doc.items)
    ? doc : undefined
}

/** Whether a document carries the marker of RFC-7. */
export const isKept = (doc: unknown) => isObject(doc) && isObject(doc._pups) && doc._pups.pupsControlled === true

/** Whether a feed file's text is a kept feed. */
export const isKeptText = (text: string | undefined) => isKept(parseJsonFeed(text))

export function itemIndex(item: unknown): number | undefined {
  const i = isObject(item) && isObject(item._archive) ? item._archive.index : undefined
  return Number.isInteger(i) && (i as number) >= 0 ? i as number : undefined
}

export function itemId(item: unknown): string | undefined {
  const id = isObject(item) ? item.id : undefined
  return typeof id == 'string' || Number.isInteger(id) ? String(id) : undefined
}

function setIndex(item: Item, index: number | undefined) {
  const archive: JsonObject = isObject(item._archive) ? item._archive : {}
  if (index == undefined) delete archive.index
  else archive.index = index
  if (Object.keys(archive).length) item._archive = archive
  else delete item._archive
}

/** An item's `_source.comments` (RFC-1), if it has a valid `count`. */
export function commentsOf(item: JsonObject): JsonObject | undefined {
  const c = isObject(item._source) ? item._source.comments : undefined
  return isObject(c) && Number.isInteger(c.count) && (c.count as number) >= 0 ? c : undefined
}

/** Sets or removes an item's `_source.comments`; `_source` goes when nothing else is left in it. */
export function setComments(item: JsonObject, comments: JsonObject | undefined) {
  let source: JsonObject = isObject(item._source) ? item._source : { about: SOURCE_SPEC }
  if (comments) {
    source = { about: SOURCE_SPEC, ...source }
    source.comments = comments
  } else delete source.comments
  if (Object.keys(source).some(k => k != 'about')) item._source = source
  else delete item._source
}

/** Whether an item accepts comments, as far as it says (RFC-4 `_commenting`, default true). */
export const allowsComments = (item: JsonObject) => !(isObject(item._commenting) && item._commenting.allowComments === false)

/** A JSON value with the keys of every object sorted, for comparing items. */
export function canonical(v: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v
  return JSON.stringify(sort(v))
}

export const deepCopy = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const utf8Length = (s: string) => new TextEncoder().encode(s).byteLength

/** An item with an id first: `{ id, ...item }`. */
const withId = (item: Item, id: string): Item => ({ id, ...item })

/** Checks a new or changed item from an app, and gives it an id if it has none. Throws 400. */
export function checkItem(item: unknown): Item {
  if (!isObject(item)) throw new FeedError(400, 'invalid_request', 'An item must be a JSON object')
  if (item.id == null) item = withId(item, newItemId())
  else if (typeof item.id != 'string' || item.id == '' || utf8Length(item.id) > MAX_ITEM_ID || /[\x00-\x1f\x7f]/.test(item.id))
    throw new FeedError(400, 'invalid_request', `An item id must be a string of 1 to ${MAX_ITEM_ID} characters without control characters`)
  const it = item as Item
  if (typeof it.content_html != 'string' && typeof it.content_text != 'string')
    throw new FeedError(400, 'invalid_request', `The item "${it.id}" needs content_html or content_text (JSON Feed)`)
  return it
}

export interface PutResult {
  /** The item as stored. */
  item: Item
  /** Its address: the archive's URL and `#id`. */
  address: string
  created: boolean
  changed: boolean
}

export interface Committed {
  /** The files to write, in this order: the changed archives, the oldest first, and the feed file last. */
  files: { path: string; text: string }[]
  /** The files to delete afterwards: the comment feeds of deleted posts. */
  deletes: string[]
  /** The feed file as written. */
  text: string
}

/**
 * A feed file and its archives while the server changes them, under its lock. Archives are read when needed;
 * commit() returns the changed archives, from the oldest to the newest, and then the feed file (RFC-13 "The archive
 * comes first").
 */
export class KeptFeed {
  /** The feed file's fields. Its items are rebuilt from the archives on commit(). */
  doc: JsonObject
  /** The items of the stored feed file, newest first: where items are looked for first. */
  private window: Item[] = []
  private size = ARCHIVE_SIZE
  /** The number of the newest archive, or undefined for a feed without archives (no item yet). */
  private newest: number | undefined
  /** The index of the next new item (RFC-13 "Indexes"). */
  private next = 0
  /** `next_url` of a handed-over feed without archives: the oldest archive continues it. */
  private oldChain: string | undefined
  private archives = new Map<number, JsonObject | undefined>()
  private changed = new Set<number>()
  private template: string | undefined | false = false
  /** Whether every post's `_source.comments` must be brought up to date on commit(). */
  private refresh = false
  /** Indexes of deleted posts, whose comment feeds go on commit(). */
  private dropped: number[] = []

  private constructor(private host: FeedHost, public path: string, stored: JsonObject | undefined) {
    this.doc = stored ?? { version: JSON_FEED_VERSION, items: [] }
  }

  /** `stored` is the stored feed file, or undefined for a new feed. A feed without archives gets them now. */
  static async open(host: FeedHost, path: string, stored: JsonObject | undefined): Promise<KeptFeed> {
    const f = new KeptFeed(host, path, stored)
    await f.init()
    return f
  }

  private async init() {
    const archive = this.doc._archive
    const url = isObject(archive) ? archive.archive_url : undefined
    const prefix = this.path.slice(0, -5).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = typeof url == 'string' ? new RegExp(`^${prefix}/feed\\.(\\d{6,})\\.json$`).exec(this.host.pathFromPublicUrl(url) ?? '') : null
    if (m && isObject(archive)) {
      this.newest = Number(m[1])
      const size = archive.archive_size
      this.size = Number.isInteger(size) && (size as number) > 0 ? size as number : ARCHIVE_SIZE
      this.window = [...this.items(this.doc)]
      const newest = await this.archive(this.newest)
      const counter = isObject(newest?._archive) ? newest._archive.next_index : undefined
      this.next = Number.isInteger(counter) && (counter as number) >= 0 ? counter as number
        : this.nextFree([...this.window, ...(newest?.items as Item[] ?? [])])
    } else await this.start()
  }

  /**
   * Starts the archives of a feed that has none (RFC-13 "Starting the archives"): its items get indexes, from the
   * oldest to the newest, and go into archives of 20, the oldest first.
   */
  private async start() {
    const items = [...this.items(this.doc)]
    const counter = isObject(this.doc._archive) ? this.doc._archive.next_index : undefined
    let next = this.nextFree(items, Number.isInteger(counter) ? counter as number : 0)
    for (let i = items.length - 1; i >= 0; i--)
      if (itemIndex(items[i]) == undefined) setIndex(items[i]!, next++)
    this.next = next
    this.window = items
    this.oldChain = typeof this.doc.next_url == 'string' ? this.doc.next_url : undefined
    const oldestFirst = [...items].reverse()
    for (let n = 0; n * this.size < oldestFirst.length; n++)
      await this.create(n, oldestFirst.slice(n * this.size, (n + 1) * this.size).reverse())
    this.refresh = true
  }

  /** The items of a document that are objects with an id. Items without an id get one. */
  private items(doc: JsonObject): Item[] {
    const items = (Array.isArray(doc.items) ? doc.items : []).filter(isObject).map(i => itemId(i) == undefined ? withId(i, newItemId()) : i)
    return doc.items = items
  }

  private nextFree(items: Item[], counter = 0): number {
    for (const item of items) counter = Math.max(counter, (itemIndex(item) ?? -1) + 1)
    return counter
  }

  private archiveUrl = (n: number) => this.host.publicUrl(archivePath(this.path, n))

  /** The item's address: its archive's URL + `#id` (RFC-13 "Items"). */
  address = (n: number, id: string) => `${this.archiveUrl(n)}#${rawurlencode(id)}`

  /** An archive, or undefined if it is missing or isn't a JSON Feed. */
  private async archive(n: number): Promise<JsonObject | undefined> {
    if (!this.archives.has(n)) {
      const doc = parseJsonFeed(await this.host.read(archivePath(this.path, n)))
      if (doc) this.items(doc)
      this.archives.set(n, doc)
    }
    return this.archives.get(n)
  }

  private archiveItems = (n: number) => this.archives.get(n)!.items as Item[]

  /** The newest archive; if the owner deleted it, it is created again. */
  private async newestArchive(): Promise<JsonObject> {
    return await this.archive(this.newest!) ?? await this.create(this.newest!, [])
  }

  /**
   * Creates archive `n` with the feed fields of the feed file (RFC-13 "Feed fields of an archive"), without the fields
   * that describe the live feed.
   */
  private async create(n: number, items: Item[]): Promise<JsonObject> {
    const a: JsonObject = { version: JSON_FEED_VERSION }
    const skip = [...MANAGED_FIELDS, 'hubs', 'author', '_pups', '_submissions']
    for (const [k, v] of Object.entries(this.doc))
      if (!skip.includes(k)) a[k] = deepCopy(v)
    if (isObject(a._podcast)) delete a._podcast.liveItems
    a.home_page_url = this.host.me
    a.feed_url = this.archiveUrl(n)
    a.user_comment = `This is an archive of ${this.host.publicUrl(this.path)}, kept by a Personal Upload Server (PUPS) following ${FEED_SPEC}. ` +
      'New items appear in the feed at _archive.updates_url, older ones are in the archive at next_url.'
    const next = n ? this.archiveUrl(n - 1) : this.oldChain
    if (next != undefined) a.next_url = next
    a._pups = { about: FEED_SPEC, pupsControlled: true }
    a._archive = {}
    a.items = items
    // Only the newest archive holds the counter: the one before loses it on commit().
    if (this.newest != undefined && n > this.newest && await this.archive(this.newest)) this.changed.add(this.newest)
    this.newest = Math.max(this.newest ?? n, n)
    this.changed.add(n)
    this.archives.set(n, a)
    return a
  }

  /** The lowest and highest index in archive `n`, or undefined if it holds none. */
  private async bounds(n: number): Promise<[number, number] | undefined> {
    const indexes = ((await this.archive(n))?.items as Item[] ?? []).map(itemIndex).filter(i => i != undefined) as number[]
    return indexes.length ? [Math.min(...indexes), Math.max(...indexes)] : undefined
  }

  /** The position of the item `id` in archive `n`; with `index`, only if it has that index. */
  private async position(n: number, id: string, index?: number): Promise<number | undefined> {
    const p = ((await this.archive(n))?.items as Item[] ?? []).findIndex(item => itemId(item) == id && (index == undefined || itemIndex(item) == index))
    return p < 0 ? undefined : p
  }

  /**
   * Finds an item: with its index as RFC-13 "Finding an item by index" describes, else in the feed file and the newest
   * archive, and with `everywhere` in all archives. Returns [archive number, position].
   */
  async find(id: string, index: number | undefined, everywhere = false): Promise<[number, number] | undefined> {
    if (this.newest == undefined) return
    if (index == undefined)
      for (const item of this.window)
        if (itemId(item) == id && (index = itemIndex(item)) != undefined) break
    if (index != undefined) {
      const start = Math.min(this.newest, Math.floor(index / this.size))
      for (let n = start; n >= 0; n--) {
        const p = await this.position(n, id, index)
        if (p != undefined) return [n, p]
        if (((await this.bounds(n))?.[1] ?? Infinity) < index) break
      }
      for (let n = start + 1; n <= this.newest; n++) {
        const p = await this.position(n, id, index)
        if (p != undefined) return [n, p]
        if (((await this.bounds(n))?.[0] ?? -1) > index) break
      }
      return
    }
    for (let n = this.newest; n >= (everywhere ? 0 : this.newest); n--) {
      const p = await this.position(n, id)
      if (p != undefined) return [n, p]
    }
  }

  /** The post URL template from host-meta.json (RFC-6 "Post URLs"), or undefined. */
  private async postUrlTemplate(): Promise<string | undefined> {
    if (this.template === false) {
      let t: unknown
      try {
        t = await this.host.postUrlTemplate()
      } catch {
        t = undefined
      }
      this.template = typeof t == 'string' && t.startsWith('https://') && /\{(index|id)\}/.test(t) ? t : undefined
    }
    return this.template
  }

  /** Gives an item without `url` the URL of its page (RFC-7 "Post URLs"). */
  private async withPostUrl(item: Item) {
    const index = itemIndex(item)
    if (typeof item.url == 'string' && item.url || index == undefined) return
    const t = await this.postUrlTemplate()
    if (!t) return
    const vars: Record<string, string> = { feed: this.path.slice(1, -5), index: String(index), id: rawurlencode(itemId(item)!) }
    item.url = t.replace(/\{(feed|index|id)\}/g, (_, k: string) => vars[k]!)
  }

  /** Whether the server keeps the posts' `_source.comments`: `_submissions` names its comment endpoint. */
  private ownsComments(): boolean {
    const s = this.doc._submissions
    return !!this.host.commentEndpoint && isObject(s) && s.url === this.host.commentEndpoint
  }

  /** Whether the feed accepts comments at this server: it has a comments policy. */
  private commentsOpen(): boolean {
    const s = this.doc._submissions
    return this.ownsComments() && isObject(s) && isObject(s.policies) && isObject(s.policies.comments)
  }

  /**
   * Sets an item's `_source.comments` as the server keeps it: the comment feed and counts of `old`, the stored item,
   * if it has comments; else `{count: 0, total: 0}` while the post accepts comments, and nothing otherwise. Unless
   * `always`, only in a feed whose comments the server keeps; elsewhere the item keeps what the app sent.
   */
  private withComments(item: Item, old: Item | undefined, always = false) {
    if (!always && !this.ownsComments()) return
    const c = old && commentsOf(old)
    setComments(item, c && c.count ? deepCopy(c) : this.commentsOpen() && allowsComments(item) ? { count: 0, total: 0 } : undefined)
  }

  /** Brings every post's `_source.comments` up to date, e.g. after the feed was opened for comments. */
  private async refreshComments() {
    for (let n = 0; n <= (this.newest ?? -1); n++)
      for (const item of (await this.archive(n))?.items as Item[] ?? []) {
        const before = canonical(item)
        this.withComments(item, deepCopy(item), true)
        if (canonical(item) != before) this.changed.add(n)
      }
  }

  /** An item by its id, in any archive, and its address. */
  async get(id: string): Promise<{ item: Item; address: string } | undefined> {
    const at = await this.find(id, undefined, true)
    return at && { item: this.archiveItems(at[0])[at[1]]!, address: this.address(at[0], id) }
  }

  /**
   * Sets a post's comment feed and counts (RFC-1 `_source.comments`) after a comment was published or removed. The
   * post isn't modified otherwise and gets no `date_modified`. False if there is no such post.
   */
  async setCommentCounts(id: string, feedUrl: string, count: number, total: number): Promise<boolean> {
    const at = await this.find(id, undefined, true)
    if (!at) return false
    const item = this.archiveItems(at[0])[at[1]]!
    const before = canonical(item)
    if (count) setComments(item, { feedUrl, count, total })
    else this.withComments(item, undefined, true)
    if (canonical(item) != before) this.changed.add(at[0])
    return true
  }

  private nowIso = () => new Date(this.host.now()).toISOString().slice(0, 19) + 'Z'

  /**
   * Adds an item, or replaces the one it names: by `_archive.index`, or by id if the feed file or the newest archive
   * has it (a repeated request). An item with an index that no item has any more is refused with `missing` (404 or
   * 409).
   */
  async put(input: unknown, missing = 404): Promise<PutResult> {
    const item = checkItem(input)
    const id = itemId(item)!
    const index = itemIndex(item)
    const at = await this.find(id, index)
    if (!at && index != undefined)
      throw new FeedError(missing, missing == 404 ? 'not_found' : 'conflict', `The feed has no item "${id}" with the index ${index}; it may have been deleted`)
    if (at) {
      const changed = await this.replace(at[0], at[1], item)
      return { item: this.archiveItems(at[0])[at[1]]!, address: this.address(at[0], id), created: false, changed }
    }
    if (typeof item.date_published != 'string') item.date_published = this.nowIso()
    setIndex(item, this.next++)
    await this.withPostUrl(item)
    this.withComments(item, undefined)
    if (this.newest != undefined && ((await this.newestArchive()).items as Item[]).length < this.size) {
      this.archiveItems(this.newest).unshift(item)
      this.changed.add(this.newest)
    } else await this.create(this.newest == undefined ? 0 : this.newest + 1, [item])
    return { item, address: this.address(this.newest!, id), created: true, changed: true }
  }

  /**
   * Replaces the item at a position with `item`, which keeps the old index and, if it has none, the old
   * `date_published`. Sets `date_modified` unless the app changed it. Returns whether the item changed.
   */
  private async replace(n: number, p: number, item: Item): Promise<boolean> {
    const old = this.archiveItems(n)[p]!
    item.id = old.id!
    setIndex(item, itemIndex(old))
    if (typeof old.date_published == 'string' && typeof item.date_published != 'string') item.date_published = old.date_published
    await this.withPostUrl(item)
    this.withComments(item, old)
    const probe = { ...item }
    if (probe.date_modified == undefined && old.date_modified != undefined) probe.date_modified = old.date_modified
    if (canonical(probe) == canonical(old)) return false
    if ((item.date_modified ?? null) === (old.date_modified ?? null)) item.date_modified = this.nowIso()
    this.archiveItems(n)[p] = item
    this.changed.add(n)
    return true
  }

  /** Deletes an item, found by its index or, without one, in all archives. Undefined if there is no such item. */
  async delete(id: string, index: number | undefined): Promise<{ item: Item; address: string } | undefined> {
    const at = await this.find(id, index, true)
    if (!at) return
    const [item] = this.archiveItems(at[0]).splice(at[1], 1)
    this.changed.add(at[0])
    const i = itemIndex(item)
    if (i != undefined) this.dropped.push(i)
    return { item: item!, address: this.address(at[0], id) }
  }

  /** Replaces the owner's fields of the feed file with those of `body` (RFC-7 "Fields"). */
  setFields(body: JsonObject) {
    const doc: JsonObject = {}
    for (const [k, v] of Object.entries(body))
      if (!MANAGED_FIELDS.includes(k)) doc[k] = v
    for (const k of ['_archive', 'next_url'])
      if (this.doc[k] != undefined) doc[k] = this.doc[k]!
    this.doc = doc
  }

  /** Applies a feed file that an app PUT: its items are compared with those of the stored feed file. */
  async apply(body: JsonObject) {
    if (!Array.isArray(body.items)) throw new FeedError(400, 'invalid_request', 'items must be an array')
    const before = new Map(this.window.map(item => [itemId(item)!, item]))
    const seen = new Set<string>()
    const put: Json[] = []
    for (const item of body.items) {
      const id = itemId(item)
      if (id != undefined && seen.has(id)) throw new FeedError(400, 'invalid_request', `Two items have the id "${id}"`)
      if (id != undefined) seen.add(id)
      if (id == undefined || !before.has(id) || canonical(item) != canonical(before.get(id))) put.push(item)
    }
    const comments = () => `${this.ownsComments()} ${this.commentsOpen()}`
    const was = comments()
    this.setFields(body)
    if (comments() != was) this.refresh = true
    // Items the app removed from the feed file are deleted.
    for (const [id, item] of before)
      if (!seen.has(id)) await this.delete(id, itemIndex(item))
    // The oldest first, so that new items get their indexes in the order of the feed.
    for (const item of put.reverse()) await this.put(item, 409)
  }

  /** The feed file as it is written: the fixed fields, the archive fields, and the newest items. */
  private async feedFile(): Promise<JsonObject> {
    const d: JsonObject = { version: JSON_FEED_VERSION }
    for (const [k, v] of Object.entries(this.doc))
      if (!['version', 'items', 'author', 'next_url', '_archive'].includes(k)) d[k] = v
    if (isObject(this.doc.author) && d.authors == undefined) d.authors = [this.doc.author]
    d.home_page_url = this.host.me
    d.feed_url = this.host.publicUrl(this.path)
    d.user_comment = FEED_COMMENT
    const pups: JsonObject = { about: FEED_SPEC }
    if (isObject(d._pups))
      for (const [k, v] of Object.entries(d._pups)) if (k != 'about') pups[k] = v
    if (!('pupsControlled' in pups)) pups.pupsControlled = true
    d._pups = pups
    const archive: JsonObject = isObject(this.doc._archive) ? { ...this.doc._archive } : {}
    delete archive.updates_url
    delete archive.number
    delete archive.next_index
    const items: Item[] = []
    if (this.newest == undefined) {
      if (this.oldChain != undefined) d.next_url = this.oldChain
      if (this.next) archive.next_index = this.next
    } else {
      archive.archive_url = this.archiveUrl(this.newest)
      archive.archive_template = this.archiveUrl(0).replace('000000.json', '{number}.json')
      archive.archive_size = this.size
      for (let n = this.newest; n >= 0 && items.length < FEED_ITEMS; n--)
        for (const item of (await this.archive(n))?.items as Item[] ?? [])
          if (items.length < FEED_ITEMS) items.push(item)
    }
    if (Object.keys(archive).length) d._archive = withAbout(ARCHIVE_SPEC, archive)
    d.items = items
    return d
  }

  /** The changed archives, from the oldest to the newest, and then the feed file: the server writes them in this order. */
  async commit(): Promise<Committed> {
    if (this.refresh) await this.refreshComments()
    this.refresh = false
    const files: { path: string; text: string }[] = []
    const updates = this.host.publicUrl(this.path)
    for (const n of [...this.changed].sort((a, b) => a - b)) {
      const a = this.archives.get(n)!
      const fields: JsonObject = isObject(a._archive) ? { ...a._archive } : {}
      delete fields.next_index
      const archive: JsonObject = { about: ARCHIVE_SPEC, updates_url: updates, number: n }
      for (const [k, v] of Object.entries(fields)) if (!(k in archive)) archive[k] = v
      if (n == this.newest) archive.next_index = this.next
      a._archive = archive
      files.push({ path: archivePath(this.path, n), text: JSON.stringify(a, null, 4) })
    }
    const text = JSON.stringify(await this.feedFile(), null, 4)
    files.push({ path: this.path, text })
    this.changed.clear()
    // A deleted post's comments go with it.
    const deletes = this.dropped.map(index => commentFeedPath(this.path, index))
    this.dropped = []
    return { files, deletes, text }
  }
}

/** `{ about, ...fields }` without a second `about`. */
function withAbout(about: string, fields: JsonObject): JsonObject {
  const out: JsonObject = { about }
  for (const [k, v] of Object.entries(fields)) if (k != 'about') out[k] = v
  return out
}

// --- The requests of RFC-7 ---------------------------------------------------------------------

/**
 * PUT of a kept feed file (RFC-7 "Writing the feed file"), after the server checked the preconditions, under its
 * lock: applies the body to the stored feed file (if any) and its archives.
 */
export async function putKeptFeed(host: FeedHost, path: string, text: string, storedText: string | undefined): Promise<Committed> {
  const body = parseJsonFeed(text)
  if (!body) throw new FeedError(400, 'invalid_request', 'A feed file with the _pups marker must be a JSON Feed (RFC-7)')
  const feed = await KeptFeed.open(host, path, parseJsonFeed(storedText))
  await feed.apply(body)
  return feed.commit()
}

/** Checks the body of a POST to a feed file (RFC-7 "Posting items") and returns the item. Throws 415 and 400. */
export function readItem(contentType: string | null, text: string): JsonObject {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  if (type != 'application/json' && type != 'application/feed+json') throw new FeedError(415, 'unsupported_type', 'An item is sent as application/json')
  let item: unknown
  try {
    item = JSON.parse(text)
  } catch {
    item = undefined
  }
  if (!isObject(item)) throw new FeedError(400, 'invalid_request', 'The body must be a JSON Feed item')
  return item
}

export interface PostResult {
  status: number
  body: JsonObject
  headers: Record<string, string>
  /** What to write, if anything changed. */
  committed?: Committed
  /** For the log. */
  event: 'item.created' | 'item.replaced' | 'item.unchanged' | 'item.deleted'
  id: string
}

/**
 * POST of an item to a kept feed file (RFC-7 "Posting items"), under the server's lock: adds the item, replaces the
 * one it names, or, with `"_pups": { "delete": true }`, deletes it. Answers with the item as stored (or deleted) and
 * its address; a new item gets 201 and its address as Location.
 */
export async function postItem(host: FeedHost, path: string, item: JsonObject, storedText: string | undefined): Promise<PostResult> {
  const stored = parseJsonFeed(storedText)
  if (!stored) throw new FeedError(404, 'not_found', `There is no feed at ${path}`)
  if (!isKept(stored))
    throw new FeedError(409, 'not_pups_controlled', `${path} has no "_pups": { "pupsControlled": true }, so this server doesn't keep it (RFC-7)`)
  const feed = await KeptFeed.open(host, path, stored)
  if (isObject(item._pups) && item._pups.delete === true) {
    const id = itemId(item)
    if (id == undefined) throw new FeedError(400, 'invalid_request', 'A delete names the item by its id')
    const deleted = await feed.delete(id, itemIndex(item))
    if (!deleted) throw new FeedError(404, 'not_found', `The feed has no item "${id}"`)
    return { status: 200, body: { ...deleted }, headers: {}, committed: await feed.commit(), event: 'item.deleted', id }
  }
  const r = await feed.put(item)
  return {
    status: r.created ? 201 : 200, body: { item: r.item, address: r.address }, headers: r.created ? { Location: r.address } : {},
    ...r.changed && { committed: await feed.commit() },
    event: r.created ? 'item.created' : r.changed ? 'item.replaced' : 'item.unchanged', id: itemId(r.item)!,
  }
}
