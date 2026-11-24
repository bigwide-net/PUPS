import { escapeHtml as h, isCleanUrlString, sanitizeText, visible } from 'pups-ui'
import { plainText, textHtml } from './content'
import { type Post, urlHost } from './feeds'
import { type ModerationRating, moderationNote } from './moderation'

/**
 * The owner's inbox (RFC-12): a private JSON Feed at /pups/private/inbox.json with the mentions (RFC-11) and the
 * comments waiting for the owner (RFC-4). This server writes it as `pups`, with conditional writes. Every item has a
 * Dismiss action (RFC-9) with a capability URL, and a link to a confirmation page for readers without actions
 * (RFC-8). Comments on feeds that republish them (RFC-4 `republish: "full"`) also have an Approve action, which
 * publishes them in the post's comment feed (comments.ts).
 */

export const INBOX_PATH = '/pups/private/inbox.json'
export const INBOX_WRITER = 'pups'
const INBOX_ABOUT = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-12-Inbox-Feeds.md'
const ACTIONS_ABOUT = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-9-Feed-Actions.md'
export const SOURCE_ABOUT = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-1-Source-for-JSON-Feeds.md'
/** Mentions are kept this long (RFC-12 "Size"). Submissions stay until dismissed. */
export const MENTION_KEEP_MS = 30 * 24 * 3600_000
/**
 * The inbox holds at most this many items. A new item pushes out the oldest mention; waiting comments are never
 * dropped, so with only comments left, new items are refused.
 */
export const MAX_INBOX_ITEMS = 100
/** At most this many items from one source host, so that no site can fill the inbox. */
export const MAX_ITEMS_PER_HOST = 10
const EXCERPT_CHARS = 500
const MAX_ATTEMPTS = 5

export type ItemType = 'mention' | 'reply' | 'submission'
export type InboxItem = Record<string, any>
export type InboxFeed = Record<string, any> & { items: InboxItem[] }

/** The inbox is written by another system, or isn't an inbox (RFC-12 "One writer"). */
export class ForeignInbox extends Error {}

/** There is no room for a new item (MAX_INBOX_ITEMS, MAX_ITEMS_PER_HOST). */
export class InboxFull extends Error {}

/** The inbox file in storage, with conditional writes. */
export interface InboxStore {
  /** The file and a version for write(), or text undefined if there is none. */
  read(): Promise<{ text?: string; version?: string }>
  /** Writes the file if it is still at `version` (undefined: if it doesn't exist). False if it changed. */
  write(text: string, version: string | undefined): Promise<boolean>
}

/** What the inbox needs to know about the installation. */
export interface InboxContext {
  /** Origin of this server's endpoints, e.g. `https://tim.example.com`. */
  base: string
  mentions: boolean
  comments: boolean
  maxUploadBytes: number
  /** The capability key of the inbox actions (inboxKey()). */
  key: string
  now(): number
  inbox: InboxStore
}

const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** The capability key of the inbox actions, from the server's secret. Only the owner's apps can read the inbox, and so the key. */
export async function inboxKey(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('inbox-actions')))
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 32)
}

/** Compares a key from a request with the inbox key in constant time. */
export function isInboxKey(c: InboxContext, key: unknown): boolean {
  if (typeof key != 'string' || key.length != c.key.length) return false
  let diff = 0
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ c.key.charCodeAt(i)
  return !diff
}

/** The page where readers without actions dismiss or approve an item (RFC-8 fallback). */
export const dismissPageUrl = (c: InboxContext, id: string, action: 'dismiss' | 'approve' = 'dismiss') =>
  `${c.base}/pups/inbox/${action}?id=${encodeURIComponent(id)}&key=${c.key}`

/** Whether an inbox item has the Approve action: a comment that the owner can publish. */
export const isApprovable = (item: InboxItem) => Array.isArray(item._actions?.actions) && item._actions.actions.some((a: any) => a?.template == 'approve')

/** The host of an item's source, for the limit per host. */
const itemSourceHost = (item: InboxItem) => typeof item._inbox?.source == 'string' ? urlHost(item._inbox.source) : undefined
const isSubmission = (item: InboxItem) => item._inbox?.type == 'submission'

function dropOldestMention(items: InboxItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--)
    if (!isSubmission(items[i]!)) {
      items.splice(i, 1)
      return true
    }
  return false
}

