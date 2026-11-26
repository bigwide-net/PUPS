<?php

namespace Pups;

/**
 * Dismissing, approving and rejecting inbox items: the RFC-9 actions that readers send (POST
 * /pups/inbox/action, with `do=approve` for Approve, `do=reject` for Reject), and, for readers
 * without actions, the pages that the fallback links open (/pups/inbox/dismiss,
 * /pups/inbox/approve, /pups/inbox/reject), where the owner confirms. All are authorized by the inbox's capability key, which only apps that can
 * read the private inbox know.
 */

/**
 * Removes an item from the inbox. A comment that could have been approved is rejected: its status
 * page says so (RFC-4 `moderation-rejected`). Returns whether the item was there.
 */
function dismissItem(Ctx $ctx, string $id, string $via): bool
{
    $item = findInboxItem($ctx, $id);
    $removed = removeInboxItem($ctx, $id);
    if ($item && isApprovable($item))
        writeStatus($ctx, $id, ['status' => 'failure', 'code' => 'moderation-rejected', 'text' => 'The owner didn\'t approve the comment.']);
    Log::event('inbox.dismissed', ['id' => $id, 'removed' => $removed, 'via' => $via]);
    return $removed;
}

/**
 * Publishes a comment from the inbox in its post's comment feed (comments.php), removes it from the
 * inbox, tells its author on the status page, and queues the mentions to those it answers or names
 * (sender.php). Returns the comment's address. Throws 404 if the
 * item isn't in the inbox, 409 if it can't be approved.
 */
function approveItem(Ctx $ctx, string $id, string $via): string
{
    $item = findInboxItem($ctx, $id) ?? throw new HttpError(404, 'not_found', 'The comment is not in your inbox anymore.');
    if (!isApprovable($item))
        throw new HttpError(409, 'conflict', 'This item can\'t be approved.');
    $target = $item['_inbox']['target'];
    $before = publishedComment($ctx, $target, $id);
    $url = publishComment($ctx, $item, $after);
    queueMentions($ctx, [['address' => $url, 'before' => $before, 'after' => $after, 'answered' => commentThread($ctx, $target)['parent'] ?? null]]);
    removeInboxItem($ctx, $id);
    writeStatus($ctx, $id, ['status' => 'success', 'pubDate' => $item['_inbox']['postDate'] ?? $item['date_published'], 'pubUrl' => $url]);
    Log::event('inbox.approved', ['id' => $id, 'url' => $url, 'via' => $via]);
    return $url;
}

/**
 * Removes a comment that auto-moderation published, and the replies to it, from the comment feeds
 * (withdrawComment()), removes it from the inbox, and tells its author on the status page (RFC-4
 * `moderation-rejected`). Returns whether the comment was still published. Throws 404 if the item
 * isn't in the inbox, 409 if it can't be rejected.
 */
function rejectItem(Ctx $ctx, string $id, string $via): bool
{
    $item = findInboxItem($ctx, $id) ?? throw new HttpError(404, 'not_found', 'The comment is not in your inbox anymore.');
    if (!isRejectable($item))
        throw new HttpError(409, 'conflict', 'This item can\'t be rejected.');
    $removed = withdrawComment($ctx, $item['_inbox']['target'], $id);
    removeInboxItem($ctx, $id);
    writeStatus($ctx, $id, ['status' => 'failure', 'code' => 'moderation-rejected', 'text' => 'The owner removed the comment.']);
    Log::event('inbox.rejected', ['id' => $id, 'removed' => count($removed), 'via' => $via]);
    return (bool) $removed;
}

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
        if (field($q, 'do') === 'approve') {
            $url = approveItem($ctx, $id, 'action');
            return json(['message' => 'Published', 'actions' => [['type' => 'display', 'text' => 'Comment published.', 'url' => $url]]], 200, ['Cache-Control' => 'no-store']);
        }
        if (field($q, 'do') === 'reject') {
            rejectItem($ctx, $id, 'action');
            return json(['message' => 'Rejected', 'actions' => [['type' => 'display', 'text' => 'Comment rejected and removed.']]], 200, ['Cache-Control' => 'no-store']);
        }
        // Idempotent: dismissing a dismissed item dismisses it.
        dismissItem($ctx, $id, 'action');
    } catch (ForeignInbox $e) {
        return json(['message' => $e->getMessage()], 409)->noteError('conflict', $e->getMessage());
    } catch (HttpError $e) {
        return json(['message' => $e->getMessage()], $e->status)->noteError($e->error, $e->getMessage());
    }
    return json(['message' => 'Removed from your inbox', 'actions' => [['type' => 'display', 'text' => 'Dismissed']]], 200, ['Cache-Control' => 'no-store']);
}

