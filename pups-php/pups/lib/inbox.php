<?php

namespace Pups;

/**
 * The owner's inbox (RFC-12): a private JSON Feed at /pups/private/inbox.json with the
 * mentions (RFC-11) and the comments waiting for the owner (RFC-4). This server writes it
 * as `pups`, under the storage lock. Every item has a Dismiss action (RFC-9) with a
 * capability URL, and a link to a confirmation page for readers without actions (RFC-8).
 */

const INBOX_WRITER = 'pups';
const INBOX_ABOUT = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-12-Inbox-Feeds.md';
const ACTIONS_ABOUT = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-9-Feed-Actions.md';
const SOURCE_ABOUT = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-1-Source-for-JSON-Feeds.md';
/** Mentions are kept this long (RFC-12 "Size"). Submissions stay until dismissed. */
const MENTION_KEEP_MS = 30 * 24 * 3600_000;
/**
 * The inbox holds at most this many items. A new item pushes out the oldest mention; waiting
 * comments are never dropped, so with only comments left, new items are refused.
 */
const MAX_INBOX_ITEMS = 100;
/** At most this many items from one source host, so that no site can fill the inbox. */
const MAX_ITEMS_PER_HOST = 10;
const EXCERPT_CHARS = 500;

/** The inbox is written by another system, or isn't an inbox (RFC-12 "One writer"). */
final class ForeignInbox extends \Exception
{
}

/** There is no room for a new item (MAX_INBOX_ITEMS, MAX_ITEMS_PER_HOST). */
final class InboxFull extends \Exception
{
}

/** The host of an item's source, for the limit per host. */
function itemSourceHost(array $item): ?string
{
    return is_string($item['_inbox']['source'] ?? null) ? urlHost($item['_inbox']['source']) : null;
}

/**
 * Makes room for a new item from `host`, or throws InboxFull. Drops the oldest mention if the
 * inbox is full; the items must be sorted newest first.
 */
function makeRoom(array &$items, ?string $host): void
{
    if (count(array_filter($items, fn($i) => itemSourceHost($i) === $host)) >= MAX_ITEMS_PER_HOST)
        throw new InboxFull('The inbox already has ' . MAX_ITEMS_PER_HOST . " items from $host.");
    while (count($items) >= MAX_INBOX_ITEMS)
        if (!dropOldestMention($items))
            throw new InboxFull('The inbox is full: ' . MAX_INBOX_ITEMS . ' comments are waiting.');
}

/** Throws InboxFull if a new submission from `host` would be refused; `id` may be an edit of an item that exists. */
function checkRoomForSubmission(Ctx $ctx, string $id, ?string $host): void
{
    $items = inboxItems($ctx);
    if (array_filter($items, fn($i) => ($i['id'] ?? null) === $id))
        return;
    $items = array_values(array_filter($items, fn($i) => ($i['_inbox']['type'] ?? null) === 'submission' || itemSourceHost($i) === $host));
    makeRoom($items, $host);
}

/** The inbox's items, or [] if there is none. Throws ForeignInbox. */
function inboxItems(Ctx $ctx): array
{
    return loadInbox($ctx, $ctx->files->read(INBOX_PATH))['items'];
}

function loadInbox(Ctx $ctx, ?string $text): array
{
    if ($text === null)
        return newInbox($ctx);
    $feed = json_decode($text, true, 512);
    if (!is_array($feed) || ($feed['_inbox']['writer'] ?? null) !== INBOX_WRITER || !is_array($feed['items'] ?? null)) {
        $writer = is_array($feed) && is_array($feed['_inbox'] ?? null) && is_string($feed['_inbox']['writer'] ?? null) ? $feed['_inbox']['writer'] : null;
        throw new ForeignInbox($writer === null ? "The file " . INBOX_PATH . " isn't an inbox that this server wrote"
            : 'The inbox is managed by ' . visible($writer) . '. Delete ' . INBOX_PATH . ' to let this server write it.');
    }
    return $feed;
}

/**
 * Changes the inbox's items under the storage lock: `fn(array &$items)` returns whether it
 * changed them. Creates the inbox, sorts the items newest first, drops old mentions, and
 * keeps the file below max_upload_bytes. Throws ForeignInbox.
 */
function modifyInbox(Ctx $ctx, callable $fn): bool
{
    return $ctx->files->locked(function () use ($ctx, $fn) {
        $feed = loadInbox($ctx, $ctx->files->read(INBOX_PATH));
        $items = $feed['items'];
        if (!$fn($items))
            return false;
        $feed = array_merge($feed, array_diff_key(newInbox($ctx), ['items' => 0]));
        $feed['items'] = pruneInbox($ctx, $items);
        $json = json_encode($feed, JSON_FLAGS | JSON_PRETTY_PRINT);
        while (strlen($json) > maxUploadBytes($ctx->config) && dropOldestMention($feed['items']))
            $json = json_encode($feed, JSON_FLAGS | JSON_PRETTY_PRINT);
        $ctx->files->write(INBOX_PATH, $json);
        Log::event('inbox.written', ['items' => count($feed['items'])]);
        return true;
    });
}

