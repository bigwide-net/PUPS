<?php

namespace Pups;

/**
 * The built-in receiver: mentions of the owner (RFC-11) at /pups/mention, linked from
 * host-meta.json, and comments on the owner's posts (RFC-4) at /pups/comments, named in
 * the feeds' `_submissions` by the client. Both go into the inbox (RFC-12). Comments on a
 * feed with `republish: "full"` or `"summary"` wait there for the owner's approval, and are then
 * published in the post's comment feed (comments.php), in full or as an abstract; with
 * `republish: "no"` (or a value this server doesn't know), the owner only reads them.
 *
 * The endpoints do the cheap checks and queue the rest in data/mentions/queue/. The queue
 * is worked through after the response has been sent (see processQueue()), because every
 * check fetches documents from other servers. The same queue holds the mentions that the server
 * sends for the comments it publishes (sender.php).
 */

const MENTION_REL = 'https://bigwide.net/ns/mention';
/** At most this many webmentions wait, and at most this many from one source host. */
const MAX_QUEUE = 100;
const MAX_QUEUE_PER_HOST = 5;
/** A job that fails this often (e.g. because it crashed the worker) is dropped. */
const MAX_ATTEMPTS = 3;
/** Comment status pages are kept this long (RFC-4: at least an hour); those of comments waiting for approval longer. */
const STATUS_KEEP_MS = 24 * 3600_000;
const PENDING_KEEP_MS = 30 * 24 * 3600_000;
/** A comment keeps its own date if it is at most this far from the time of submission (RFC-4). */
const DATE_SLACK_MS = 30 * 60_000;
/** The policy defaults of RFC-4 "Policies". */
const POLICY_DEFAULTS = ['title' => 'none', 'minLength' => 2, 'maxLength' => 2000, 'requireSocialSpec' => false, 'allowEdit' => false, 'allowDelete' => false,
    'commentLimit' => COMMENT_POLICY_LIMIT, 'maxDepth' => MAX_DEPTH_DEFAULT,
    // The features of RFC-5: a missing one is off.
    'allowStyle' => false, 'allowLinks' => false, 'allowCode' => false, 'allowQuote' => false, 'allowImages' => false, 'allowTables' => false,
    'allowLists' => false, 'allowHeadlines' => false, 'urlAutoLinking' => false];
const MAX_TITLE_CHARS = 300;

function mentionUrl(Config $c): string
{
    return "$c->base/pups/mention";
}

function commentUrl(Config $c): string
{
    return "$c->base/pups/comments";
}

function mentionsDir(Config $c): string
{
    return "$c->dataDir/mentions";
}

/** The owner's host as handles name it. */
function ownerHost(Config $c): string
{
    return strtolower($c->rpId);
}

/** Whether a URL is the owner's: on the owner's host, or served by this server for the owner. */
function isOwnerUrl(Ctx $ctx, string $url): bool
{
    return urlHost($url) === ownerHost($ctx->config) || ownerStoragePath($url, $ctx->config) !== null;
}

/** A short, stable id for inbox items and jobs. */
function refId(string ...$parts): string
{
    return substr(b64url(hash('sha256', implode("\n", $parts), true)), 0, 16);
}

/** The `source` and `target` of a webmention, form-encoded or JSON. Throws 400. */
function webmentionParams(Request $req): array
{
    if ($req->method !== 'POST')
        throw methodNotAllowed('POST, OPTIONS');
    if (str_starts_with(strtolower($req->header('content-type') ?? ''), 'application/json')) {
        $body = $req->body(Limits::JSON_BYTES) ?? throw new HttpError(413, 'too_large', 'The request body is too large');
        $j = json_decode($body, true);
        [$source, $target] = [is_array($j) ? ($j['source'] ?? null) : null, is_array($j) ? ($j['target'] ?? null) : null];
    } else {
        $form = $req->form();
        [$source, $target] = [field($form, 'source', Limits::URL), field($form, 'target', Limits::URL)];
    }
    foreach (['source' => $source, 'target' => $target] as $name => $v)
        if (!isCleanUrlString($v, Limits::URL) || !preg_match('#^https?://[^/?\#]+#i', $v))
            throw new HttpError(400, 'invalid_request', "$name must be an absolute http(s) URL of at most " . Limits::URL . ' characters');
    if ($source === $target)
        throw new HttpError(400, 'invalid_request', 'source and target must differ');
    return [$source, $target];
}

// --- Endpoints -----------------------------------------------------------------------------