/** GET shows the item and a button, POST dismisses, approves or rejects it (RFC-9: a link never acts by itself). */
function dismissPage(Request $req, Ctx $ctx, string $do = 'dismiss'): Response
{
    $c = $ctx->config;
    $params = $req->method === 'POST' ? $req->form() : $req->query();
    $id = field($params, 'id');
    $key = field($params, 'key');
    if (!isInboxKey($ctx, $key) || $id === null)
        return errorPage($c, 'Link not valid', 'This link is not valid, or it is outdated.', 403);
    try {
        if ($req->method === 'POST' && $do === 'approve') {
            try {
                $url = approveItem($ctx, $id, 'page');
            } catch (HttpError $e) {
                return errorPage($c, 'Not published', $e->getMessage(), $e->status);
            }
            return page($c, 'Comment published', '<h1>Comment published</h1>
' . status('The comment is published.') . '
<p><a href="' . h($url) . '">' . h(visible($url)) . '</a></p>');
        }
        if ($req->method === 'POST' && $do === 'reject') {
            try {
                $removed = rejectItem($ctx, $id, 'page');
            } catch (HttpError $e) {
                return errorPage($c, 'Not rejected', $e->getMessage(), $e->status);
            }
            return page($c, 'Comment rejected', '<h1>Comment rejected</h1>
' . status($removed ? 'The comment was removed from your site.' : 'The comment was not published anymore.'));
        }
        if ($req->method === 'POST') {
            $removed = dismissItem($ctx, $id, 'page');
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
        return page($c, 'Not in your inbox', '<h1>Not in your inbox</h1>
' . status('The item is not in your inbox anymore.'));
    if ($do === 'approve' && !isApprovable($item))
        return errorPage($c, 'Not published', 'This item can\'t be approved.', 409);
    if ($do === 'reject' && !isRejectable($item))
        return errorPage($c, 'Not rejected', 'This item can\'t be rejected.', 409);
    $what = isRejectable($item) ? 'comment' : match ($item['_inbox']['type'] ?? null) { 'submission' => 'comment', 'reply' => 'reply', default => 'mention' };
    [$verb, $question] = match ($do) {
        'approve' => ['Publish Comment', "Publish this $what?"],
        'reject' => ['Reject Comment', "Reject this $what?"],
        default => ['Dismiss', "Dismiss this $what?"],
    };
    $author = $item['authors'][0]['name'] ?? null;
    $account = $item['_source']['accounts']['socialspec'] ?? null;
    $source = $item['_inbox']['source'] ?? '';
    return page($c, $question, '<h1>' . h($question) . '</h1>
' . ($do === 'reject' ? '<p>Auto-moderation published it. Rejecting removes it, and the replies to it, from your site, and tells its author that you rejected it.</p>
' : '') . '<p>' . ($author ? 'From <strong>' . h(visible($author)) . '</strong>' . ($account ? ' (' . h(visible($account)) . ')' : '') . ', ' : '')
        . 'source <code>' . h(visible($source)) . '</code></p>
' . (isset($item['title']) ? '<p><strong>' . h(visible($item['title'])) . '</strong></p>' : '') . '
<blockquote>' . h(sanitizeText(visibleText(preg_replace(FALLBACK, '', $item['content_html'] ?? '')), 300) ?? '') . '</blockquote>
<form method="post">
<input type="hidden" name="id" value="' . h($id) . '">
<input type="hidden" name="key" value="' . h($key) . '">
<p><button type="submit">' . $verb . '</button></p>
</form>');
}