/**
 * Adds an item, or replaces the one with the same id; a replaced item keeps its arrival date.
 * Throws InboxFull if there is no room for a new item.
 */
function putInboxItem(Ctx $ctx, array $item): void
{
    modifyInbox($ctx, function (array &$items) use ($ctx, $item) {
        foreach ($items as $i => $old)
            if (($old['id'] ?? null) === $item['id']) {
                $item['date_published'] = $old['date_published'] ?? $item['date_published'];
                if ($old == $item)
                    return false;
                $items[$i] = $item;
                return true;
            }
        $items = pruneInbox($ctx, $items);
        makeRoom($items, itemSourceHost($item));
        $items[] = $item;
        return true;
    });
}

/** Removes an item. Returns whether there was one. */
function removeInboxItem(Ctx $ctx, string $id): bool
{
    return modifyInbox($ctx, function (array &$items) use ($id) {
        $before = count($items);
        $items = array_values(array_filter($items, fn($i) => ($i['id'] ?? null) !== $id));
        return count($items) !== $before;
    });
}

function findInboxItem(Ctx $ctx, string $id): ?array
{
    foreach (inboxItems($ctx) as $item)
        if (($item['id'] ?? null) === $id)
            return $item;
    return null;
}

/** The feed without items: what this server writes on every change. */
function newInbox(Ctx $ctx): array
{
    $c = $ctx->config;
    return [
        'version' => 'https://jsonfeed.org/version/1.1',
        'title' => 'Inbox',
        'home_page_url' => "$c->base/pups/apps",
        '_inbox' => ['about' => INBOX_ABOUT, 'writer' => INBOX_WRITER,
            'categories' => array_keys(array_filter(['mentions' => $c->mentions, 'moderation' => $c->comments]))],
        '_actions' => ['about' => ACTIONS_ABOUT, 'templates' => [
            'dismiss' => ['type' => 'button', 'label' => 'Dismiss', 'action' => "$c->base/pups/inbox/action?id={id}&key=" . inboxKey($ctx)],
        ]],
        'items' => [],
    ];
}

/** The capability key of the inbox actions. Only the owner's apps can read the inbox, and so the key. */
function inboxKey(Ctx $ctx): string
{
    return substr(b64url(hash_hmac('sha256', 'inbox-actions', $ctx->state->secret(), true)), 0, 32);
}

function isInboxKey(Ctx $ctx, ?string $key): bool
{
    return is_string($key) && hash_equals(inboxKey($ctx), $key);
}

/** The page where readers without actions dismiss an item (RFC-8 fallback). */
function dismissPageUrl(Ctx $ctx, string $id): string
{
    return $ctx->config->base . '/pups/inbox/dismiss?id=' . rawurlencode($id) . '&key=' . inboxKey($ctx);
}

/** Newest first; mentions older than 30 days are dropped. */
function pruneInbox(Ctx $ctx, array $items): array
{
    usort($items, fn($a, $b) => strcmp($b['date_published'] ?? '', $a['date_published'] ?? ''));
    $cutoff = gmdate('Y-m-d\TH:i:s\Z', intdiv($ctx->now() - MENTION_KEEP_MS, 1000));
    return array_values(array_filter($items, fn($i) => ($i['_inbox']['type'] ?? null) === 'submission' || ($i['date_published'] ?? '') >= $cutoff));
}

function dropOldestMention(array &$items): bool
{
    for ($i = count($items) - 1; $i >= 0; $i--)
        if (($items[$i]['_inbox']['type'] ?? null) !== 'submission') {
            array_splice($items, $i, 1);
            return true;
        }
    return false;
}

/**
 * An inbox item. `post` is the parsed item (feeds.php); `content` its HTML for the inbox. The
 * account is included only as `attribution()` verified it.
 */
function inboxItem(Ctx $ctx, string $id, string $type, string $source, string $target, array $post, string $content, ?string $author, ?string $account): array
{
    $url = $post['url'] ?? null;
    $fallback = '<p class="without-extension-actions"><a href="' . h(dismissPageUrl($ctx, $id)) . '">Dismiss</a></p>';
    return array_filter([
        'id' => $id,
        'url' => is_string($url) && preg_match('#^https?://#i', $url) && isCleanUrlString($url) ? $url : null,
        'title' => sanitizeText($post['title'] ?? null, 200),
        'content_html' => $content . $fallback,
        'date_published' => gmdate('Y-m-d\TH:i:s\Z', intdiv($ctx->now(), 1000)),
        'authors' => ($name = sanitizeText($author, 100)) ? [['name' => $name]] : null,
        '_source' => $account ? ['about' => SOURCE_ABOUT, 'accounts' => ['socialspec' => $account]] : null,
        '_inbox' => array_filter(['about' => INBOX_ABOUT, 'type' => $type, 'source' => $source, 'target' => $target, 'postDate' => $post['date'] ?? null]),
        '_actions' => ['about' => ACTIONS_ABOUT, 'actions' => [['template' => 'dismiss']]],
    ], fn($v) => $v !== null);
}

/** A short excerpt of a post for a mention: its plain text, at most 500 characters. */
function excerptHtml(array $post): string
{
    return textHtml(sanitizeText(plainText($post), EXCERPT_CHARS) ?? '');
}