/** POST /pups/mention (RFC-11 "Receiving"): checks the request, queues it and answers 202. */
function mentionEndpoint(Request $req, Ctx $ctx): ?Response
{
    $c = $ctx->config;
    if (!$c->mentions)
        return null;
    [$source, $target] = webmentionParams($req);
    if (!str_contains($target, '#') && !in_array($target, ['https://' . ownerHost($c) . '/', $c->me], true))
        throw new HttpError(400, 'invalid_request', 'target must be https://' . ownerHost($c) . '/ or a feed item (feed URL + #id)');
    enqueue($ctx, ['kind' => 'mention', 'source' => $source, 'target' => $target]);
    return json(['message' => 'Accepted. The mention is checked shortly.'], 202);
}

/**
 * POST /pups/comments (RFC-4 "Submitting"): comments on posts of the owner's feeds whose
 * `_submissions.url` is this endpoint, and replies to the comments published in their comment feeds.
 * Answers 201 with a status page.
 */
function commentEndpoint(Request $req, Ctx $ctx): ?Response
{
    $c = $ctx->config;
    if (!$c->comments)
        return null;
    [$source, $target] = webmentionParams($req);
    $post = commentTarget($ctx, $target);
    $id = 's-' . refId($source);
    $existing = findInboxItem($ctx, $id);
    if ($existing && !sameRef($existing['_inbox']['target'] ?? null, $target))
        throw new HttpError(400, 'in-reply-to-mismatch', 'This source was submitted to another post');
    // A published comment may always be sent again, to change notifyReplies (RFC-4 "Edits and deletes"); processComment() decides.
    if ($existing && !$post['policy']['allowEdit'] && !$post['policy']['allowDelete'] && !isPublished($ctx, $target, $id))
        throw new HttpError(400, 'edit-not-allowed', 'This comment was submitted already, and the feed allows neither edits nor deletes');
    try {
        // The owner's own comments don't go into the inbox.
        if (!isOwnerUrl($ctx, $source))
            checkRoomForSubmission($ctx, $id, urlHost($source));
    } catch (InboxFull $e) {
        throw new HttpError(400, 'moderation-unavailable', $e->getMessage() . ' Try again later.');
    }
    writeStatus($ctx, $id, ['status' => 'waiting']);
    enqueue($ctx, ['kind' => 'comment', 'source' => $source, 'target' => $target, 'id' => $id]);
    $statusUrl = commentUrl($c) . "/status/$id";
    return json(['status' => 'waiting', 'guid' => $id, 'statusUrl' => $statusUrl], 201, ['Location' => $statusUrl]);
}

/**
 * What a comment answers, if it may be commented on here: a post, or a comment published in a comment
 * feed of a kept feed (a reply). Returns ['policy', 'republish'] of the post's feed. Throws 400
 * otherwise (RFC-4: the cheap checks are synchronous).
 */
function commentTarget(Ctx $ctx, string $target): array
{
    [$url, $id] = splitRef($target);
    if ($id === null)
        throw new HttpError(400, 'invalid_request', 'Only comments on posts and comments are accepted: target must be a feed URL + #id');
    $path = ownerStoragePath($url, $ctx->config);
    if ($path === null)
        throw new HttpError(400, 'invalid_request', 'target is not a feed on this server');
    if (keptFileOwner($path, $ctx->config) !== null && archiveOwner($path, $ctx->config) === null) {
        // A reply: the feed's rules apply, also to the post that the thread belongs to.
        $thread = commentThread($ctx, $target) ?? throw new HttpError(400, 'target-gone', 'The comment isn\'t published (anymore)');
        $s = json_decode(json_encode($thread['feed']->doc->_submissions ?? null), true);
        [$exists, $open, $depth] = [true, allowsComments($thread['post']), $thread['depth']];
    } else {
        try {
            $found = findItem($ctx, $target);
        } catch (FetchError $e) {
            throw new HttpError(400, 'target-gone', 'The target feed can\'t be read: ' . $e->getMessage());
        }
        $s = submissionsOf($ctx, $found['feed']);
        [$exists, $open, $depth] = [(bool) $found['item'], $found['item']['allowComments'] ?? false, 1];
    }
    if (($s['url'] ?? null) !== commentUrl($ctx->config))
        throw new HttpError(400, 'invalid_request', 'This feed doesn\'t accept comments at this endpoint');
    $policy = is_array($s['policies'] ?? null) && is_array($s['policies']['comments'] ?? null) ? policy($s['policies']['comments']) : null;
    if ($policy === null)
        throw new HttpError(400, 'comments-disabled', 'This feed accepts no comments');
    if (!$exists)
        throw new HttpError(400, 'target-gone', 'The post doesn\'t exist');
    if (!$open)
        throw new HttpError(400, 'comments-disabled', 'The post is closed for comments');
    if ($depth > $policy['maxDepth'])
        throw new HttpError(400, 'max-depth', "Replies are nested at most {$policy['maxDepth']} levels deep here");
    return ['policy' => $policy, 'republish' => is_string($s['republish'] ?? null) ? $s['republish'] : 'no'];
}

