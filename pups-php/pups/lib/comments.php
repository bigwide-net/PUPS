<?php

namespace Pups;

/**
 * Comment feeds (RFC-7 "Publishing comments"): the comments on the owner's posts, and the replies to
 * them, that the owner approved in the inbox, republished by this server (RFC-4 `republish: "full"` or
 * `"summary"`). Every post or comment with replies has one comment feed of its direct replies, newest
 * first: a post's is `<feed dir>/comments/<index>.json`, a comment's `<feed dir>/comments/<index>/<comment
 * id>.json`, whatever its depth (see commentFeedPath()). The item's `_source.comments` (RFC-1) names it
 * with the counts, and the comment feed names the item it answers in `_pups.inReplyTo`. Replies are
 * nested as deep as the feed's policy allows (RFC-4 `maxDepth`), and at most MAX_DEPTH_LIMIT levels.
 */

/** RFC-4's default `commentLimit`: the comments a post may have, on all levels. */
const COMMENT_POLICY_LIMIT = 1000;
/** RFC-4's default `maxDepth`, and the deepest nesting this server publishes. */
const MAX_DEPTH_DEFAULT = 5;
const MAX_DEPTH_LIMIT = 10;
/** The values of RFC-4 `republish` under which approved comments are published. */
const PUBLISHING = ['full', 'summary'];
/** RFC-4, whose `_commenting` carries `notifyReplies`. */
const COMMENTING_ABOUT = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-4-Feed-Submissions.md';
/** An abstract (`republish: "summary"`) has at most this many characters. */
const SUMMARY_CHARS = 150;

/** A policy's `maxDepth` as this server applies it: RFC-4's default if it is missing, and between 1 and MAX_DEPTH_LIMIT. */
function maxDepthOf(mixed $v): int
{
    return is_int($v) ? max(1, min(MAX_DEPTH_LIMIT, $v)) : MAX_DEPTH_DEFAULT;
}

/** The comments policy of a kept feed, or null. */
function commentPolicyOf(KeptFeed $feed): ?\stdClass
{
    $p = $feed->doc->_submissions->policies->comments ?? null;
    return $p instanceof \stdClass ? $p : null;
}

/**
 * Where a comment on `target` goes: `target` is a post of a kept feed of the owner, or a comment
 * published in one of its comment feeds. Null otherwise, also for a comment that isn't published
 * (anymore). Under the storage lock if anything is to be changed.
 *
 * - 'path' (the feed file), 'feed' (KeptFeed), 'post', 'index' and 'address' (the post's);
 * - 'parent': the item that the comment answers, the post or a comment, and 'parentAddress';
 * - 'depth': the new comment's, 1 for a comment on the post;
 * - 'levels': the comment feeds from the post's down to the one for the comment, each ['path',
 *   'parent' (the id of the item it answers), 'doc' (as stored, or null)]. Level k holds comments of
 *   depth k + 1, and the item it answers is in level k - 1.
 */
