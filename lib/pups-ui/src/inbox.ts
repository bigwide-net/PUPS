import { alert, escapeHtml as h, page, status } from './html'
import { visible } from './sanitize'

/**
 * Pages of the built-in receiver (pups-inbox): the confirmation pages that the Dismiss, Publish Comment and Reject Comment
 * links of an inbox item open (RFC-8 fallback, RFC-9), the inbox section and auto-moderation (owner.ts puts them on its
 * pages).
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
  /** What the button does: Dismiss (the default), Publish Comment, or Reject Comment (of a comment that auto-moderation published). */
  action?: 'dismiss' | 'approve' | 'reject'
}

/** The page with the Dismiss, Publish Comment or Reject Comment button. Following the link alone does nothing. */
export function dismissConfirmPage(site: string, i: DismissItem): Response {
  const [verb, question] = i.action == 'approve' ? ['Publish Comment', `Publish this ${i.what}?`]
    : i.action == 'reject' ? ['Reject Comment', `Reject this ${i.what}?`] : ['Dismiss', `Dismiss this ${i.what}?`]
  return page(question, `<h1>${h(question)}</h1>
${i.action == 'reject' ? `<p>Auto-moderation published it. Rejecting removes it, and the replies to it, from your site, and tells its author that you rejected it.</p>\n` : ''}<p>${i.author ? `From <strong>${h(visible(i.author))}</strong>${i.account ? ` (${h(visible(i.account))})` : ''}, ` : ''}source <code>${h(visible(i.source))}</code></p>
${i.title ? `<p><strong>${h(visible(i.title))}</strong></p>` : ''}
<blockquote>${h(i.excerpt)}</blockquote>
<form method="post">
<input type="hidden" name="id" value="${h(i.id)}">
<input type="hidden" name="key" value="${h(i.key)}">
<p><button type="submit">${verb}</button></p>
</form>`, { site })
}

export const dismissedPage = (site: string, message: string, title = 'Dismissed') => page(title, `<h1>${title}</h1>\n${status(message)}`, { site })

/** After Publish Comment: the comment is published at `url`. */
export const approvedPage = (site: string, url: string) =>
  page('Comment published', `<h1>Comment published</h1>\n${status('The comment is published.')}\n<p><a href="${h(url)}">${h(visible(url))}</a></p>`, { site })

/** After Reject Comment; `removed` says whether the comment was still published. */
export const rejectedPage = (site: string, removed: boolean) =>
  page('Comment rejected', `<h1>Comment rejected</h1>\n${status(removed ? 'The comment was removed from your site.' : 'The comment was not published anymore.')}`, { site })

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

/** The settings of auto-moderation (pups-inbox's moderation.ts) on the comments page. */
export interface ModerationView {
  enabled: boolean
  /** The last four characters of the stored API key, if there is one. */
  keyEnding?: string
  endpoint: string
  model: string
  /** Numbers, or what a refused form said. */
  threshold: number | string
  minThreshold: number
  criteria: string
  criteriaChars: number
  dailyTokens: number | string
  maxDailyTokens: number
  /** Whether the comments that auto-moderation publishes go into the inbox. */
  notify: boolean
  /** Tokens used today (UTC). */
  usedToday: number
}

/** The auto-moderation section, inside the form of the comments page. */
export function moderationSection(o: ModerationView): string {
  const key = o.keyEnding == undefined ? 'e.g. sk-or-v1-…' : `Stored, ending in …${o.keyEnding}. Leave empty to keep it.`
  return `<section aria-labelledby="moderation-heading">
<h2 id="moderation-heading">Auto-moderation</h2>
<p>Comments wait in your inbox until you publish them. With auto-moderation, a language model rates each comment first, and publishes those that are likely acceptable at once.
You find all others in your inbox as before, with the rating, and, unless you turn it off, the published ones too, where you can reject them. The model checks for spam, scams, illegal and adult content, abuse and personal data, and for your own criteria.
The comments are sent to the API below, which usually charges for it. If it can't be reached, the comments go into your inbox.</p>
<label><input type="checkbox" name="moderation_enabled" value="1"${o.enabled ? ' checked' : ''}> Moderate comments automatically</label>
<label><input type="checkbox" name="moderation_notify" value="1"${o.notify ? ' checked' : ''}> Show the comments it publishes in my inbox, so that I can reject them</label>
<label>API key
<input type="password" name="moderation_key" autocomplete="off" spellcheck="false" placeholder="${h(key)}">
<small>Create a new key for this domain only, with a low spending limit (on OpenRouter: a credit limit for the key). It is stored on this server; should it ever leak, it can't cost you much, and you can revoke it without affecting anything else.</small></label>
${o.keyEnding == undefined ? '' : '<label><input type="checkbox" name="moderation_forget_key" value="1"> Forget the stored key</label>\n'}<label>API endpoint, OpenAI-compatible
<input type="url" name="moderation_endpoint" value="${h(o.endpoint)}"></label>
<label>Model
<input type="text" name="moderation_model" spellcheck="false" value="${h(o.model)}"></label>
<label>Publish at once if at least this likely acceptable, in percent
<input type="number" name="moderation_threshold" min="${o.minThreshold}" max="100" step="1" value="${h(String(o.threshold))}"></label>
<label>At most this many thousand tokens per day
<input type="number" name="moderation_daily_tokens" min="1" max="${o.maxDailyTokens}" step="1" value="${h(String(o.dailyTokens))}">
<small>Used today (UTC): ${o.usedToday.toLocaleString('en-US')} tokens. When they are used up, comments wait in your inbox until the next day.</small></label>
<label>Your criteria (optional)
<textarea name="moderation_criteria" rows="5" maxlength="${o.criteriaChars}" placeholder="e.g. Only comments in English or German. No election campaigning. Links to shops are fine.">${h(o.criteria)}</textarea></label>
</section>`
}

/** The inbox section of the apps and comments pages: the owner reads the inbox in their feed reader (RFC-12). */
export function inboxSection(o: InboxSummary): string {
  const counts = [o.mentionsOn ? `${o.mentions} mentions and replies` : '', o.commentsOn ? `${o.comments} comments waiting for you` : '']
    .filter(Boolean).join(', ')
  const state = o.error ? alert(o.error)
    : `<p>${counts} (at most ${o.maxItems} items, ${o.maxPerHost} per site).${o.mentionsOn && o.queued ? ` ${o.queued} webmentions are still being checked.` : ''}</p>`
  const what = [o.mentionsOn ? `mentions of <strong>@${h(o.ownerHost)}</strong>` : '', o.commentsOn ? 'comments on your feeds' : ''].filter(Boolean).join(' and ')
  return `<section aria-labelledby="inbox-heading">
<h2 id="inbox-heading">Inbox</h2>
<p>This server receives ${what} and puts them into your private inbox, <code>${INBOX_PATH}</code>.
Your feed reader shows it, if it supports inboxes and you allow it to read non-public content.</p>
${state}
</section>`
}