/**
 * The `_submissions` that apply to a feed of the owner. For an RFC-13 archive, those of its feed
 * file at `_archive.updates_url`: archives don't carry their own (RFC-7 "Receiving comments", RFC-13).
 */
function submissionsOf(Ctx $ctx, array $feed): ?array
{
    if ($feed['updates'] === null)
        return $feed['submissions'];
    $main = resolveUrl($feed['url'], $feed['updates']);
    if (ownerStoragePath($main, $ctx->config) === null)
        return null;
    try {
        return loadFeed($ctx, $main)['submissions'];
    } catch (FetchError $e) {
        throw new HttpError(400, 'target-gone', 'The feed of the archive can\'t be read: ' . $e->getMessage());
    }
}

/** A comments policy with the defaults of RFC-4, and values of the wrong type ignored. */
function policy(array $p): array
{
    $out = POLICY_DEFAULTS;
    foreach (POLICY_DEFAULTS as $k => $default)
        if (isset($p[$k]) && gettype($p[$k]) === gettype($default) && ($k !== 'title' || in_array($p[$k], ['required', 'allowed', 'none'], true)))
            $out[$k] = $p[$k];
    $out['maxDepth'] = maxDepthOf($out['maxDepth']);
    return $out;
}

/** GET /pups/comments/status/<id> (RFC-4 "Response and status"). */
function commentStatusEndpoint(Request $req, string $id, Ctx $ctx): ?Response
{
    if (!$ctx->config->comments || !preg_match('/^s-[A-Za-z0-9_-]{16}$/D', $id))
        return null;
    if ($req->method !== 'GET' && $req->method !== 'HEAD')
        throw methodNotAllowed('GET, HEAD');
    $s = readStatus($ctx, $id) ?? throw new HttpError(404, 'not_found', 'No such submission, or its status has expired');
    return json($s, 200, ['Cache-Control' => 'no-store']);
}

function statusFile(Ctx $ctx, string $id): string
{
    return mentionsDir($ctx->config) . "/status/$id.json";
}

/** Writes a status page, kept for `keep` milliseconds; by default as long as RFC-4 asks, and longer while it is pending. */
function writeStatus(Ctx $ctx, string $id, array $status, ?int $keep = null): void
{
    @mkdir(dirname(statusFile($ctx, $id)), 0755, true);
    $keep ??= $status['status'] === 'pending' ? PENDING_KEEP_MS : STATUS_KEEP_MS;
    writeAtomic(statusFile($ctx, $id), json_encode($status + ['guid' => $id, 'expiresAt' => $ctx->now() + $keep], JSON_FLAGS), 0644);
}

function readStatus(Ctx $ctx, string $id): ?array
{
    $s = json_decode(@file_get_contents(statusFile($ctx, $id)) ?: 'null', true);
    if (!is_array($s) || ($s['expiresAt'] ?? 0) < $ctx->now())
        return null;
    unset($s['expiresAt']);
    return $s;
}

// --- Queue ---------------------------------------------------------------------------------

/**
 * Queues a job. The file name starts with a hash of the source host, so that the limit per
 * host is a glob; the same source and target replace a waiting job instead of adding one.
 */
