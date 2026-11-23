import { dismissConfirmPage, dismissedPage, errorPage, type InboxSummary, sanitizeText } from 'pups-ui'
import { visibleText } from './content'
import { readLimited } from './feeds'
import { findInboxItem, ForeignInbox, inboxItems, isInboxKey, MAX_INBOX_ITEMS, MAX_ITEMS_PER_HOST, removeInboxItem } from './inbox'
import { answer, formFields, jsonResponse, type Receiver, ReceiverError } from './receiver'

/**
 * Dismissing inbox items: the RFC-9 action that readers send (POST /pups/inbox/action), and, for readers without
 * actions, the page that the fallback link opens (/pups/inbox/dismiss), where the owner confirms. Both are authorized
 * by the inbox's capability key, which only apps that can read the private inbox know.
 */

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
    let removed
    try {
      removed = await removeInboxItem(r, id)
    } catch (e) {
      if (e instanceof ForeignInbox) return jsonResponse({ message: e.message }, 409)
      throw e
    }
    r.log('inbox.dismissed', { id, removed, via: 'action' })
    // Idempotent: dismissing a dismissed item dismisses it.
    return jsonResponse({ message: 'Removed from your inbox', actions: [{ type: 'display', text: 'Dismissed' }] }, 200, { 'Cache-Control': 'no-store' })
  })
}

/** GET shows the item and a button, POST dismisses it (RFC-9: a link never acts by itself). `site` is the owner's host. */
export async function dismissPage(req: Request, r: Receiver, site: string): Promise<Response> {
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
    if (req.method == 'POST') {
      const removed = await removeInboxItem(r, id)
      r.log('inbox.dismissed', { id, removed, via: 'page' })
      return dismissedPage(site, removed ? 'The item was removed from your inbox.' : 'The item was not in your inbox anymore.')
    }
    if (req.method != 'GET' && req.method != 'HEAD') return errorPage('Method not allowed', 'Use GET or POST.', 405)
    const item = await findInboxItem(r, id)
    if (!item) return dismissedPage(site, 'The item is not in your inbox anymore.')
    const type = item._inbox?.type
    return dismissConfirmPage(site, {
      id, key: key!,
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