/** Makes room for a new item from `host`, or throws InboxFull. Drops the oldest mention if the inbox is full; items are newest first. */
function makeRoom(items: InboxItem[], host: string | undefined) {
  if (items.filter(i => itemSourceHost(i) == host).length >= MAX_ITEMS_PER_HOST)
    throw new InboxFull(`The inbox already has ${MAX_ITEMS_PER_HOST} items from ${host}.`)
  while (items.length >= MAX_INBOX_ITEMS)
    if (!dropOldestMention(items)) throw new InboxFull(`The inbox is full: ${MAX_INBOX_ITEMS} comments are waiting.`)
}

/** Newest first; mentions older than 30 days are dropped. */
function pruneInbox(c: InboxContext, items: InboxItem[]): InboxItem[] {
  const cutoff = iso(c.now() - MENTION_KEEP_MS)
  return items.toSorted((a, b) => String(b.date_published ?? '').localeCompare(String(a.date_published ?? '')))
    .filter(i => isSubmission(i) || String(i.date_published ?? '') >= cutoff)
}

/** The feed without items: what this server writes on every change. */
function newInbox(c: InboxContext): InboxFeed {
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: 'Inbox',
    home_page_url: `${c.base}/pups/apps`,
    _inbox: { about: INBOX_ABOUT, writer: INBOX_WRITER, categories: [...c.mentions ? ['mentions'] : [], ...c.comments ? ['moderation'] : []] },
    _actions: {
      about: ACTIONS_ABOUT, templates: {
        approve: { type: 'button', label: 'Publish Comment', style: 'major', action: `${c.base}/pups/inbox/action?do=approve&id={id}&key=${c.key}` },
        dismiss: { type: 'button', label: 'Dismiss', action: `${c.base}/pups/inbox/action?id={id}&key=${c.key}` },
      },
    },
    items: [],
  }
}

function parseInbox(c: InboxContext, text: string | undefined): InboxFeed {
  if (text == undefined) return newInbox(c)
  let feed: any
  try {
    feed = JSON.parse(text)
  } catch {}
  if (feed?._inbox?.writer !== INBOX_WRITER || !Array.isArray(feed?.items)) {
    const writer = typeof feed?._inbox?.writer == 'string' ? feed._inbox.writer : undefined
    throw new ForeignInbox(writer == undefined ? `The file ${INBOX_PATH} isn't an inbox that this server wrote`
      : `The inbox is managed by ${visible(writer)}. Delete ${INBOX_PATH} to let this server write it.`)
  }
  return feed
}

/** The inbox's items, or [] if there is none. Throws ForeignInbox. */
export async function inboxItems(c: InboxContext): Promise<InboxItem[]> {
  return parseInbox(c, (await c.inbox.read()).text).items
}

export async function findInboxItem(c: InboxContext, id: string): Promise<InboxItem | undefined> {
  return (await inboxItems(c)).find(i => i.id === id)
}

/**
 * Changes the inbox's items with a conditional write: `fn(items)` changes them in place and returns whether it did.
 * Creates the inbox, sorts the items newest first, drops old mentions, and keeps the file below max_upload_bytes.
 * If the file changed in between, it is reread and `fn` runs again. Throws ForeignInbox.
 */
export async function modifyInbox(c: InboxContext, fn: (items: InboxItem[]) => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { text, version } = await c.inbox.read()
    const feed = parseInbox(c, text)
    const items = feed.items
    if (!fn(items)) return false
    const out: InboxFeed = { ...feed, ...newInbox(c), items: pruneInbox(c, items) }
    let json = JSON.stringify(out, null, 2)
    while (new TextEncoder().encode(json).length > c.maxUploadBytes && dropOldestMention(out.items)) json = JSON.stringify(out, null, 2)
    if (await c.inbox.write(json, version)) return true
  }
  throw new Error('The inbox changed concurrently; try again')
}

/** Adds an item, or replaces the one with the same id; a replaced item keeps its arrival date. Throws InboxFull if there is no room. */
export function putInboxItem(c: InboxContext, item: InboxItem): Promise<boolean> {
  return modifyInbox(c, items => {
    const i = items.findIndex(old => old.id === item.id)
    if (i >= 0) {
      const merged = { ...item, date_published: items[i]!.date_published ?? item.date_published }
      if (JSON.stringify(items[i]) == JSON.stringify(merged)) return false
      items[i] = merged
      return true
    }
    const kept = pruneInbox(c, items)
    makeRoom(kept, itemSourceHost(item))
    items.splice(0, items.length, ...kept, item)
    return true
  })
}