function enqueue(Ctx $ctx, array $job): void
{
    $dir = mentionsDir($ctx->config) . '/queue';
    if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir))
        throw new \RuntimeException("Cannot create $dir");
    $hostKey = refId(urlHost($job['source']) ?? '');
    $file = "$dir/$hostKey-" . refId($job['kind'], $job['source'], $job['target']) . '.json';
    if (!is_file($file)) {
        $retry = ['Retry-After' => '60'];
        if (count(glob("$dir/*.json") ?: []) - count(glob("$dir/" . SEND_PREFIX . '*.json') ?: []) >= MAX_QUEUE)
            throw new HttpError(429, 'too_many_requests', 'Too many webmentions are waiting. Try again later.', $retry);
        if (count(glob("$dir/$hostKey-*.json") ?: []) >= MAX_QUEUE_PER_HOST)
            throw new HttpError(429, 'too_many_requests', 'Too many webmentions from this host are waiting. Try again later.', $retry);
    }
    writeAtomic($file, json_encode($job + ['receivedAt' => $ctx->now(), 'attempts' => 0], JSON_FLAGS), 0644);
    Log::event('mention.queued', ['kind' => $job['kind'], 'source' => $job['source'], 'target' => $job['target']]);
    $ctx->workPending = true;
}

function queueLength(Ctx $ctx): int
{
    return count(glob(mentionsDir($ctx->config) . '/queue/*.json') ?: []);
}

/**
 * Works through the queue, oldest first, within a time budget; mentions to send again later wait
 * until they are due. Only one worker runs at a time; a request that finds it busy leaves the jobs
 * to it. Returns the number of jobs done.
 */
