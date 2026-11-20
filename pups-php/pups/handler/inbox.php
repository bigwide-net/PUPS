<?php

namespace Pups;

/**
 * Dismissing inbox items: the RFC-9 action that readers send (POST /pups/inbox/action),
 * and, for readers without actions, the page that the fallback link opens
 * (/pups/inbox/dismiss), where the owner confirms. Both are authorized by the inbox's
 * capability key, which only apps that can read the private inbox know.
 */

/** POST /pups/inbox/action?id=…&key=… (RFC-9 "Performing an action"). */
function inboxActionEndpoint(Request $req, Ctx $ctx): Response
{
    if ($req->method !== 'POST')
        throw methodNotAllowed('POST, OPTIONS');
    $q = $req->query();
    if (!isInboxKey($ctx, field($q, 'key')))
        return json(['message' => 'This action is no longer valid.'], 403)->noteError('forbidden', 'wrong inbox key');
    $body = json_decode($req->body(Limits::JSON_BYTES) ?? '', true);
    $id = field($q, 'id') ?? (is_array($body) && is_string($body['id'] ?? null) ? $body['id'] : null);
    if ($id === null)
        throw new HttpError(400, 'invalid_request', 'id is missing');
    try {
        $removed = removeInboxItem($ctx, $id);
    } catch (ForeignInbox $e) {
        return json(['message' => $e->getMessage()], 409)->noteError('conflict', $e->getMessage());
    }
    Log::event('inbox.dismissed', ['id' => $id, 'removed' => $removed, 'via' => 'action']);
    // Idempotent: dismissing a dismissed item dismisses it.
    return json(['message' => 'Removed from your inbox', 'actions' => [['type' => 'display', 'text' => 'Dismissed']]], 200, ['Cache-Control' => 'no-store']);
}

/** GET shows the item and a button, POST dismisses it (RFC-9: a link never acts by itself). */
function dismissPage(Request $req, Ctx $ctx): Response
{
    $c = $ctx->config;
    $params = $req->method === 'POST' ? $req->form() : $req->query();
    $id = field($params, 'id');
    $key = field($params, 'key');
    if (!isInboxKey($ctx, $key) || $id === null)
        return errorPage($c, 'Link not valid', 'This link is not valid, or it is outdated.', 403);
    try {
        if ($req->method === 'POST') {
            $removed = removeInboxItem($ctx, $id);
            Log::event('inbox.dismissed', ['id' => $id, 'removed' => $removed, 'via' => 'page']);
            return page($c, 'Dismissed', '<h1>Dismissed</h1>
' . status($removed ? 'The item was removed from your inbox.' : 'The item was not in your inbox anymore.'));
        }
        if ($req->method !== 'GET' && $req->method !== 'HEAD')
            return errorPage($c, 'Method not allowed', 'Use GET or POST.', 405);
        $item = findInboxItem($ctx, $id);
    } catch (ForeignInbox $e) {
        return errorPage($c, 'Inbox not available', $e->getMessage(), 409);
    }
    if (!$item)
        return page($c, 'Dismissed', '<h1>Dismissed</h1>
' . status('The item is not in your inbox anymore.'));
    $what = match ($item['_inbox']['type'] ?? null) { 'submission' => 'comment', 'reply' => 'reply', default => 'mention' };
    $author = $item['authors'][0]['name'] ?? null;
    $account = $item['_source']['accounts']['socialspec'] ?? null;
    $source = $item['_inbox']['source'] ?? '';
    return page($c, "Dismiss this $what?", '<h1>Dismiss this ' . $what . '?</h1>
<p>' . ($author ? 'From <strong>' . h(visible($author)) . '</strong>' . ($account ? ' (' . h(visible($account)) . ')' : '') . ', ' : '')
        . 'source <code>' . h(visible($source)) . '</code></p>
' . (isset($item['title']) ? '<p><strong>' . h(visible($item['title'])) . '</strong></p>' : '') . '
<blockquote>' . h(sanitizeText(visibleText(preg_replace('#<p class="without-extension-actions">.*?</p>#s', '', $item['content_html'] ?? '')), 300) ?? '') . '</blockquote>
<form method="post">
<input type="hidden" name="id" value="' . h($id) . '">
<input type="hidden" name="key" value="' . h($key) . '">
<p><button type="submit">Dismiss</button></p>
</form>');
}
