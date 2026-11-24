import { approvedPage, dismissConfirmPage, dismissedPage, errorPage, type InboxSummary, sanitizeText } from 'pups-ui'
import { commentItem, refusal } from './comments'
import { visibleText } from './content'
import { readLimited } from './feeds'
import { findInboxItem, ForeignInbox, inboxItems, isApprovable, isInboxKey, MAX_INBOX_ITEMS, MAX_ITEMS_PER_HOST, removeInboxItem } from './inbox'
import { answer, formFields, jsonResponse, type Receiver, ReceiverError, writeStatus } from './receiver'

/**
 * Dismissing and approving inbox items: the RFC-9 actions that readers send (POST /pups/inbox/action, with
 * `do=approve` for Approve), and, for readers without actions, the pages that the fallback links open
 * (/pups/inbox/dismiss, /pups/inbox/approve), where the owner confirms. All are authorized by the inbox's capability
 * key, which only apps that can read the private inbox know.
 */

/**
 * Removes an item from the inbox. A comment that could have been approved is rejected: its status page says so (RFC-4
 * `moderation-rejected`). Returns whether the item was there.
 */
export async function dismissItem(r: Receiver, id: string, via: string): Promise<boolean> {
  const item = await findInboxItem(r, id)
  const removed = await removeInboxItem(r, id)
  if (item && isApprovable(item))
    await writeStatus(r, id, { status: 'failure', code: 'moderation-rejected', text: "The owner didn't approve the comment." })
  r.log('inbox.dismissed', { id, removed, via })
  return removed
}

/**
 * Publishes a comment from the inbox in its post's comment feed, removes it from the inbox, and tells its author on the
 * status page. Returns the comment's address. Throws ReceiverError 404 if the item isn't in the inbox, 409 if it can't
 * be approved.
 */
export async function approveItem(r: Receiver, id: string, via: string): Promise<string> {
  const item = await findInboxItem(r, id)
  if (!item) throw new ReceiverError(404, 'not_found', 'The comment is not in your inbox anymore.')
  if (!isApprovable(item) || !r.commentFeeds) throw new ReceiverError(409, 'conflict', "This item can't be approved.")
  let url
  try {
    // As its author agreed: in full, or as an abstract if either the submission or the feed now says summary.
    url = await r.commentFeeds.publish(item._inbox.target, now => commentItem(item, now == 'summary' ? 'summary' : undefined))
  } catch (e) {
    const x = refusal(e)
    if (!x) throw e
    throw new ReceiverError(x.status, x.code, x.message)
  }
  await removeInboxItem(r, id)
  await writeStatus(r, id, { status: 'success', pubDate: item._inbox.postDate ?? item.date_published, pubUrl: url })
  r.log('inbox.approved', { id, url, via })
  return url
}

/** POST /pups/inbox/action?id=…&key=… (RFC-9 "Performing an action"). */
export function inboxActionEndpoint(req: Request, r: Receiver): Promise<Response> {
  return answer(async () => {
    if (req.method != 'POST') throw new ReceiverError(405, 'method_not_allowed', 'Method not allowed', { Allow: 'POST, OPTIONS' })
    const q = new URL(req.url).searchParams
    if (!isInboxKey(r, q.get('key'))) return jsonResponse({ message: 'This action is no longer valid.' }, 403)
    const bytes = await readLimited(req.body, 16 * 1024)
    if (!bytes) throw new ReceiverError(413, 'too_large', 'The request body is too large')
    let body: any
    try {
      body = JSON.parse(new TextDecoder().decode(bytes))
    } catch {}
    const id = q.get('id') ?? (typeof body?.id == 'string' ? body.id : undefined)
    if (id == undefined || id.length > 256) throw new ReceiverError(400, 'invalid_request', 'id is missing')
    try {
      if (q.get('do') == 'approve') {
        const url = await approveItem(r, id, 'action')
        return jsonResponse({ message: 'Published', actions: [{ type: 'display', text: 'Comment published.', url }] }, 200, { 'Cache-Control': 'no-store' })
      }
      // Idempotent: dismissing a dismissed item dismisses it.
      await dismissItem(r, id, 'action')
    } catch (e) {
      if (e instanceof ForeignInbox) return jsonResponse({ message: e.message }, 409)
      if (e instanceof ReceiverError) return jsonResponse({ message: e.message }, e.status)
      throw e
    }
    return jsonResponse({ message: 'Removed from your inbox', actions: [{ type: 'display', text: 'Dismissed' }] }, 200, { 'Cache-Control': 'no-store' })
  })
}