/** Removes an item. Returns whether there was one. */
export function removeInboxItem(c: InboxContext, id: string): Promise<boolean> {
  return modifyInbox(c, items => {
    const i = items.findIndex(x => x.id === id)
    if (i < 0) return false
    items.splice(i, 1)
    return true
  })
}

/** Throws InboxFull if a new submission from `host` would be refused; `id` may be an edit of an item that exists. */
export async function checkRoomForSubmission(c: InboxContext, id: string, host: string | undefined) {
  const items = await inboxItems(c)
  if (items.some(i => i.id === id)) return
  makeRoom(items.filter(i => isSubmission(i) || itemSourceHost(i) == host), host)
}

/**
 * Where an item comes from, for its action area: "Mention from @bob.example.", with the account if one was verified,
 * else the host of the source. It links to the source.
 */
const originText = (type: ItemType, source: string, account: string | undefined, edit = false, toComment = false) => {
  const noun = toComment ? 'reply' : 'comment'
  return `${{ submission: edit ? `Edited ${noun}` : toComment ? 'Reply' : 'Comment', reply: 'Reply', mention: 'Mention' }[type]} from ${account ?? urlHost(source)}.`
}

/**
 * An inbox item. `content` is the post's HTML for the inbox. The account is included only as attribution() verified it.
 * A comment that the owner can publish gets Publish Comment (template `approve`) after the link to its origin, next to Dismiss, and `_pups.republish`:
 * `publish`, the feed's `republish` (`full` or `summary`) that its author agreed to. `edit` says that an earlier version
 * is published already.
 */
export function inboxItem(c: InboxContext, id: string, type: ItemType, source: string, target: string, post: Partial<Post>,
  content: string, author: string | undefined, account: string | undefined, publish?: string, edit = false, toComment = false): InboxItem {
  const approve = publish != undefined
  const url = post.url
  const text = originText(type, source, account, edit, toComment)
  const link = (action: 'dismiss' | 'approve', label: string) =>
    `<p class="without-extension-actions"><a href="${h(dismissPageUrl(c, id, action))}">${label}</a></p>`
  const from = `<p class="without-extension-actions"><a href="${h(source)}">${h(text)}</a></p>`
  const fallback = from + (approve ? link('approve', 'Publish Comment') : '') + link('dismiss', 'Dismiss')
  const origin = { type: 'display', text, url: source, group: 'origin' }
  const name = sanitizeText(author, 100)
  const title = sanitizeText(post.title, 200)
  return {
    id,
    ...typeof url == 'string' && /^https?:\/\//i.test(url) && isCleanUrlString(url) && { url },
    ...title && { title },
    content_html: content + fallback,
    date_published: iso(c.now()),
    ...name && { authors: [{ name }] },
    ...account && { _source: { about: SOURCE_ABOUT, accounts: { socialspec: account } } },
    _inbox: { about: INBOX_ABOUT, type, source, target, ...post.date && { postDate: post.date } },
    ...approve && { _pups: { republish: publish } },
    _actions: {
      about: ACTIONS_ABOUT,
      actions: approve ? [origin, { template: 'approve', group: 'decide' }, { template: 'dismiss', group: 'decide' }] : [origin, { template: 'dismiss', group: 'dismiss' }],
    },
  }
}

/** Adds the rating of auto-moderation (moderation.ts) to an inbox item, shown next to the link to its origin. */
export function withModerationNote(item: InboxItem, rating: ModerationRating) {
  const note = moderationNote(rating)
  item._pups = { ...item._pups, moderation: rating }
  item._actions.actions.splice(1, 0, { type: 'display', text: note, group: 'origin' })
  item.content_html += `<p class="without-extension-actions"><small>${h(note)}</small></p>`
}

/** A short excerpt of a post for a mention: its plain text, at most 500 characters. */
export const excerptHtml = (post: Post) => textHtml(sanitizeText(plainText(post), EXCERPT_CHARS) ?? '')
