<?php

namespace Pups;

/**
 * Comment feeds (RFC-7 "Publishing comments"): the comments on the owner's posts that the owner approved
 * in the inbox, republished by this server (RFC-4 `republish: "full"`). A post of a kept feed has at
 * most one comment feed, `<feed dir>/comments/<index>.json`, newest first, and its `_source.comments`
 * (RFC-1) names it with the counts. Only comments on posts are accepted so far; replies to comments
 * will get comment feeds of their own (see commentFeedPath()).
 */

const COMMENT_POLICY_LIMIT = 1000;
/** The values of RFC-4 `republish` under which approved comments are published. */
const PUBLISHING = ['full', 'summary'];
/** An abstract (`republish: "summary"`) has at most this many characters. */
const SUMMARY_CHARS = 150;

/**
 * The post that `target` names, in a kept feed of the owner: ['path' (of the feed file), 'feed'
 * (KeptFeed), 'post', 'address', 'index'], or null if it isn't a post of a kept feed. Under the
 * storage lock if the feed is to be changed.
 */
function keptPost(Ctx $ctx, string $target): ?array
{
    $c = $ctx->config;
    [$url, $id] = splitRef($target);
    $path = $id === null ? null : ownerStoragePath($url, $c);
    $path = $path === null ? null : (isFeedPath($path, $c) ? $path : archiveOwner($path, $c));
    $stored = $path === null ? null : parseJsonFeed($ctx->files->read($path));
    if (!isKept($stored))
        return null;
    $feed = new KeptFeed($ctx, $path, $stored);
    $found = $feed->get($id);
    $index = $found ? itemIndex($found['item']) : null;
    return $index === null ? null : ['path' => $path, 'feed' => $feed, 'post' => $found['item'], 'address' => $found['address'], 'index' => $index];
}

/** The comment feed of a post as stored, or null. */
function loadCommentFeed(Ctx $ctx, array $post): ?\stdClass
{
    return parseJsonFeed($ctx->files->read(commentFeedPath($post['path'], $post['index'])));
}

/** The comment `id` as published in the comment feed of the post `target`, or null. */
function publishedComment(Ctx $ctx, string $target, string $id): ?\stdClass
{
    $post = keptPost($ctx, $target);
    foreach (($post ? loadCommentFeed($ctx, $post) : null)?->items ?? [] as $item)
        if (itemId($item) === $id)
            return $item;
    return null;
}

function isPublished(Ctx $ctx, string $target, string $id): bool
{
    return publishedComment($ctx, $target, $id) !== null;
}

/** Whether a comment as it would be republished from `inboxItem` is the published one, apart from its dates and replies. */
function isSameComment(array $inboxItem, \stdClass $published): bool
{
    $strip = function (\stdClass $c) {
        $c = deepCopy($c);
        unset($c->date_published, $c->date_modified);
        setComments($c, null);
        return canonical($c);
    };
    return $strip(commentItem($inboxItem)) === $strip($published);
}

/** The address of a comment on the post `target`: its comment feed's URL + `#id`. */
function commentAddress(Ctx $ctx, string $target, string $id): ?string
{
    $post = keptPost($ctx, $target);
    return $post ? publicUrl(commentFeedPath($post['path'], $post['index']), $ctx->config) . '#' . rawurlencode($id) : null;
}

/** A new comment feed for a post. */
function newCommentFeed(Ctx $ctx, array $post): \stdClass
{
    $c = $ctx->config;
    $title = is_string($post['post']->title ?? null) && $post['post']->title !== '' ? $post['post']->title : null;
    $feedTitle = is_string($post['feed']->doc->title ?? null) ? $post['feed']->doc->title : null;
    $url = $post['post']->url ?? null;
    return (object) [
        'version' => JSON_FEED_VERSION,
        'title' => $title !== null ? "Comments on “{$title}”" : ($feedTitle !== null ? "Comments on a post in “{$feedTitle}”" : 'Comments'),
        'home_page_url' => is_string($url) && preg_match('#^https?://#i', $url) ? $url : $c->me,
        'feed_url' => publicUrl(commentFeedPath($post['path'], $post['index']), $c),
        'user_comment' => "The comments on {$post['address']} that the owner approved, republished by a Personal Upload Server (PUPS) following "
            . FEED_SPEC . ' and https://github.com/bigwide-net/RFCs/blob/main/RFC-4-Feed-Submissions.md.',
        '_pups' => (object) ['about' => FEED_SPEC, 'pupsControlled' => true],
        'items' => [],
    ];
}