/**
 * GET shows the item and a button, POST dismisses or approves it (RFC-9: a link never acts by itself). `site` is the
 * owner's host.
 */
export async function dismissPage(req: Request, r: Receiver, site: string, action: 'dismiss' | 'approve' = 'dismiss'): Promise<Response> {
  let params: URLSearchParams
  try {
    params = await formFields(req, 256)
  } catch (e) {
    if (e instanceof ReceiverError) return errorPage('Invalid request', e.message, e.status)
    throw e
  }
  const id = params.get('id')
  const key = params.get('key')
  if (!isInboxKey(r, key) || !id) return errorPage('Link not valid', 'This link is not valid, or it is outdated.', 403)
  try {
    if (req.method == 'POST' && action == 'approve') {
      try {
        return approvedPage(site, await approveItem(r, id, 'page'))
      } catch (e) {
        if (e instanceof ReceiverError) return errorPage('Not published', e.message, e.status)
        throw e
      }
    }
    if (req.method == 'POST') {
      const removed = await dismissItem(r, id, 'page')
      return dismissedPage(site, removed ? 'The item was removed from your inbox.' : 'The item was not in your inbox anymore.')
    }
    if (req.method != 'GET' && req.method != 'HEAD') return errorPage('Method not allowed', 'Use GET or POST.', 405)
    const item = await findInboxItem(r, id)
    if (!item) return dismissedPage(site, 'The item is not in your inbox anymore.', 'Not in your inbox')
    if (action == 'approve' && !isApprovable(item)) return errorPage('Not published', "This item can't be approved.", 409)
    const type = item._inbox?.type
    return dismissConfirmPage(site, {
      id, key: key!, action,
      what: type == 'submission' ? 'comment' : type == 'reply' ? 'reply' : 'mention',
      author: typeof item.authors?.[0]?.name == 'string' ? item.authors[0].name : undefined,
      account: typeof item._source?.accounts?.socialspec == 'string' ? item._source.accounts.socialspec : undefined,
      source: typeof item._inbox?.source == 'string' ? item._inbox.source : '',
      title: typeof item.title == 'string' ? item.title : undefined,
      excerpt: sanitizeText(visibleText(String(item.content_html ?? '').replace(/<p class="without-extension-actions">[\s\S]*?<\/p>/g, '')), 300) ?? '',
    })
  } catch (e) {
    if (e instanceof ForeignInbox) return errorPage('Inbox not available', e.message, 409)
    throw e
  }
}

/** What the receiver has put into the inbox, for the apps page. */
export async function inboxSummary(r: Receiver): Promise<InboxSummary | undefined> {
  if (!r.mentions && !r.comments) return
  const base = {
    ownerHost: r.ownerHost, mentionsOn: r.mentions, commentsOn: r.comments, queued: await r.queue.count(),
    maxItems: MAX_INBOX_ITEMS, maxPerHost: MAX_ITEMS_PER_HOST,
  }
  try {
    const items = await inboxItems(r)
    const count = (types: string[]) => items.filter(i => types.includes(i._inbox?.type)).length
    return { ...base, mentions: count(['mention', 'reply']), comments: count(['submission']) }
  } catch (e) {
    if (e instanceof ForeignInbox) return { ...base, mentions: 0, comments: 0, error: e.message }
    throw e
  }
}
