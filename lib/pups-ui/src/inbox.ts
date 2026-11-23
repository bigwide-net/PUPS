import { alert, escapeHtml as h, page, status } from './html'
import { visible } from './sanitize'

/**
 * Pages of the built-in receiver (pups-inbox): the confirmation pages that the Dismiss and Approve links of an inbox
 * item open (RFC-8 fallback, RFC-9), and the inbox section of the apps page.
 */

export const INBOX_PATH = '/pups/private/inbox.json'

export interface DismissItem {
  id: string
  key: string
  what: 'comment' | 'reply' | 'mention'
  author?: string
  account?: string
  source: string
  title?: string
  /** Plain text. */
  excerpt: string
  /** What the button does: Dismiss (the default), or Approve and publish a comment. */
  action?: 'dismiss' | 'approve'
}

/** The page with the Dismiss or Approve button. Following the link alone does nothing. */
export function dismissConfirmPage(site: string, i: DismissItem): Response {
  const [verb, question] = i.action == 'approve' ? ['Approve', `Approve and publish this ${i.what}?`] : ['Dismiss', `Dismiss this ${i.what}?`]
  return page(question, `<h1>${h(question)}</h1>
<p>${i.author ? `From <strong>${h(visible(i.author))}</strong>${i.account ? ` (${h(visible(i.account))})` : ''}, ` : ''}source <code>${h(visible(i.source))}</code></p>
${i.title ? `<p><strong>${h(visible(i.title))}</strong></p>` : ''}
<blockquote>${h(i.excerpt)}</blockquote>
<form method="post">
<input type="hidden" name="id" value="${h(i.id)}">
<input type="hidden" name="key" value="${h(i.key)}">
<p><button type="submit">${verb}</button></p>
</form>`, { site })
}

export const dismissedPage = (site: string, message: string, title = 'Dismissed') => page(title, `<h1>${title}</h1>\n${status(message)}`, { site })

/** After Approve: the comment is published at `url`. */
export const approvedPage = (site: string, url: string) =>
  page('Approved', `<h1>Approved</h1>\n${status('The comment is published.')}\n<p><a href="${h(url)}">${h(visible(url))}</a></p>`, { site })

/** What the receiver has put into the inbox. */
export interface InboxSummary {
  ownerHost: string
  mentionsOn: boolean
  commentsOn: boolean
  mentions: number
  comments: number
  /** Webmentions still waiting to be checked. */
  queued: number
  maxItems: number
  maxPerHost: number
  /** Another system writes the inbox. */
  error?: string
}

/** The inbox section of the apps page: the owner reads the inbox in their feed reader (RFC-12). */
export function inboxSection(o: InboxSummary): string {
  const counts = [o.mentionsOn ? `${o.mentions} mentions and replies` : '', o.commentsOn ? `${o.comments} comments waiting for you` : '']
    .filter(Boolean).join(', ')
  const state = o.error ? alert(o.error)
    : `<p>${counts} (at most ${o.maxItems} items, ${o.maxPerHost} per site).${o.queued ? ` ${o.queued} webmentions are still being checked.` : ''}</p>`
  const what = [o.mentionsOn ? `mentions of <strong>@${h(o.ownerHost)}</strong>` : '', o.commentsOn ? 'comments on your feeds' : ''].filter(Boolean).join(' and ')
  return `<section aria-labelledby="inbox-heading">
<h2 id="inbox-heading">Inbox</h2>
<p>This server receives ${what} and puts them into your private inbox, <code>${INBOX_PATH}</code>.
Your feed reader shows it, if it supports inboxes and you allow it to read non-public content.</p>
${state}
</section>`
}
