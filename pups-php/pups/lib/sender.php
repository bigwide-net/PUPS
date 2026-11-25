<?php

namespace Pups;

/**
 * Sending mentions (RFC-11 "Sending") for the comments that the server publishes: a reply
 * mention to the author of the item a comment answers, unless that item opted out with RFC-4
 * `notifyReplies: false`, and a mention by name to every handle in the comment. They wait in the
 * receiver's queue (handler/mentions.php) as jobs of the kind `send`, whose files start with
 * `out.`, and are sent when it is worked through; a delivery that fails for a reason that may
 * pass is tried again later. A port of pups-inbox's sender.ts.
 */

/** At most this many accounts are notified per comment (RFC-11 "Both"). */
const MAX_MENTION_ACCOUNTS = 20;
/** At most this many mentions wait to be sent. */
const MAX_SENDS = 200;
/** The file names of send jobs start with this; those of incoming webmentions with a base64url hash, which has no dot. */
const SEND_PREFIX = 'out.';
/** How long a domain's mention endpoint, or that it has none, is remembered (RFC-11 "Discovery"). */
const DISCOVERY_KEEP_MS = 3600_000;
/** The waits before the retries of a delivery that failed with a network error, a 5xx or a 429: about a day (RFC-11 "When"). */
const RETRY_MS = [120_000, 900_000, 3600_000, 14_400_000, 43_200_000];
const SEND_TIMEOUT = 10;

/** The default POST of a mention: public addresses only, no redirects. */
function mentionHttp(Config $c): callable
{
    return fn(string $url, array $headers, string $body) => httpRequest('POST', $url, $headers, $body,
        ['publicOnly' => !$c->allowPrivateClients, 'extraCa' => $c->extraCa, 'maxBytes' => 16_384, 'timeout' => SEND_TIMEOUT]);
}

/**
 * Whom a published comment notifies, as [host => target] (RFC-11 "Who is mentioned"): the author
 * of the item it answers, with that item as the target, unless the item opted out; and the handles
 * in its title and text, with the domain's root. Never the comment's own author nor the owner,
 * every host once, at most 20.
 */
function notified(Ctx $ctx, \stdClass $comment, ?\stdClass $answered): array
{
    $str = fn($v) => is_string($v) ? $v : null;
    $skip = [ownerHost($ctx->config), accountHost($str($comment->_source->accounts->socialspec ?? null))];
    $out = [];
    $inReplyTo = $str($comment->_source->inReplyTo ?? null);
    $author = accountHost($str($answered->_source->accounts->socialspec ?? null));
    if ($inReplyTo !== null && splitRef($inReplyTo)[1] !== null && $author !== null && !in_array($author, $skip, true)
        && ($answered->_commenting->notifyReplies ?? null) !== false)
        $out[$author] = $inReplyTo;
    $text = handleText(['title' => $str($comment->title ?? null), 'html' => $str($comment->content_html ?? null), 'text' => $str($comment->content_text ?? null)]);
    foreach (handles($text) as $host)
        if (!in_array($host, $skip, true) && !isset($out[$host]))
            $out[$host] = "https://$host/";
    return array_slice($out, 0, MAX_MENTION_ACCOUNTS, true);
}

/**
 * Queues the mentions of comments that were published, changed or deleted, each
 * ['address', 'before', 'after', 'answered'] (versions and the answered item may be null): to
 * every account that the version before or after notifies, so that the receivers add, update or
 * remove them (RFC-11 "Edits and deletes").
 */
function queueMentions(Ctx $ctx, array $changes): void
{
    $dir = mentionsDir($ctx->config) . '/queue';
    foreach ($changes as $ch) {
        $all = [];
        foreach (['before', 'after'] as $v)
            if (($ch[$v] ?? null) instanceof \stdClass)
                foreach (notified($ctx, $ch[$v], $ch['answered'] ?? null) as $host => $target)
                    $all["$host $target"] = [$host, $target];
        foreach ($all as [$host, $target]) {
            if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir))
                throw new \RuntimeException("Cannot create $dir");
            $file = "$dir/" . SEND_PREFIX . refId('send', $ch['address'], $target) . '.json';
            if (!is_file($file) && count(glob("$dir/" . SEND_PREFIX . '*.json') ?: []) >= MAX_SENDS) {
                Log::event('send.dropped', ['source' => $ch['address'], 'target' => $target, 'reason' => 'too many mentions waiting']);
                continue;
            }
            writeAtomic($file, json_encode(['kind' => 'send', 'source' => $ch['address'], 'target' => $target, 'host' => $host,
                'receivedAt' => $ctx->now(), 'attempts' => 0], JSON_FLAGS), 0644);
            $ctx->workPending = true;
        }
    }
}

/**
 * A domain's mention endpoint (RFC-11 "Discovery"): the first link with the relation in its
 * host-meta.json, fetched over HTTPS and from the domain itself. Remembered for an hour, as is a
 * domain without one, with the status pages.
 */
function mentionEndpointOf(Ctx $ctx, string $host): ?string
{
    $key = 'd-' . refId($host);
    $known = readStatus($ctx, $key);
    if ($known !== null)
        return $known['endpoint'] ?? null;
    $endpoint = null;
    try {
        $doc = fetchDoc($ctx, "https://$host/.well-known/host-meta.json");
        if (str_starts_with($doc['url'], 'https://') && urlHost($doc['url']) === $host) {
            $links = json_decode($doc['body'], true)['links'] ?? null;
            foreach (is_array($links) ? $links : [] as $l)
                if (is_array($l) && ($l['rel'] ?? null) === MENTION_REL) {
                    $href = $l['href'] ?? null;
                    if (isCleanUrlString($href, 2048) && preg_match('#^https://[^/?\#]+#i', $href) && !isOwnEndpoint($href, $ctx->config))
                        $endpoint = $href;
                    break;
                }
        }
    } catch (FetchError) {
    }
    writeStatus($ctx, $key, ['status' => 'discovered'] + ($endpoint !== null ? ['endpoint' => $endpoint] : []), DISCOVERY_KEEP_MS);
    return $endpoint;
}

/** Sends a queued mention (RFC-11 "Request"). Returns whether to try again later: after a network error, a 5xx or a 429. */
function processSend(Ctx $ctx, array $job): bool
{
    ['source' => $source, 'target' => $target, 'host' => $host] = $job;
    $log = fn(string $result, array $extra = []) => Log::event("send.$result", ['source' => $source, 'target' => $target, 'host' => $host] + $extra);
    $endpoint = mentionEndpointOf($ctx, $host);
    if ($endpoint === null) {
        $log('no-endpoint');
        return false;
    }
    $status = 0;
    $error = null;
    try {
        $status = (int) (($ctx->send)($endpoint, ['Content-Type' => 'application/x-www-form-urlencoded'],
            http_build_query(['source' => $source, 'target' => $target], '', '&', PHP_QUERY_RFC3986))['status'] ?? 0);
    } catch (\Throwable $e) {
        $error = $e->getMessage();
    }
    if ($status >= 200 && $status < 300) {
        $log('sent', ['status' => $status]);
        return false;
    }
    $again = !$status || $status === 429 || $status >= 500;
    $log($again ? 'failed' : 'rejected', ['status' => $status, 'error' => $error]);
    return $again;
}