function processQueue(Ctx $ctx, float $budget = 20.0, int $maxJobs = 20): int
{
    $dir = mentionsDir($ctx->config);
    if (!is_dir("$dir/queue"))
        return 0;
    $lock = fopen("$dir/worker.lock", 'c');
    if (!$lock || !flock($lock, LOCK_EX | LOCK_NB))
        return 0;
    $start = microtime(true);
    $done = 0;
    try {
        foreach (glob("$dir/status/*.json") ?: [] as $f)
            if ((json_decode(@file_get_contents($f) ?: '{}', true)['expiresAt'] ?? 0) < $ctx->now())
                @unlink($f);
        while ($done < $maxJobs && microtime(true) - $start < $budget) {
            $files = glob("$dir/queue/*.json") ?: [];
            usort($files, fn($a, $b) => (@filemtime($a) <=> @filemtime($b)) ?: strcmp($a, $b));
            [$file, $job] = [null, null];
            foreach ($files as $f) {
                $job = json_decode(@file_get_contents($f) ?: 'null', true);
                if (!is_array($job) || ($job['due'] ?? 0) <= $ctx->now()) {
                    $file = $f;
                    break;
                }
            }
            if ($file === null)
                break;
            if (!is_array($job) || ++$job['attempts'] > MAX_ATTEMPTS) {
                Log::event(($job['kind'] ?? null) === 'send' ? 'send.dropped' : 'mention.dropped', ['job' => is_array($job) ? $job : null]);
                if (is_array($job) && $job['kind'] === 'comment')
                    writeStatus($ctx, $job['id'], ['status' => 'failure', 'code' => 'moderation-unavailable', 'text' => 'The comment could not be processed.']);
                @unlink($file);
                continue;
            }
            // Counted before the work, so that a job that crashes the worker is dropped eventually.
            writeAtomic($file, json_encode($job, JSON_FLAGS), 0644);
            if ($job['kind'] === 'send') {
                $tries = ($job['tries'] ?? 0) + 1;
                if (processSend($ctx, $job) && $tries <= count(RETRY_MS))
                    writeAtomic($file, json_encode(['attempts' => 0, 'tries' => $tries, 'due' => $ctx->now() + RETRY_MS[$tries - 1]] + $job, JSON_FLAGS), 0644);
                elseif ((json_decode(@file_get_contents($file) ?: 'null', true)['receivedAt'] ?? null) === $job['receivedAt'])
                    @unlink($file);
                $done++;
                continue;
            }
            try {
                $job['kind'] === 'comment' ? processComment($ctx, $job) : processMention($ctx, $job);
            } catch (ForeignInbox $e) {
                Log::event('inbox.foreign', ['error' => $e->getMessage()]);
                if ($job['kind'] === 'comment')
                    writeStatus($ctx, $job['id'], ['status' => 'failure', 'code' => 'moderation-unavailable', 'text' => 'The owner\'s inbox is not available.']);
            }
            // A job that was queued again while it ran (an edit) stays for the next round.
            $again = json_decode(@file_get_contents($file) ?: 'null', true);
            if (!is_array($again) || $again['receivedAt'] === $job['receivedAt'])
                @unlink($file);
            $done++;
        }
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
    return $done;
}

/**
 * Lets the client go before the queue is worked through: PHP-FPM and LiteSpeed can end the
 * response early; elsewhere the response has a Content-Length, so clients don't wait for
 * the connection to close, and ignore_user_abort() keeps PHP running.
 */
function finishResponse(): string
{
    ignore_user_abort(true);
    if (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request();
        return 'fastcgi_finish_request';
    }
    if (function_exists('litespeed_finish_request')) {
        litespeed_finish_request();
        return 'litespeed_finish_request';
    }
    while (ob_get_level())
        ob_end_flush();
    flush();
    return 'flush';
}

// --- Mentions (RFC-11 "Verifying") -------------------------------------------------------------

function processMention(Ctx $ctx, array $job): void
{
    $c = $ctx->config;
    ['source' => $source, 'target' => $target] = $job;
    $reply = str_contains($target, '#');
    $id = ($reply ? 'r-' : 'm-') . refId($source, $target);
    $log = fn(string $result, array $extra = []) => Log::event("mention.$result", ['source' => $source, 'target' => $target] + $extra);
    try {
        $found = findItem($ctx, $source);
    } catch (FetchError $e) {
        // A deleted post withdraws its mention; any other error changes nothing (RFC-11 "Delivering").
        if ($e->gone && removeInboxItem($ctx, $id))
            $log('removed', ['reason' => $e->getMessage()]);
        else
            $log('invalid', ['reason' => $e->getMessage()]);
        return;
    }
    $post = $found['item'];
    if (!$post) {
        if ($found['complete'] && removeInboxItem($ctx, $id))
            $log('removed', ['reason' => 'item not found']);
        else
            $log('invalid', ['reason' => 'item not found']);
        return;
    }
    if (urlHost($source) === ownerHost($c)) {
        $log('ignored', ['reason' => 'the owner\'s own post']);
        return;
    }
    $valid = $reply ? replyTargetsOwner($ctx, $post, $found['feed'], $target) : in_array(ownerHost($c), handles(handleText($post)), true);
    if ($valid === null) {
        $log('invalid', ['reason' => 'the target could not be checked']);
        return;
    }
    if (!$valid) {
        removeInboxItem($ctx, $id) ? $log('removed', ['reason' => 'no longer mentions the owner']) : $log('invalid', ['reason' => 'doesn\'t mention the owner']);
        return;
    }
    [$author, $account] = attribution($post, $found['feed'], $found['feed']['url']);
    try {
        putInboxItem($ctx, inboxItem($ctx, $id, $reply ? 'reply' : 'mention', $source, $target, $post, excerptHtml($post), $author, $account));
    } catch (InboxFull $e) {
        $log('refused', ['reason' => $e->getMessage()]);
        return;
    }
    $log('delivered', ['type' => $reply ? 'reply' : 'mention']);
}

/**
 * Does a post answer the target, and is the target the owner's item (RFC-11 "Verifying a
 * reply")? Null if that can't be decided now.
 */
function replyTargetsOwner(Ctx $ctx, array $post, array $feed, string $target): ?bool
{
    $c = $ctx->config;
    try {
        $t = findItem($ctx, $target);
    } catch (FetchError $e) {
        return $e->gone ? false : null;
    }
    if (!$t['item'])
        return $t['complete'] ? false : null;
    $answers = $feed['page']
        // An HTML page links to the target, or to the target item's permalink.
        ? (bool) array_filter($post['links'], fn($l) => sameRef($l, $target) || ($t['item']['url'] !== null && $l === $t['item']['url']))
        : sameRef($post['inReplyTo'], $target);
    if (!$answers)
        return false;
    [$url] = splitRef($target);
    if (urlHost($url) === ownerHost($c) || ownerStoragePath($url, $c) !== null)
        return true;
    // Republished for the owner: the item carries the owner's account, in a feed with submissions.
    if (accountHost($t['item']['account']) !== ownerHost($c))
        return false;
    try {
        return republishedFeedSubmissions($ctx, $t['feed']) !== null;
    } catch (FetchError $e) {
        return $e->gone ? false : null;
    }
}

/** How many feeds republishedFeedSubmissions follows: comment feeds up to the deepest reply, an archive, the feed file. */
const MAX_FEED_HOPS = 13;

/**
 * The RFC-4 `_submissions` that apply to a feed on another host (RFC-7 "Receiving comments"): its
 * own; for an RFC-13 archive, those of its feed file (`_archive.updates_url`); for an RFC-7 comment
 * feed, which carries none, those of the feed it belongs to, found by following `_pups.inReplyTo`
 * (a post in the feed file or an archive, or a comment in the comment feed one level up). Only
 * on the same host. Null if there are none.
 */
function republishedFeedSubmissions(Ctx $ctx, array $feed): ?array
{
    $host = urlHost($feed['url']);
    $seen = [];
    for ($hop = 0; $hop < MAX_FEED_HOPS; $hop++) {
        $seen[$feed['url']] = true;
        $next = $feed['updates'] ?? ($feed['submissions'] === null ? $feed['parent'] : null);
        if ($next === null)
            return $feed['submissions'];
        [$next] = splitRef(resolveUrl($feed['url'], $next));
        if (urlHost($next) !== $host || isset($seen[$next]))
            return null;
        $feed = loadFeed($ctx, $next);
    }
    return null;
}

/**
 * The author's name and account for the inbox (RFC-11 "Delivering", RFC-4 "Authorship"). An
 * account on the source's own host is the author's; one on another host only if the source
 * is a feed that republishes submissions, which checked it. The feed's account is the
 * author's only in a feed without submissions.
 */
function attribution(array $post, array $feed, string $sourceUrl): array
{
    $account = $post['account'] ?? ($feed['submissions'] === null ? $feed['account'] : null);
    $host = accountHost($account);
    $trusted = $host !== null && ($host === urlHost($sourceUrl) || $feed['submissions'] !== null);
    return [$post['author'] ?? urlHost($sourceUrl), $trusted ? '@' . $host : null];
}

// --- Comments (RFC-4) ------------------------------------------------------------------------

/**
 * Removes a published comment and the replies to it from the comment feeds (unpublishComment())
 * and from the inbox (those that auto-moderation published), and queues their mentions again, so
 * that receivers drop them. Returns what was removed.
 */
function withdrawComment(Ctx $ctx, string $target, string $id): array
{
    $answered = commentThread($ctx, $target)['parent'] ?? null;
    $removed = unpublishComment($ctx, $target, $id);
    $ids = array_map(fn($r) => itemId($r['item']), $removed);
    try {
        modifyInbox($ctx, function (array &$items) use ($ids) {
            $before = count($items);
            $items = array_values(array_filter($items, fn($i) => !in_array($i['id'] ?? null, $ids, true) || ($i['_inbox']['type'] ?? null) === 'submission'));
            return count($items) < $before;
        });
    } catch (ForeignInbox) {
    }
    $changes = [];
    foreach ($removed as $i => ['item' => $item, 'address' => $address]) {
        $parent = $i ? null : $answered;
        foreach ($i ? $removed : [] as $p)
            if (sameRef($p['address'], is_string($item->_source->inReplyTo ?? null) ? $item->_source->inReplyTo : null))
                $parent = $p['item'];
        $changes[] = ['address' => $address, 'before' => $item, 'answered' => $parent];
    }
    queueMentions($ctx, $changes);
    return $removed;
}

/** Puts a comment that auto-moderation published into the inbox. It is published already, so a full inbox only skips it. */
function notifyPublished(Ctx $ctx, array $item): void
{
    try {
        putInboxItem($ctx, $item);
    } catch (InboxFull | ForeignInbox $e) {
        Log::event('comment.not-notified', ['id' => $item['id'], 'reason' => $e->getMessage()]);
    }
}

function processComment(Ctx $ctx, array $job)
{
    ['source' => $source, 'target' => $target, 'id' => $id] = $job;
    $fail = function (string $code, string $text) use ($ctx, $id, $source) {
        writeStatus($ctx, $id, ['status' => 'failure', 'code' => $code, 'text' => $text]);
        Log::event('comment.rejected', ['source' => $source, 'code' => $code, 'text' => $text]);
    };
    try {
        $target = commentTarget($ctx, $target) + ['ref' => $target];
    } catch (HttpError $e) {
        return $fail($e->error === 'invalid_request' ? 'target-gone' : $e->error, $e->getMessage());
    }
    $policy = $target['policy'];
    $existing = findInboxItem($ctx, $id);
    $published = publishedComment($ctx, $target['ref'], $id);
    try {
        $found = findItem($ctx, $source);
        $gone = !$found['item'] && $found['complete'];
    } catch (FetchError $e) {
        if (!$e->gone)
            return $fail('fetch-failed', $e->getMessage());
        $gone = true;
    }
    if ($gone) {
        if (($existing || $published) && $policy['allowDelete']) {
            removeInboxItem($ctx, $id);
            if ($published)
                withdrawComment($ctx, $target['ref'], $id);
            writeStatus($ctx, $id, ['status' => 'deleted']);
            Log::event('comment.deleted', ['source' => $source]);
            return;
        }
        return $fail('item-not-found', 'The comment is not in the author feed.');
    }
    $post = $found['item'];
    if (!$post)
        return $fail($found['feed']['page'] ? 'invalid-feed' : 'ambiguous-source', 'The comment could not be found in the author feed.');
    if ($found['feed']['page'])
        return $fail('invalid-feed', 'The author feed must be an RSS 2.0 or JSON Feed.');
    $editNotAllowed = fn() => $fail('edit-not-allowed', 'This comment was submitted already, and the feed doesn\'t allow edits.');
    // An edit of a published comment that changes only notifyReplies is allowed anyway, so that is decided below.
    if ($existing && !$published && !$policy['allowEdit'])
        return $editNotAllowed();
    if ($post['inReplyTo'] === null)
        return $fail('in-reply-to-missing', 'The comment has no inReplyTo.');
    if ($target['republish'] === 'summary' && !(is_string($post['url'] ?? null) && preg_match('#^https?://#i', $post['url']) && isCleanUrlString($post['url'])))
        return $fail('link-missing', 'Only an abstract of the comment is published here, so it needs a link to its full text.');
    if (!sameRef($post['inReplyTo'], $target['ref']))
        return $fail('in-reply-to-mismatch', 'The comment\'s inReplyTo is not the post it was submitted to.');
    $account = $post['account'] ?? $found['feed']['account'];
    $sourceHost = urlHost($found['feed']['url']);
    if ($policy['requireSocialSpec'] && $account === null)
        return $fail('socialspec-missing', 'The comment needs a socialspec account.');
    if ($account !== null && accountHost($account) !== $sourceHost) {
        if ($policy['requireSocialSpec'])
            return $fail('socialspec-mismatch', 'The socialspec account must be on the host of the author feed.');
        $account = null;
    }
    $title = sanitizeText($post['title'], 1000);
    if ($policy['title'] === 'required' && $title === null)
        return $fail('title-required', 'The comment needs a title.');
    if ($policy['title'] === 'none' && $title !== null)
        return $fail('title-not-allowed', 'Comments here have no title.');
    if ($title !== null && mb_strlen($title) > MAX_TITLE_CHARS)
        return $fail('title-too-long', 'The title is longer than ' . MAX_TITLE_CHARS . ' characters.');
    // The content as RFC-5 allows it with the policy's features, normalized; it is what the inbox shows and what is published.
    $content = commentContent($post, $policy);
    if (isset($content['code']))
        return $fail($content['code'], $content['text']);

    $now = $ctx->now();
    $date = $post['date'] !== null && abs(strtotime($post['date']) * 1000 - $now) <= DATE_SLACK_MS ? $post['date'] : gmdate('Y-m-d\TH:i:s\Z', intdiv($now, 1000));
    // Published after the owner approves it, in full or as an abstract, and only in a kept feed, which has comment feeds.
    $approve = in_array($target['republish'], PUBLISHING, true) && commentThread($ctx, $target['ref']) !== null;
    $item = inboxItem($ctx, $id, 'submission', $source, $target['ref'], ['date' => $date] + $post, $content['html'],
        $post['author'] ?? $sourceHost, $account === null ? null : '@' . accountHost($account), $approve ? $target['republish'] : null, (bool) $published);
    if ($content['markdown'] !== null)
        $item['_source'] = ['about' => SOURCE_ABOUT] + ($item['_source'] ?? []) + ['markdown' => $content['markdown']];
    if (!$post['notifyReplies'])
        $item['_commenting'] = ['about' => COMMENTING_ABOUT, 'notifyReplies' => false];
    if ($published && isSameComment($item, $published)) {
        // Sent again without a change: nothing to approve.
        removeInboxItem($ctx, $id);
        writeStatus($ctx, $id, ['status' => 'success', 'pubDate' => $published->date_published ?? $date, 'pubUrl' => commentAddress($ctx, $target['ref'], $id)]);
        Log::event('comment.unchanged', ['source' => $source, 'target' => $target['ref']]);
        return;
    }
    // Published without review: the owner's own comment, one that auto-moderation finds acceptable, or a change of notifyReplies.
    // Returns the comment's address once it is published.
    $publishNow = function (string $why, array $extra = []) use ($ctx, $id, $item, $published, $date, $approve, $source, $target, $fail) {
        removeInboxItem($ctx, $id);
        $pubDate = $published->date_published ?? $date;
        if (!$approve) {
            writeStatus($ctx, $id, ['status' => 'success', 'pubDate' => $pubDate]);
            Log::event("comment.$why", ['source' => $source, 'target' => $target['ref'], 'published' => false] + $extra);
            return null;
        }
        try {
            $url = publishComment($ctx, $item, $after);
        } catch (HttpError $e) {
            $fail($e->error === 'conflict' ? 'target-gone' : $e->error, $e->getMessage());
            return null;
        }
        if ($why !== 'notify-replies')
            queueMentions($ctx, [['address' => $url, 'before' => $published, 'after' => $after, 'answered' => commentThread($ctx, $target['ref'])['parent'] ?? null]]);
        writeStatus($ctx, $id, ['status' => 'success', 'pubDate' => $pubDate, 'pubUrl' => $url]);
        Log::event("comment.$why", ['source' => $source, 'target' => $target['ref'], 'published' => true, 'url' => $url] + $extra);
        return $url;
    };
    // A change of notifyReplies alone needs neither approval nor allowEdit (RFC-4 "Edits and deletes"), and changes no mentions.
    if ($published && isSameComment($item, $published, true)) {
        $publishNow('notify-replies');
        return;
    }
    if ($published && !$policy['allowEdit'])
        return $editNotAllowed();
    // The owner's own comment needs no approval: it is published at once, and never goes into the inbox.
    if (isOwnerUrl($ctx, $source) && isOwnerUrl($ctx, $found['feed']['url'])) {
        $publishNow('own');
        return;
    }
    if ($approve && moderationActive($settings = moderationSettings($ctx))) {
        preg_match_all('/(?:href|src)="([^"]+)"/', $content['html'], $links);
        $parent = commentThread($ctx, $target['ref'])['post'] ?? null;
        $rating = moderateComment($ctx, $settings, [
            'text' => visibleText($content['html']), 'title' => $title, 'author' => $post['author'], 'account' => $account === null ? null : '@' . accountHost($account),
            'url' => $post['url'], 'links' => array_values(array_unique(array_map('html_entity_decode', $links[1]))),
            'postTitle' => is_string($parent->title ?? null) ? $parent->title : null, 'postUrl' => is_string($parent->url ?? null) ? $parent->url : null,
        ]);
        if (moderationApproves($settings, $rating)) {
            $url = $publishNow('auto-approved', ['safe' => $rating['safe']]);
            // The owner sees it in the inbox, where they can reject it, unless they turned that off.
            if ($url !== null && $settings['notify'])
                notifyPublished($ctx, publishedItem($ctx, $item, $url, $rating));
            return;
        }
        if ($rating !== null)
            $item = withModerationNote($item, $rating);
    }
    try {
        putInboxItem($ctx, $item);
    } catch (InboxFull $e) {
        return $fail('moderation-unavailable', $e->getMessage());
    }
    writeStatus($ctx, $id, $approve ? ['status' => 'pending'] : ['status' => 'success', 'pubDate' => $date]);
    Log::event('comment.delivered', ['source' => $source, 'target' => $target['ref'], 'edit' => $existing || $published, 'approve' => $approve]);
}

// --- Discovery -----------------------------------------------------------------------------

function mentionLink(Config $c): object
{
    return (object) ['rel' => MENTION_REL, 'href' => mentionUrl($c)];
}

/**
 * Adds the mention link to a stored host-meta.json, once: at the first request with mentions
 * on. If the owner removes it later, it stays removed. Without a stored file, the generated
 * one contains it (defaultHostMeta()).
 */
function ensureMentionLink(Ctx $ctx): void
{
    $c = $ctx->config;
    $marker = "$c->dataDir/mention-link.json";
    if (!$c->mentions || is_file($marker))
        return;
    try {
        modifyHostMeta($ctx, function (object $doc) use ($c) {
            foreach ($doc->links ?? [] as $l)
                if (is_object($l) && ($l->rel ?? null) === MENTION_REL)
                    return false;
            $doc->links = [...($doc->links ?? []), mentionLink($c)];
            return true;
        }, false);
        writeAtomic($marker, json_encode(['href' => mentionUrl($c), 'at' => gmdate('c')], JSON_FLAGS), 0644);
    } catch (\Throwable $e) {
        Log::event('host-meta.mention-link-failed', ['error' => $e->getMessage()]);
    }
}