/**
 * The comment as republished (RFC-4 "What is republished"), from its inbox item: the title, the
 * content as the inbox keeps it, the author's name, link and verified account, its date, and
 * `_source.inReplyTo`. Its id is the guid of the submission. With `republish: "summary"`
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
    return json_decode(json_encode(array_filter([
        'id' => $inboxItem['id'],
        'url' => $inboxItem['url'] ?? null,
        'title' => $inboxItem['title'] ?? null,
        'content_html' => $summary ? null : $html,
        'content_text' => $summary ? sanitizeText(visibleText($html), SUMMARY_CHARS) ?? '' : null,
        'date_published' => $inboxItem['_inbox']['postDate'] ?? $inboxItem['date_published'],
        'authors' => $inboxItem['authors'] ?? null,
        '_source' => ['about' => SOURCE_ABOUT, 'inReplyTo' => $inboxItem['_inbox']['target']] + ($account ? ['accounts' => ['socialspec' => $account]] : []),
    ], fn($v) => $v !== null), FEED_JSON), false);
}

/**
 * The counts of a comment feed for `_source.comments` (RFC-1): its items, and with all replies to
 * them, as far as the items say.
 */
function commentCounts(\stdClass $doc): array
{
    $total = 0;
    foreach ($doc->items as $item)
        $total += 1 + ($item instanceof \stdClass ? (commentsOf($item)?->total ?? commentsOf($item)?->count ?? 0) : 0);
    return [count($doc->items), $total];
}

/**
 * Writes a comment feed, or deletes it when it is empty, and then the post's counts. Under the
 * storage lock.
 */
function writeCommentFeed(Ctx $ctx, array $post, \stdClass $doc): void
{
    $path = commentFeedPath($post['path'], $post['index']);
    [$count, $total] = commentCounts($doc);
    if ($count) {
        $text = json_encode($doc, FEED_JSON | JSON_PRETTY_PRINT);
        checkQuota($ctx, [$path => $text]);
        $ctx->files->write($path, $text);
    } elseif ($ctx->files->stat($path))
        $ctx->files->delete($path);
    $post['feed']->setCommentCounts(itemId($post['post']), publicUrl($path, $ctx->config), $count, $total);
    $post['feed']->commit();
    Log::event('comments.written', ['path' => $path, 'count' => $count]);
}

/**
 * Publishes an approved comment in the comment feed of its post, or replaces it there (an approved
 * edit), and updates the post's counts. It is published as its author agreed: in full, or as an
 * abstract if either the submission or the feed now says `summary`. Returns the comment's address:
 * the comment feed's URL + `#id`. Throws 409 if the post is gone, its feed isn't kept by this
 * server or doesn't publish comments anymore, or the post has as many comments as its policy allows.
 */
function publishComment(Ctx $ctx, array $inboxItem): string
{
    return $ctx->files->locked(function () use ($ctx, $inboxItem) {
        $post = keptPost($ctx, $inboxItem['_inbox']['target'] ?? '')
            ?? throw new HttpError(409, 'conflict', 'The post doesn\'t exist anymore, or its feed isn\'t kept by this server.');
        $now = $post['feed']->doc->_submissions->republish ?? null;
        if (!in_array($now, PUBLISHING, true))
            throw new HttpError(409, 'conflict', 'The feed doesn\'t publish comments anymore.');
        $doc = loadCommentFeed($ctx, $post) ?? newCommentFeed($ctx, $post);
        $comment = commentItem($inboxItem, $now === 'summary' ? 'summary' : null);
        $at = null;
        foreach ($doc->items as $p => $item)
            if (itemId($item) === $comment->id)
                $at = $p;
        if ($at === null) {
            $limit = $post['feed']->doc->_submissions->policies->comments->commentLimit ?? null;
            $limit = is_int($limit) ? $limit : COMMENT_POLICY_LIMIT;
            if (commentCounts($doc)[1] >= $limit)
                throw new HttpError(409, 'comment-limit', "The post has $limit comments, as many as the feed allows.");
            array_unshift($doc->items, $comment);
        } else {
            // An edit keeps the date of publication (RFC-4 "Edits and deletes").
            $old = $doc->items[$at];
            if (is_string($old->date_published ?? null))
                $comment->date_published = $old->date_published;
            if (($r = commentsOf($old)) !== null)
                setComments($comment, $r);
            if (canonical($comment) !== canonical((object) array_diff_key((array) $old, ['date_modified' => 0])))
                $comment->date_modified = gmdate('Y-m-d\TH:i:s\Z', intdiv($ctx->now(), 1000));
            elseif (isset($old->date_modified))
                $comment->date_modified = $old->date_modified;
            $doc->items[$at] = $comment;
        }
        writeCommentFeed($ctx, $post, $doc);
        return publicUrl(commentFeedPath($post['path'], $post['index']), $ctx->config) . '#' . rawurlencode($comment->id);
    });
}

/**
 * Removes a published comment from the comment feed of the post `target` and updates the post's
 * counts. Returns whether it was there.
 */
function unpublishComment(Ctx $ctx, string $target, string $id): bool
{
    return $ctx->files->locked(function () use ($ctx, $target, $id) {
        $post = keptPost($ctx, $target);
        $doc = $post ? loadCommentFeed($ctx, $post) : null;
        if (!$doc)
            return false;
        $before = count($doc->items);
        $doc->items = array_values(array_filter($doc->items, fn($i) => itemId($i) !== $id));
        if (count($doc->items) === $before)
            return false;
        writeCommentFeed($ctx, $post, $doc);
        return true;
    });
}