function commentThread(Ctx $ctx, string $target): ?array
{
    $c = $ctx->config;
    [$url, $id] = splitRef($target);
    $path = $id === null ? null : ownerStoragePath($url, $c);
    if ($path === null)
        return null;
    $parts = commentFeedParts($path, $c);
    $feedPath = $parts[0] ?? (isFeedPath($path, $c) ? $path : archiveOwner($path, $c));
    $stored = $feedPath === null ? null : parseJsonFeed($ctx->files->read($feedPath));
    if (!isKept($stored))
        return null;
    $feed = new KeptFeed($ctx, $feedPath, $stored);
    $found = $parts ? $feed->get(null, $parts[1]) : $feed->get($id);
    $index = $found ? itemIndex($found['item']) : null;
    if ($index === null)
        return null;
    $postId = itemId($found['item']);
    $thread = ['path' => $feedPath, 'feed' => $feed, 'post' => $found['item'], 'index' => $index, 'address' => $found['address'],
        'parent' => $found['item'], 'parentAddress' => $found['address']];
    $levels = [];
    if ($parts) {
        // The comment feed that holds the comment, and above it those of its ancestors, up to the post's.
        for ($p = $path; ; ) {
            $doc = parseJsonFeed($ctx->files->read($p));
            [$f, $i, $answers] = commentFeedParts($p, $c) ?? [null, null, null];
            if (!$doc || $f !== $feedPath || $i !== $index || count($levels) >= MAX_DEPTH_LIMIT)
                return null;
            array_unshift($levels, ['path' => $p, 'parent' => $answers ?? $postId, 'doc' => $doc]);
            if ($answers === null)
                break;
            $up = $doc->_pups->inReplyTo ?? null;
            [$u, $upId] = is_string($up) ? splitRef($up) : [null, null];
            $p = $upId === $answers ? ownerStoragePath($u, $c) : null;
            if ($p === null)
                return null;
        }
        $comment = null;
        foreach ($levels[count($levels) - 1]['doc']->items as $item)
            if ($item instanceof \stdClass && itemId($item) === $id)
                $comment = $item;
        if (!$comment || !preg_match('/^' . COMMENT_ID . '$/D', $id))
            return null;
        $levels[] = ['path' => commentFeedPath($feedPath, $index, $id), 'parent' => $id, 'doc' => null];
        $thread['parent'] = $comment;
        $thread['parentAddress'] = publicUrl($path, $c) . '#' . rawurlencode($id);
    } else
        $levels[] = ['path' => commentFeedPath($feedPath, $index), 'parent' => $postId, 'doc' => null];
    $last = count($levels) - 1;
    $levels[$last]['doc'] = parseJsonFeed($ctx->files->read($levels[$last]['path']));
    return $thread + ['levels' => $levels, 'depth' => count($levels)];
}

/** The comment feed for comments on what `thread` answers: ['path', 'parent', 'doc']. */
function threadFeed(array $thread): array
{
    return $thread['levels'][count($thread['levels']) - 1];
}

/** Whether `target`, a URL with or without `#id`, is in a comment feed of the owner: a comment on it would be a reply to a comment. */
function isCommentRef(Ctx $ctx, string $target): bool
{
    $path = ownerStoragePath(splitRef($target)[0], $ctx->config);
    return $path !== null && commentFeedParts($path, $ctx->config) !== null;
}

/** The comment `id` as published in answer to `target`, or null. */
function publishedComment(Ctx $ctx, string $target, string $id): ?\stdClass
{
    $thread = commentThread($ctx, $target);
    foreach (($thread ? threadFeed($thread)['doc'] : null)?->items ?? [] as $item)
        if (itemId($item) === $id)
            return $item;
    return null;
}

function isPublished(Ctx $ctx, string $target, string $id): bool
{
    return publishedComment($ctx, $target, $id) !== null;
}

/**
 * Whether a comment as it would be republished from `inboxItem` is the published one, apart from
 * its dates and replies, and with `exceptNotify` also apart from `notifyReplies`.
 */
function isSameComment(array $inboxItem, \stdClass $published, bool $exceptNotify = false): bool
{
    $strip = function (\stdClass $c) use ($exceptNotify) {
        $c = deepCopy($c);
        unset($c->date_published, $c->date_modified);
        if ($exceptNotify)
            unset($c->_commenting);
        setComments($c, null);
        return canonical($c);
    };
    return $strip(commentItem($inboxItem)) === $strip($published);
}

/** The address of the comment `id` in answer to `target`: its comment feed's URL + `#id`. */
function commentAddress(Ctx $ctx, string $target, string $id): ?string
{
    $thread = commentThread($ctx, $target);
    return $thread ? publicUrl(threadFeed($thread)['path'], $ctx->config) . '#' . rawurlencode($id) : null;
}

