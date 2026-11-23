import type { ChildNode, Document, Element } from 'domhandler'
import { findAll, findOne, getInnerHTML, textContent } from 'domutils'
import { parseDocument } from 'htmlparser2'
import { asciiHost, isElement, normalizeSpace, wellFormed } from './content'

/**
 * Reading the posts that mentions and comments point to: fetching them with limits, parsing JSON Feed, RSS 2.0 and
 * HTML pages (h-entry) into one shape, and finding an item by its id, also in archive pages (RFC-4 "Archived items",
 * RFC-11 "Fetching the source"). The owner's own feeds are read from storage, not over HTTP.
 */

export const FEED_MAX_BYTES = 1024 * 1024
export const FEED_TIMEOUT_MS = 10_000
export const MAX_REDIRECTS = 3
/** Pages of a feed searched for an item, the feed itself included (RFC-4 asks for at least 10). */
export const MAX_PAGES = 11
const NS_SOURCE = 'http://source.scripting.com/'
const NS_RM = ['https://rssmention.bigwide.net/', 'http://rssmention.bigwide.net/']
const NS_ATOM = 'http://www.w3.org/2005/Atom'
const NS_DC = 'http://purl.org/dc/elements/1.1/'
const NS_CONTENT = 'http://purl.org/rss/1.0/modules/content/'

/** An item of a feed, or the post of an HTML page. */
export interface Post {
  id?: string
  url?: string
  title?: string
  html?: string
  text?: string
  markdown?: string
  author?: string
  account?: string
  inReplyTo?: string
  /** ISO 8601 in UTC. */
  date?: string
  allowComments: boolean
  /** HTML pages: the reply links first, then every other link of the post. */
  links: string[]
}

export interface Feed {
  /** After redirects. */
  url: string
  title?: string
  account?: string
  submissions?: Record<string, any>
  next?: string
  /** The feed file of an RFC-13 archive. */
  updates?: string
  /** An HTML page with one post. */
  page: boolean
  items: Post[]
}

/** A document that can't be read. `gone`: it answered 404 or 410. */
export class FetchError extends Error {
  constructor(message: string, public gone = false) {
    super(message)
  }
}

/** Where feeds come from: the owner's storage for the owner's files, the network for everything else. */
export interface FeedSource {
  /** The storage path of a URL that this server serves publicly, or undefined. Private files never count. */
  ownerPath(url: string): string | undefined
  /** A stored file of the owner as text, or undefined if it doesn't exist. */
  readOwnerFile(path: string): Promise<string | undefined>
  /** The plain fetch. Redirects, limits and timeouts are handled here. */
  fetch: typeof fetch
  /** URLs this server must never fetch: its own receiving endpoints. */
  isOwnEndpoint(url: string): boolean
  /** Throws if a URL must not be fetched, e.g. because its host resolves to a private address (SSRF). */
  checkUrl?(url: string): Promise<void>
}

/** Splits `feed URL#id` into the URL and the decoded id (undefined without a fragment). */
export function splitRef(ref: string): [string, string | undefined] {
  const i = ref.indexOf('#')
  if (i < 0 || i == ref.length - 1) return [i < 0 ? ref : ref.slice(0, i), undefined]
  let id = ref.slice(i + 1)
  try {
    id = decodeURIComponent(id)
  } catch {}
  return [ref.slice(0, i), id]
}

/** Do two references name the same item? The fragments are compared decoded (RFC-4). */
export function sameRef(a: string | undefined, b: string | undefined): boolean {
  if (a == undefined || b == undefined) return false
  const [x, y] = [splitRef(a), splitRef(b)]
  return x[0] == y[0] && x[1] == y[1]
}

export function urlHost(url: string): string | undefined {
  try {
    return asciiHost(new URL(url).hostname.replace(/^\[|\]$/g, ''))
  } catch {
    return undefined
  }
}

/** Resolves a URL from a document (a redirect, next_url) against the document's URL. */
export function resolveUrl(base: string, ref: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return ref
  try {
    return new URL(ref, base).href
  } catch {
    return ref
  }
}

