import { sanitizeText } from 'pups-ui'
import { visibleText } from './content'
import { type InboxItem, SOURCE_ABOUT } from './inbox'

/**
 * Publishing approved comments (RFC-7 "Publishing comments", RFC-4 `republish: "full"` or `"summary"`): the comment as it is republished,
 * from its inbox item. The comment feeds themselves are the server's (pups-feeds `commentFeeds()`), reached through
 * `Receiver.commentFeeds`.
 */

/**
 * The comment feeds of the owner's kept feeds, by the URLs of the posts and comments that comments answer. Methods that
 * refuse throw errors with an HTTP `status` and a `code`, e.g. pups-feeds' FeedError.
 */
export interface CommentFeeds {
  /** Whether comments on `target` can be published: it is a post of a kept feed, or a comment published in one of its comment feeds. */
  isPublishable(target: string): Promise<boolean>
  /** Whether a URL is in a comment feed: comments on it would be replies to comments. */
  isCommentFeed(url: string): boolean
  /**
   * For a reply to the published comment `target`: its depth (2 for a reply to a comment on a post), the `_submissions`
   * of the post's feed, and whether the post takes comments. Undefined if the comment isn't published.
   */
  reply(target: string): Promise<{ depth: number; submissions?: Record<string, any>; open: boolean } | undefined>
  /** The title and URL of the post that `target`, a post or a comment in its thread, belongs to. */
  post(target: string): Promise<{ title?: string; url?: string } | undefined>
  /** The comment `id` as published in answer to `target`, and its address. */
  published(target: string, id: string): Promise<{ item: Record<string, any>; address: string } | undefined>
  /**
   * Publishes or replaces a comment in answer to `target`, under the feed's lock; returns its address. `build` makes the
   * comment for the feed's current `republish`; a feed that doesn't publish comments (this deep) anymore is refused.
   */
  publish(target: string, build: (republish: 'full' | 'summary') => Record<string, any>): Promise<string>
  /** Removes a published comment, with its replies, from those on `target`. Returns whether it was there. */
  unpublish(target: string, id: string): Promise<boolean>
}

/** The values of RFC-4 `republish` under which approved comments are published. */
export const PUBLISHING = ['full', 'summary']
/** An abstract (`republish: "summary"`) has at most this many characters. */
const SUMMARY_CHARS = 150

/** An error with an HTTP status, as CommentFeeds throws them. */
export const refusal = (e: unknown): { status: number; code: string; message: string } | undefined =>
  e instanceof Error && typeof (e as any).status == 'number'
    ? { status: (e as any).status, code: typeof (e as any).code == 'string' ? (e as any).code : 'conflict', message: e.message } : undefined

/**
 * The comment as republished (RFC-4 "What is republished"), from its inbox item: the title, the content as the inbox
 * keeps it (RFC-5 Comment HTML) and the Markdown it came from, the author's name, link and verified account, its date, and `_source.inReplyTo`. Its id is the guid of the
 * submission. With `republish: "summary"` (`mode`, by default what the author agreed to), the content is an abstract: the
 * plain text, cut off after 150 characters, as `content_text`; `url` links to the full text.
 */
export function commentItem(item: InboxItem, mode?: string): Record<string, any> {
  const all = String(item.content_html ?? '')
  const cut = all.indexOf('<p class="without-extension-actions">')
  const html = cut < 0 ? all : all.slice(0, cut)
  const summary = (mode ?? item._pups?.republish ?? 'full') == 'summary'
  const account = item._source?.accounts?.socialspec
  const markdown = summary ? undefined : item._source?.markdown
  return JSON.parse(JSON.stringify({
    id: item.id,
    url: item.url,
    title: item.title,
    content_html: summary ? undefined : html,
    content_text: summary ? sanitizeText(visibleText(html), SUMMARY_CHARS) ?? '' : undefined,
    date_published: item._inbox?.postDate ?? item.date_published,
    authors: item.authors,
    _source: { about: SOURCE_ABOUT, inReplyTo: item._inbox?.target, ...account && { accounts: { socialspec: account } }, ...markdown != undefined && { markdown } },
  }))
}

/** A JSON value with the keys of every object sorted, for comparing comments. */
const canonical = (v: unknown): string => {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v && typeof v == 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort((v as any)[k])])) : v
  return JSON.stringify(sort(v))
}

/** Whether a comment as it would be republished from `item` is the published one, apart from its dates and replies. */
export function isSameComment(item: InboxItem, published: Record<string, any>): boolean {
  const strip = (c: Record<string, any>) => {
    const { date_published: _p, date_modified: _m, ...rest } = JSON.parse(JSON.stringify(c))
    if (rest._source) {
      delete rest._source.comments
      if (Object.keys(rest._source).every(k => k == 'about')) delete rest._source
    }
    return canonical(rest)
  }
  return strip(commentItem(item)) == strip(published)
}