/** A new comment feed, for the comments on what `thread` answers. */
function newCommentFeed(Ctx $ctx, array $thread): \stdClass
{
    $c = $ctx->config;
    $post = $thread['post'];
    $title = is_string($post->title ?? null) && $post->title !== '' ? $post->title : null;
    $feedTitle = is_string($thread['feed']->doc->title ?? null) ? $thread['feed']->doc->title : null;
    $on = $title !== null ? "“{$title}”" : ($feedTitle !== null ? "a post in “{$feedTitle}”" : null);
    if ($thread['depth'] === 1)
        $feedName = $on !== null ? "Comments on $on" : 'Comments';
    else {
        $by = $thread['parent']->authors[0]->name ?? null;
        $feedName = 'Replies to a comment' . (is_string($by) && $by !== '' ? " by $by" : '') . ($on !== null ? " on $on" : '');
    }
    $url = $thread['parent']->url ?? null;
    $url = is_string($url) && preg_match('#^https?://#i', $url) ? $url : ($post->url ?? null);
    $path = threadFeed($thread)['path'];
    return (object) [
        'version' => JSON_FEED_VERSION,
        'title' => $feedName,
        'home_page_url' => is_string($url) && preg_match('#^https?://#i', $url) ? $url : $c->me,
        'feed_url' => publicUrl($path, $c),
        'user_comment' => ($thread['depth'] === 1 ? 'The comments on ' : 'The replies to ') . "{$thread['parentAddress']} that the owner approved, "
            . 'republished by a Personal Upload Server (PUPS) following ' . FEED_SPEC . ' and https://github.com/bigwide-net/RFCs/blob/main/RFC-4-Feed-Submissions.md.',
        '_pups' => (object) ['about' => FEED_SPEC, 'pupsControlled' => true, 'inReplyTo' => $thread['parentAddress']],
        'items' => [],
    ];
}

/**
 * The comment as republished (RFC-4 "What is republished"), from its inbox item: the title, the
 * content as the inbox keeps it (RFC-5 Comment HTML) and the Markdown it came from, the author's name, link and verified account, its date,
 * `_source.inReplyTo`, and `_commenting.notifyReplies` if its author opted out of reply mentions. Its id is the guid of the submission. With `republish: "summary"`
 * (`mode`, by default what the author agreed to), the content is an abstract: the plain text,
 * cut off after 150 characters, as `content_text`; `url` links to the full text.
 */
function commentItem(array $inboxItem, ?string $mode = null): \stdClass
{
    $html = $inboxItem['content_html'] ?? '';
    $cut = strpos($html, '<p class="without-extension-actions">');
    $html = $cut === false ? $html : substr($html, 0, $cut);
    $summary = ($mode ?? $inboxItem['_pups']['republish'] ?? 'full') === 'summary';
    $account = $inboxItem['_source']['accounts']['socialspec'] ?? null;
    $markdown = $summary ? null : $inboxItem['_source']['markdown'] ?? null;
    return json_decode(json_encode(array_filter([
        'id' => $inboxItem['id'],
        'url' => $inboxItem['url'] ?? null,
        'title' => $inboxItem['title'] ?? null,
        'content_html' => $summary ? null : $html,
        'content_text' => $summary ? sanitizeText(visibleText($html), SUMMARY_CHARS) ?? '' : null,
        'date_published' => $inboxItem['_inbox']['postDate'] ?? $inboxItem['date_published'],
        'authors' => $inboxItem['authors'] ?? null,
        '_source' => ['about' => SOURCE_ABOUT, 'inReplyTo' => $inboxItem['_inbox']['target']] + ($account ? ['accounts' => ['socialspec' => $account]] : [])
            + ($markdown !== null ? ['markdown' => $markdown] : []),
        '_commenting' => ($inboxItem['_commenting']['notifyReplies'] ?? null) === false ? ['about' => COMMENTING_ABOUT, 'notifyReplies' => false] : null,
    ], fn($v) => $v !== null), FEED_JSON), false);
}