/** Reads a body up to `max` bytes. Undefined if it is larger. */
export async function readLimited(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | undefined> {
  if (!body) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

const ACCEPT = 'application/feed+json, application/json, application/rss+xml, application/xml;q=0.9, text/html;q=0.8'

/** Fetches a document, following at most 3 redirects. */
export async function fetchDoc(src: FeedSource, url: string): Promise<{ url: string; contentType: string; body: string }> {
  for (let i = 0; ; i++) {
    if (!/^https?:\/\/[^/?#]+/i.test(url) || src.isOwnEndpoint(url)) throw new FetchError(`Refusing to fetch ${url}`)
    let res: Response
    try {
      await src.checkUrl?.(url)
      res = await src.fetch(url, { headers: { accept: ACCEPT }, redirect: 'manual', signal: AbortSignal.timeout(FEED_TIMEOUT_MS) })
    } catch (e) {
      throw new FetchError(`${url} could not be fetched: ${(e as Error).message}`)
    }
    const location = res.headers.get('location')
    if ([301, 302, 303, 307, 308].includes(res.status) && location) {
      await res.body?.cancel()
      if (i >= MAX_REDIRECTS) throw new FetchError(`${url} redirects more than ${MAX_REDIRECTS} times`)
      url = resolveUrl(url, location)
      continue
    }
    if (res.status != 200) {
      await res.body?.cancel()
      throw new FetchError(`${url} answered HTTP ${res.status}`, res.status == 404 || res.status == 410)
    }
    const bytes = await readLimited(res.body, FEED_MAX_BYTES).catch(e => {
      throw new FetchError(`${url} could not be read: ${(e as Error).message}`)
    })
    if (!bytes) throw new FetchError(`${url} is larger than ${FEED_MAX_BYTES} bytes`)
    return {
      url, contentType: (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase(),
      body: new TextDecoder().decode(bytes),
    }
  }
}

/** A feed or HTML page by URL: read from storage if this server serves it, else fetched. Throws FetchError. */
export async function loadFeed(src: FeedSource, url: string): Promise<Feed> {
  const path = src.ownerPath(url)
  let doc: { url: string; contentType: string; body: string }
  if (path != undefined) {
    const body = await src.readOwnerFile(path)
    if (body == undefined) throw new FetchError(`${url} doesn't exist`, true)
    doc = { url, contentType: '', body }
  } else doc = await fetchDoc(src, url)
  const feed = parseFeed(doc.body) ??
    (doc.contentType.includes('html') || /^\s*<(!doctype html|html)/i.test(doc.body) ? parseHtmlPage(doc.body) : undefined)
  if (!feed) throw new FetchError(`${url} is neither a JSON Feed, an RSS 2.0 feed nor an HTML page`)
  if (feed.page)
    for (const item of feed.items) {
      item.links = item.links.map(l => resolveUrl(doc.url, l))
      if (item.inReplyTo != undefined) item.inReplyTo = resolveUrl(doc.url, item.inReplyTo)
      item.url = item.url == undefined ? doc.url : resolveUrl(doc.url, item.url)
    }
  return { ...feed, url: doc.url }
}

export interface Found {
  /** The first page. */
  feed: Feed
  item?: Post
  /**
   * False if the search gave up early (a page limit, an error, another host, no fragment in a feed with several
   * items), so that a missing item isn't taken as deleted.
   */
  complete: boolean
}

/**
 * Finds the item that a reference (`feed URL#id`) names. Without a fragment, it is the only item of the feed, or the
 * post of an HTML page. Throws FetchError if the feed itself can't be read.
 */
export async function findItem(src: FeedSource, ref: string, maxPages = MAX_PAGES): Promise<Found> {
  const [url, id] = splitRef(ref)
  const first = await loadFeed(src, url)
  if (first.page || id == undefined)
    return { feed: first, item: first.page || first.items.length == 1 ? first.items[0] : undefined, complete: first.page || first.items.length <= 1 }
  let feed = first
  const seen = new Set([feed.url])
  for (let page = 1; ; page++) {
    const item = feed.items.find(i => i.id == id)
    if (item) return { feed: first, item, complete: true }
    if (feed.next == undefined) return { feed: first, complete: true }
    const next = resolveUrl(feed.url, feed.next)
    if (seen.has(next)) return { feed: first, complete: true }
    if (page >= maxPages || urlHost(next) != urlHost(url)) return { feed: first, complete: false }
    try {
      feed = await loadFeed(src, next)
    } catch (e) {
      if (e instanceof FetchError) return { feed: first, complete: false }
      throw e
    }
    seen.add(next).add(feed.url)
  }
}

/** An ISO 8601 date in UTC, or undefined. */
export function isoDate(date: string | undefined): string | undefined {
  const t = date == undefined ? NaN : Date.parse(date)
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Parses a JSON Feed or an RSS 2.0 feed. Undefined if it is neither. */
export function parseFeed(body: string): Omit<Feed, 'url'> | undefined {
  const t = body.replace(/^[﻿ \t\r\n]+/, '')
  if (t.startsWith('{')) {
    let j: any
    try {
      j = JSON.parse(t)
    } catch {
      return
    }
    return j && typeof j == 'object' && typeof j.version == 'string' && j.version.startsWith('https://jsonfeed.org/version/') ? jsonFeed(j) : undefined
  }
  return t.startsWith('<') && /<rss[\s>]/.test(t.slice(0, 4096)) ? rssFeed(t) : undefined
}

const str = (v: unknown) => typeof v == 'string' ? v : undefined
const obj = (v: unknown): Record<string, any> | undefined => v && typeof v == 'object' && !Array.isArray(v) ? v as Record<string, any> : undefined

function jsonFeed(j: Record<string, any>): Omit<Feed, 'url'> {
  const firstName = (authors: unknown) => Array.isArray(authors) ? str(obj(authors[0])?.name) : undefined
  const feedAuthor = firstName(j.authors) ?? str(obj(j.author)?.name)
  const items: Post[] = []
  for (const it of Array.isArray(j.items) ? j.items : []) {
    const id = obj(it)?.id
    if (typeof id != 'string' && !Number.isInteger(id)) continue
    const src = obj(it._source) ?? {}
    items.push({
      id: String(id), url: str(it.url), title: str(it.title), html: str(it.content_html), text: str(it.content_text), markdown: str(src.markdown),
      author: firstName(it.authors) ?? str(obj(it.author)?.name) ?? feedAuthor,
      account: str(obj(src.accounts)?.socialspec), inReplyTo: str(src.inReplyTo), date: isoDate(str(it.date_published)),
      allowComments: obj(it._commenting)?.allowComments !== false, links: [],
    })
  }
  // RFC-13 archive fields, or those of earlier drafts in _pups (RFC-13 "Earlier drafts").
  const archive = (k: string) => str(obj(j._archive)?.[k]) ?? str(obj(j._pups)?.[k])
  return {
    title: str(j.title), account: str(obj(obj(j._source)?.accounts)?.socialspec), submissions: obj(j._submissions),
    // Feed files point to their newest archive with _archive.archive_url; archives to their feed file with updates_url.
    next: str(j.next_url) ?? archive('archive_url'), updates: archive('updates_url'), page: false, items,
  }
}

// --- RSS ---------------------------------------------------------------------------------

/** The namespace of a prefix, from the xmlns declarations of the element and its ancestors. */
function namespaceOf(el: Element, prefix: string | undefined): string | undefined {
  const attr = prefix ? `xmlns:${prefix}` : 'xmlns'
  for (let e: Element | null = el; e; e = e.parent && isElement(e.parent as ChildNode) ? e.parent as Element : null)
    if (attr in e.attribs) return e.attribs[attr]
}

/** Is an element `local` in namespace `ns` (undefined: no namespace)? */
function isNamed(el: Element, ns: string | undefined, local: string): boolean {
  const i = el.name.indexOf(':')
  const [prefix, name] = i < 0 ? [undefined, el.name] : [el.name.slice(0, i), el.name.slice(i + 1)]
  return name == local && namespaceOf(el, prefix) == ns
}

const kids = (el: Element, ns: string | undefined, local: string) =>
  el.children.filter((c): c is Element => isElement(c) && isNamed(c, ns, local))
const kid = (el: Element, ns: string | undefined, local: string) => kids(el, ns, local)[0]
const text = (el: Element | undefined) => {
  const s = el ? textContent(el).trim() : ''
  return s || undefined
}

function rssAccount(el: Element): string | undefined {
  const a = kids(el, NS_SOURCE, 'account').find(a => a.attribs.service == 'socialspec')
  return a && textContent(a).trim()
}

function rssFeed(xml: string): Omit<Feed, 'url'> | undefined {
  // No DTDs: they are the way to entity expansion attacks, and RSS doesn't need them.
  if (/<!DOCTYPE/i.test(xml)) return
  const doc = parseDocument(wellFormed(xml), { xmlMode: true })
  const rss = doc.children.find((c): c is Element => isElement(c) && c.name == 'rss')
  const ch = rss && kid(rss, undefined, 'channel')
  if (!ch) return
  const next = kids(ch, NS_ATOM, 'link').find(l => l.attribs.rel == 'next')?.attribs.href?.trim() || undefined
  let submissions: Record<string, any> | undefined
  for (const ns of NS_RM) {
    const s = kid(ch, ns, 'submissions')
    if (s && !submissions) submissions = { url: text(kid(s, ns, 'url')) }
  }
  const items: Post[] = []
  for (const it of kids(ch, undefined, 'item')) {
    const id = text(kid(it, undefined, 'guid'))
    if (id == undefined) continue
    const closed = NS_RM.some(ns => {
      const c = kid(it, ns, 'commenting')
      return !!c && text(kid(c, ns, 'allowComments'))?.toLowerCase() == 'false'
    })
    items.push({
      id, url: text(kid(it, undefined, 'link')), title: text(kid(it, undefined, 'title')),
      html: text(kid(it, NS_CONTENT, 'encoded')) ?? text(kid(it, undefined, 'description')),
      markdown: text(kid(it, NS_SOURCE, 'markdown')),
      author: text(kid(it, NS_DC, 'creator')) ?? text(kid(it, undefined, 'author')),
      account: rssAccount(it), inReplyTo: text(kid(it, NS_SOURCE, 'inReplyTo')),
      date: isoDate(text(kid(it, undefined, 'pubDate'))), allowComments: !closed, links: [],
    })
  }
  return { title: text(kid(ch, undefined, 'title')), account: rssAccount(ch), submissions, next, page: false, items }
}

// --- HTML pages ----------------------------------------------------------------------------

const classes = (e: Element) => (e.attribs.class ?? '').trim().split(/\s+/).filter(Boolean)

/** The element itself or its first descendant with a class, in document order. */
const firstWithClass = (root: Element | Document, cls: string): Element | undefined =>
  (root.type != 'root' && classes(root as Element).includes(cls) ? root as Element : undefined) ??
    findOne(e => classes(e).includes(cls), root.children) ?? undefined

/**
 * An HTML page as a feed with one post: the first h-entry, with its text in e-content and its title in p-name;
 * without one, the body and the page title (RFC-11). `links` holds the reply links (u-in-reply-to, rel=in-reply-to)
 * first, then every other link of the post.
 */
export function parseHtmlPage(html: string): Omit<Feed, 'url'> {
  const doc = parseDocument(wellFormed(html))
  const body = findOne(e => e.name == 'body', doc.children) ?? doc
  const titleEl = findOne(e => e.name == 'title', doc.children)
  const pageTitle = titleEl ? normalizeSpace(textContent(titleEl)) : undefined
  const entry = firstWithClass(body, 'h-entry')
  const root = entry ?? body
  const txt = (e: Element | undefined) => e ? normalizeSpace(textContent(e)) || undefined : undefined
  const content = entry && firstWithClass(entry, 'e-content')
  const author = entry && firstWithClass(entry, 'p-author')
  const authorName = author ? txt(classes(author).includes('h-card') ? firstWithClass(author, 'p-name') : undefined) ?? txt(author) : undefined
  const url = entry && firstWithClass(entry, 'u-url')
  const reply: string[] = [], other: string[] = []
  for (const a of findAll(e => e.name == 'a', root.children)) {
    const href = (a.attribs.href ?? '').trim()
    if (!href) continue
    const isReply = classes(a).includes('u-in-reply-to') || (a.attribs.rel ?? '').toLowerCase().split(/\s+/).includes('in-reply-to')
    ;(isReply ? reply : other).push(href)
  }
  const item: Post = {
    url: url?.attribs.href || undefined,
    title: entry ? txt(firstWithClass(entry, 'p-name')) : pageTitle,
    html: getInnerHTML(content ?? root), author: authorName, inReplyTo: reply[0], allowComments: true,
    links: [...new Set([...reply, ...other])],
  }
  // A p-name that is the whole entry (an h-entry without e-content) is no title.
  if (entry && !content && item.title == txt(entry)) item.title = undefined
  return { title: pageTitle, page: true, items: root.children.length || root != doc ? [item] : [] }
}