/**
 * The counts of a comment feed for `_source.comments` (RFC-1): its items, and with all replies to
 * them, as far as the items say.
 */
function commentCounts(?\stdClass $doc): array
{
    $total = 0;
    foreach ($doc->items ?? [] as $item)
        $total += 1 + ($item instanceof \stdClass ? (commentsOf($item)?->total ?? commentsOf($item)?->count ?? 0) : 0);
    return [count($doc->items ?? []), $total];
}

/**
 * Writes the comment feeds of a thread after the deepest one changed, from the bottom up: each one,
 * or its deletion when it is empty, then the counts of the item it answers in the level above, and
 * last the post's. A comment without replies has `{count: 0, total: 0}` while it can get replies, at
 * a depth below the policy's `maxDepth`. Under the storage lock.
 */
function writeThread(Ctx $ctx, array $thread): void
{
    $c = $ctx->config;
    $maxDepth = maxDepthOf(commentPolicyOf($thread['feed'])?->maxDepth ?? null);
    $levels = $thread['levels'];
    for ($k = count($levels) - 1; $k >= 0; $k--) {
        ['path' => $path, 'parent' => $parent, 'doc' => $doc] = $levels[$k];
        [$count, $total] = commentCounts($doc);
        if ($count) {
            $text = json_encode($doc, FEED_JSON | JSON_PRETTY_PRINT);
            checkQuota($ctx, [$path => $text]);
            $ctx->files->write($path, $text);
        } elseif ($ctx->files->stat($path))
            $ctx->files->delete($path);
        $url = publicUrl($path, $c);
        if ($k === 0) {
            $thread['feed']->setCommentCounts($parent, $url, $count, $total);
            $thread['feed']->commit();
        } else
            foreach ($levels[$k - 1]['doc']->items as $item)
                if ($item instanceof \stdClass && itemId($item) === $parent)
                    setComments($item, $count ? (object) ['feedUrl' => $url, 'count' => $count, 'total' => $total]
                        : ($k < $maxDepth ? (object) ['count' => 0, 'total' => 0] : null));
        Log::event('comments.written', ['path' => $path, 'count' => $count]);
    }
}

/**
 * Publishes an approved comment in the comment feed of the post or comment it answers, or replaces it
 * there (an approved edit), and updates the counts up to the post. It is published as its author
 * agreed: in full, or as an abstract if either the submission or the feed now says `summary`. Returns
 * the comment's address: the comment feed's URL + `#id`. Throws 409 if the post or the comment it
 * answers is gone, its feed isn't kept by this server or doesn't publish comments anymore, or the post
 * has as many comments, on all levels, as its policy allows. `built` is set to the comment as published.
 */
function publishComment(Ctx $ctx, array $inboxItem, ?\stdClass &$built = null): string
{
    return $ctx->files->locked(function () use ($ctx, $inboxItem, &$built) {
        $thread = commentThread($ctx, $inboxItem['_inbox']['target'] ?? '')
            ?? throw new HttpError(409, 'conflict', 'What the comment answers doesn\'t exist anymore, or its feed isn\'t kept by this server.');
        $now = $thread['feed']->doc->_submissions->republish ?? null;
        if (!in_array($now, PUBLISHING, true))
            throw new HttpError(409, 'conflict', 'The feed doesn\'t publish comments anymore.');
        $policy = commentPolicyOf($thread['feed']);
        if ($thread['depth'] > maxDepthOf($policy?->maxDepth ?? null))
            throw new HttpError(409, 'max-depth', 'The feed doesn\'t take replies this deep anymore.');
        $level = count($thread['levels']) - 1;
        $doc = $thread['levels'][$level]['doc'] ??= newCommentFeed($ctx, $thread);
        $comment = $built = commentItem($inboxItem, $now === 'summary' ? 'summary' : null);
        $open = $thread['depth'] < maxDepthOf($policy?->maxDepth ?? null) ? (object) ['count' => 0, 'total' => 0] : null;
        $at = null;
        foreach ($doc->items as $p => $item)
            if (itemId($item) === $comment->id)
                $at = $p;
        if ($at === null) {
            $limit = is_int($policy?->commentLimit ?? null) ? $policy->commentLimit : COMMENT_POLICY_LIMIT;
            if (commentCounts($thread['levels'][0]['doc'])[1] >= $limit)
                throw new HttpError(409, 'comment-limit', "The post has $limit comments, as many as the feed allows.");
            setComments($comment, $open);
            array_unshift($doc->items, $comment);
        } else {
            // An edit keeps the date of publication and the replies (RFC-4 "Edits and deletes").
            $old = $doc->items[$at];
            if (is_string($old->date_published ?? null))
                $comment->date_published = $old->date_published;
            setComments($comment, commentsOf($old) ?? $open);
            if (canonical($comment) !== canonical((object) array_diff_key((array) $old, ['date_modified' => 0])))
                $comment->date_modified = gmdate('Y-m-d\TH:i:s\Z', intdiv($ctx->now(), 1000));
            elseif (isset($old->date_modified))
                $comment->date_modified = $old->date_modified;
            $doc->items[$at] = $comment;
        }
        writeThread($ctx, $thread);
        return publicUrl($thread['levels'][$level]['path'], $ctx->config) . '#' . rawurlencode($comment->id);
    });
}

/**
 * Removes a published comment, with all replies to it (RFC-4 "Edits and deletes"), from the comment
 * feed of what it answers, `target`, and updates the counts up to the post. Returns what was removed,
 * each ['item', 'address']: the comment first, and every reply after what it answers; [] if it wasn't there.
 */
function unpublishComment(Ctx $ctx, string $target, string $id): array
{
    return $ctx->files->locked(function () use ($ctx, $target, $id) {
        $thread = commentThread($ctx, $target);
        $level = $thread ? count($thread['levels']) - 1 : 0;
        $doc = $thread['levels'][$level]['doc'] ?? null;
        $removed = [];
        foreach ($doc->items ?? [] as $item)
            if ($item instanceof \stdClass && itemId($item) === $id)
                $removed[] = ['item' => $item, 'address' => publicUrl($thread['levels'][$level]['path'], $ctx->config) . '#' . rawurlencode($id)];
        if (!$removed)
            return [];
        for ($i = 0; $i < count($removed) && $i < 10_000; $i++) {
            $rid = itemId($removed[$i]['item']);
            if (!is_string($rid) || !preg_match('/^' . COMMENT_ID . '$/D', $rid))
                continue;
            $path = commentFeedPath($thread['path'], $thread['index'], $rid);
            foreach (parseJsonFeed($ctx->files->read($path))?->items ?? [] as $reply)
                if ($reply instanceof \stdClass && is_string(itemId($reply)))
                    $removed[] = ['item' => $reply, 'address' => publicUrl($path, $ctx->config) . '#' . rawurlencode(itemId($reply))];
        }
        $doc->items = array_values(array_filter($doc->items, fn($i) => itemId($i) !== $id));
        dropReplies($ctx, $thread['path'], $thread['index'], $id);
        writeThread($ctx, $thread);
        return $removed;
    });
}

/** Deletes the comment feed of the replies to a comment, and theirs, on all levels. */
function dropReplies(Ctx $ctx, string $feedPath, int $index, string $id, int $depth = 0): void
{
    if (!preg_match('/^' . COMMENT_ID . '$/D', $id) || $depth > MAX_DEPTH_LIMIT)
        return;
    $path = commentFeedPath($feedPath, $index, $id);
    foreach (parseJsonFeed($ctx->files->read($path))?->items ?? [] as $item)
        if (is_string($reply = itemId($item)))
            dropReplies($ctx, $feedPath, $index, $reply, $depth + 1);
    if ($ctx->files->stat($path))
        $ctx->files->delete($path);
}
