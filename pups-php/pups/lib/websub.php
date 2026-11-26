<?php

namespace Pups;

/**
 * A minimal WebSub hub (https://www.w3.org/TR/websub/) for the owner's kept feeds (RFC-7 "Real-time updates").
 * pups-feeds' websub.ts is a port of this file.
 *
 * - Only the feed files of kept feeds are topics: no archives, no comment feeds. While the hub is on, the server writes
 *   `hubs` into them (archive.php) and serves them with `Link: <hub>; rel="hub", <feed>; rel="self"`.
 * - Subscribing: /pups/websub checks the request, answers 202, and verifies the intent after the response with the GET
 *   of WebSub ("Verifying intent"). Leases are at most 10 days.
 * - Distribution sends no content: each subscriber gets an empty POST with the Link header (a "thin ping") and fetches
 *   the feed itself. After an app changed a feed, the pings go out after the response, in parallel with curl where PHP
 *   has it; what doesn't fit into one request's time continues with the next request. A subscriber that answers 410 is
 *   removed; other failures change nothing.
 * - Limits: at most `maxSubscribers` subscriptions over all feeds, and 5 per callback host and feed. Callbacks on the
 *   owner's trusted domains (well-known cloud feed readers) are accepted beyond the total. The callback's domain, unlike
 *   a User-Agent or an address, can't be faked: the hub calls the callback, and it must echo a random challenge.
 *
 * Files, in data/websub/:
 *   settings.json                                   what the owner chose on the feeds page
 *   subscriptions/<topic key>/<host key>-<callback key>.json   one per subscription; its mtime is when it expires
 *   pending/<topic key>.json                         a feed whose subscribers are being notified, with the progress
 */

const HUB_PATH = '/pups/websub';
const WEBSUB_DEFAULT_MAX = 1000;
/** The highest limit the owner can set. */
const WEBSUB_MAX = 10000;
/** Subscriptions per callback host and feed. */
const WEBSUB_MAX_PER_HOST = 5;
/** Leases, in seconds: what a subscriber asks for, within these bounds; without, the longest. */
const WEBSUB_MIN_LEASE = 3600;
const WEBSUB_MAX_LEASE = 10 * 24 * 3600;
/** WebSub: `hub.secret` must be less than 200 bytes. */
const WEBSUB_MAX_SECRET = 199;
const WEBSUB_MAX_TRUSTED = 100;
const WEBSUB_PING_TIMEOUT = 5;
/** Pings sent at the same time (with curl), and read from disk at a time. */
const WEBSUB_CONCURRENCY = 10;
const WEBSUB_BATCH = 50;
/**
 * Cloud feed readers whose callbacks are always accepted, as domains (subdomains included). The owner can change the
 * list; the log names the callback host of every subscription.
 */
const TRUSTED_READERS = ['downread.com', 'feedly.com', 'inoreader.com', 'feedbin.com', 'newsblur.com', 'theoldreader.com', 'bazqux.com'];
const DOMAIN_RE = '/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/D';

function websubDir(Config $c): string
{
    return "$c->dataDir/websub";
}

function hubUrl(Config $c): string
{
    return $c->base . HUB_PATH;
}

/** The Link header of a topic: the hub and the topic itself (WebSub "Discovery"). */
function hubLinks(Config $c, string $topic): string
{
    return '<' . hubUrl($c) . '>; rel="hub", <' . $topic . '>; rel="self"';
}

/** The settings: ['enabled', 'maxSubscribers', 'trustedDomains']. What is missing or invalid takes its default. */
function websubSettings(Ctx $ctx): array
{
    if ($ctx->websub !== null)
        return $ctx->websub;
    $s = json_decode(@file_get_contents(websubDir($ctx->config) . '/settings.json') ?: '{}', true);
    $s = is_array($s) ? $s : [];
    $max = $s['maxSubscribers'] ?? null;
    return $ctx->websub = [
        'enabled' => ($s['enabled'] ?? true) !== false,
        'maxSubscribers' => is_int($max) && $max >= 0 && $max <= WEBSUB_MAX ? $max : WEBSUB_DEFAULT_MAX,
        'trustedDomains' => is_array($s['trustedDomains'] ?? null)
            ? array_values(array_filter($s['trustedDomains'], fn($d) => is_string($d) && preg_match(DOMAIN_RE, $d))) : TRUSTED_READERS,
    ];
}

function websubOn(Ctx $ctx): bool
{
    return websubSettings($ctx)['enabled'];
}

/**
 * Saves the settings of the feeds page (`websub_enabled`, `websub_max`, `websub_trusted`: domains, one per line or
 * separated by spaces or commas). Turning the hub on or off rewrites the feed files, for their `hubs`. Returns an
 * error message, or null.
 */
function saveWebsubSettings(Ctx $ctx, array $form): ?string
{
    $max = trim(field($form, 'websub_max', 10) ?? '');
    if (!preg_match('/^\d{1,5}$/D', $max) || (int) $max > WEBSUB_MAX)
        return 'The number of subscribers must be a whole number from 0 to ' . number_format(WEBSUB_MAX) . '.';
    $domains = [];
    foreach (preg_split('/[\s,]+/', strtolower(field($form, 'websub_trusted', 20000) ?? '')) as $d) {
        $d = rtrim(preg_replace('/^\*?\./', '', $d), '.');
        if ($d === '')
            continue;
        if (!preg_match(DOMAIN_RE, $d))
            return '“' . mb_substr($d, 0, 100) . '” is not a domain, such as feedly.com.';
        if (!in_array($d, $domains, true))
            $domains[] = $d;
    }
    if (count($domains) > WEBSUB_MAX_TRUSTED)
        return 'At most ' . WEBSUB_MAX_TRUSTED . ' trusted domains, please.';
    $was = websubOn($ctx);
    $s = ['enabled' => isset($form['websub_enabled']), 'maxSubscribers' => (int) $max, 'trustedDomains' => $domains];
    $dir = websubDir($ctx->config);
    if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir))
        throw new \RuntimeException("Cannot create $dir");
    writeAtomic("$dir/settings.json", json_encode($s, JSON_FLAGS), 0644);
    $ctx->websub = $s;
    Log::event('websub.settings', ['enabled' => $s['enabled'], 'maxSubscribers' => $s['maxSubscribers'], 'trusted' => count($domains)]);
    if ($was !== $s['enabled'])
        rewriteFeedFiles($ctx);
    return null;
}

/** Whether a callback host is one of the trusted domains or below one. */
function isTrustedHost(string $host, array $domains): bool
{
    foreach ($domains as $d)
        if ($host === $d || str_ends_with($host, ".$d"))
            return true;
    return false;
}

/** The storage paths of the kept feed files: declared feed files, and `<name>.json` in declared feed directories. */
function keptFeedPaths(Ctx $ctx): array
{
    $out = [];
    foreach ($ctx->config->wellKnown as $e) {
        if (!in_array(FEED_REL, $e['rels'], true))
            continue;
        $candidates = str_ends_with($e['path'], '/')
            ? array_map(fn($f) => $e['path'] . basename($f), glob(rtrim($ctx->files->abs($e['path']), '/') . '/*.json') ?: [])
            : [$e['path']];
        foreach ($candidates as $p)
            if (isFeedPath($p, $ctx->config) && isKeptFile($ctx, $p))
                $out[$p] = true;
    }
    return array_keys($out);
}

/** Writes the kept feed files again without changing their items, so that their `hubs` follow the setting. */
function rewriteFeedFiles(Ctx $ctx): void
{
    foreach (keptFeedPaths($ctx) as $path)
        $ctx->files->locked(function () use ($ctx, $path) {
            $stored = parseJsonFeed($ctx->files->read($path));
            if (isKept($stored))
                (new KeptFeed($ctx, $path, $stored))->commit();
        });
}

// --- Subscriptions -------------------------------------------------------------------------------

function topicDir(Ctx $ctx, string $topic): string
{
    return websubDir($ctx->config) . '/subscriptions/' . refId('topic', $topic);
}

function subscriptionFile(Ctx $ctx, string $topic, string $host, string $callback): string
{
    return topicDir($ctx, $topic) . '/' . refId('host', $host) . '-' . refId('callback', $callback) . '.json';
}

/** A subscription that hasn't expired, or null. */
function readSubscription(Ctx $ctx, string $file): ?array
{
    $s = json_decode(@file_get_contents($file) ?: 'null', true);
    return is_array($s) && is_string($s['callback'] ?? null) && ($s['expiresAt'] ?? 0) > $ctx->now() ? $s : null;
}

/** The subscriptions that haven't expired, by glob: a subscription file's mtime is when it expires. */
function countSubscriptions(Ctx $ctx, string $pattern): int
{
    $now = intdiv($ctx->now(), 1000);
    return count(array_filter(glob($pattern) ?: [], fn($f) => @filemtime($f) > $now));
}

/** Throws 403 if a new subscription would exceed a limit. Renewals always pass. */
function checkRoom(Ctx $ctx, array $i): void
{
    $file = subscriptionFile($ctx, $i['topic'], $i['host'], $i['callback']);
    if (readSubscription($ctx, $file))
        return;
    if (countSubscriptions($ctx, topicDir($ctx, $i['topic']) . '/' . refId('host', $i['host']) . '-*.json') >= WEBSUB_MAX_PER_HOST)
        throw new HttpError(403, 'too_many_subscriptions', "$i[host] has " . WEBSUB_MAX_PER_HOST . ' subscriptions to this feed already');
    $s = websubSettings($ctx);
    if (!isTrustedHost($i['host'], $s['trustedDomains']) && countSubscriptions($ctx, websubDir($ctx->config) . '/subscriptions/*/*.json') >= $s['maxSubscribers'])
        throw new HttpError(403, 'subscriber_limit', 'This hub takes no more subscribers. Poll the feed instead.');
}

/** The host of a callback URL, if the hub may call it: http(s), no credentials, no fragment, not the owner's host. */
function callbackHost(string $callback, Config $c): ?string
{
    if (strlen($callback) > Limits::URL || preg_match('/[\s#\x00-\x1f\x7f]/', $callback) || !preg_match('#^https?://#i', $callback))
        return null;
    $p = parse_url($callback);
    $host = is_array($p) && is_string($p['host'] ?? null) ? strtolower(trim($p['host'], '[]')) : '';
    return $host === '' || isset($p['user']) || isset($p['pass']) || $host === strtolower($c->rpId) ? null : $host;
}

/** A topic as the hub knows it, the feed file's public URL, if `url` names a kept feed file of this server. */
function websubTopic(Ctx $ctx, string $url): ?string
{
    $path = ownerStoragePath($url, $ctx->config);
    return $path !== null && isFeedPath($path, $ctx->config) && isKeptFile($ctx, $path) ? publicUrl($path, $ctx->config) : null;
}

/**
 * /pups/websub (WebSub "Subscriber Sends Subscription Request"): checks the request, answers 202 and verifies the
 * intent after the response. Not there while the hub is off.
 */
function hubEndpoint(Request $req, Ctx $ctx): ?Response
{
    if (!websubOn($ctx))
        return null;
    if ($req->method !== 'POST')
        throw methodNotAllowed('POST');
    if (!$req->isForm())
        throw new HttpError(415, 'unsupported_type', 'Send the request form-encoded (application/x-www-form-urlencoded)');
    $form = $req->form();
    $one = fn(string $k) => is_string($form[$k][0] ?? null) ? $form[$k][0] : null;
    $mode = $one('hub.mode');
    if ($mode !== 'subscribe' && $mode !== 'unsubscribe')
        throw new HttpError(400, 'invalid_request', 'hub.mode must be subscribe or unsubscribe');
    $callback = $one('hub.callback') ?? '';
    $host = callbackHost($callback, $ctx->config)
        ?? throw new HttpError(400, 'invalid_request', 'hub.callback must be an http or https URL of another host, at most ' . Limits::URL . ' characters, without a fragment');
    $topicUrl = $one('hub.topic') ?? '';
    $topic = strlen($topicUrl) <= Limits::URL ? websubTopic($ctx, $topicUrl) : null;
    if ($topic === null)
        throw new HttpError(400, 'invalid_request', 'hub.topic must be the URL of a feed file of this server, not an archive or a comment feed');
    $lease = $one('hub.lease_seconds');
    if ($lease !== null && !preg_match('/^\d{1,10}$/D', $lease))
        throw new HttpError(400, 'invalid_request', 'hub.lease_seconds must be a number of seconds');
    $secret = $one('hub.secret');
    if ($secret !== null && strlen($secret) > WEBSUB_MAX_SECRET)
        throw new HttpError(400, 'invalid_request', 'hub.secret must be less than ' . (WEBSUB_MAX_SECRET + 1) . ' bytes');
    $intent = ['mode' => $mode, 'topic' => $topic, 'callback' => $callback, 'host' => $host,
        'lease' => $lease === null ? WEBSUB_MAX_LEASE : min(WEBSUB_MAX_LEASE, max(WEBSUB_MIN_LEASE, (int) $lease)),
        'secret' => $mode === 'subscribe' && $secret !== null && $secret !== '' ? $secret : null];
    if ($mode === 'subscribe')
        checkRoom($ctx, $intent);
    $ctx->afterResponse[] = fn() => verifyIntent($ctx, $intent);
    return new Response(202, ['Content-Type' => 'text/plain; charset=utf-8'], "The request will be verified at the callback.\n");
}

/**
 * Verifies an intent (WebSub "Hub Verifies Intent of the Subscriber"): the callback must echo the challenge. Then the
 * subscription is stored, renewed or removed; a new one only if there is still room. Returns whether it worked.
 */
function verifyIntent(Ctx $ctx, array $i): bool
{
    $challenge = randomToken(24);
    $query = http_build_query(['hub.mode' => $i['mode'], 'hub.topic' => $i['topic'], 'hub.challenge' => $challenge]
        + ($i['mode'] === 'subscribe' ? ['hub.lease_seconds' => $i['lease']] : []), '', '&', PHP_QUERY_RFC3986);
    $log = ['topic' => $i['topic'], 'callbackHost' => $i['host']];
    $reason = null;
    try {
        $r = ($ctx->http)($i['callback'] . (str_contains($i['callback'], '?') ? '&' : '?') . $query);
        $ok = $r['status'] >= 200 && $r['status'] < 300;
        if (!$ok || trim($r['body'] ?? '') !== $challenge)
            $reason = $ok ? 'wrong challenge' : "HTTP $r[status]";
    } catch (\Throwable $e) {
        $reason = $e->getMessage();
    }
    if ($reason !== null) {
        Log::event('websub.unverified', $log + ['mode' => $i['mode'], 'reason' => $reason]);
        return false;
    }
    $file = subscriptionFile($ctx, $i['topic'], $i['host'], $i['callback']);
    if ($i['mode'] === 'unsubscribe') {
        @unlink($file);
        Log::event('websub.unsubscribed', $log);
        return true;
    }
    try {
        checkRoom($ctx, $i);
    } catch (HttpError $e) {
        Log::event('websub.refused', $log + ['reason' => $e->error]);
        return false;
    }
    $old = readSubscription($ctx, $file);
    $now = $ctx->now();
    $expires = $now + $i['lease'] * 1000;
    if (!is_dir(dirname($file)) && !@mkdir(dirname($file), 0755, true) && !is_dir(dirname($file)))
        throw new \RuntimeException('Cannot create ' . dirname($file));
    writeAtomic($file, json_encode(['topic' => $i['topic'], 'callback' => $i['callback'], 'host' => $i['host']]
        + ($i['secret'] !== null ? ['secret' => $i['secret']] : []) + ['expiresAt' => $expires, 'createdAt' => $old['createdAt'] ?? $now], JSON_FLAGS), 0600);
    @touch($file, intdiv($expires, 1000));
    Log::event($old ? 'websub.renewed' : 'websub.subscribed', $log + ['lease' => $i['lease'], 'trusted' => isTrustedHost($i['host'], websubSettings($ctx)['trustedDomains'])]);
    return true;
}

/** The number of subscriptions that haven't expired, and how many of them are on trusted domains, for the feeds page. */
function subscriptionStats(Ctx $ctx): array
{
    $total = $trusted = 0;
    $domains = websubSettings($ctx)['trustedDomains'];
    foreach (glob(websubDir($ctx->config) . '/subscriptions/*/*.json') ?: [] as $f)
        if ($s = readSubscription($ctx, $f)) {
            $total++;
            $trusted += isTrustedHost($s['host'] ?? '', $domains) ? 1 : 0;
        }
    return ['total' => $total, 'trusted' => $trusted];
}

// --- Distribution --------------------------------------------------------------------------------

/** After an app changed a kept feed: its subscribers are notified after the response (and the next requests). */
function websubChanged(Ctx $ctx, string $path): void
{
    if (!websubOn($ctx))
        return;
    $topic = publicUrl($path, $ctx->config);
    $dir = websubDir($ctx->config) . '/pending';
    if (!glob(topicDir($ctx, $topic) . '/*.json'))
        return;
    if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir))
        throw new \RuntimeException("Cannot create $dir");
    writeAtomic("$dir/" . refId('topic', $topic) . '.json', json_encode(['topic' => $topic, 'changedAt' => $ctx->now(), 'cursor' => ''], JSON_FLAGS), 0644);
}

/** Whether subscribers wait for a ping. */
function websubPending(Ctx $ctx): bool
{
    return (bool) glob(websubDir($ctx->config) . '/pending/*.json') && websubOn($ctx);
}

/**
 * Notifies the subscribers of the changed feeds, within a time budget, in the order of their files; the progress is
 * kept, so that the next request continues. A feed that changes again starts over. Only one worker runs at a time.
 * Returns the number of pings sent.
 */
function websubWork(Ctx $ctx, float $budget = 50.0): int
{
    $dir = websubDir($ctx->config);
    $lock = @fopen("$dir/worker.lock", 'c');
    if (!$lock || !flock($lock, LOCK_EX | LOCK_NB))
        return 0;
    $start = microtime(true);
    $sent = 0;
    try {
        // At least one batch per run, also without time left.
        foreach (glob("$dir/pending/*.json") ?: [] as $pendingFile) {
            if ($sent && microtime(true) - $start >= $budget)
                break;
            do {
                $job = json_decode(@file_get_contents($pendingFile) ?: 'null', true);
                if (!is_array($job) || !is_string($job['topic'] ?? null)) {
                    @unlink($pendingFile);
                    break;
                }
                $files = glob(topicDir($ctx, $job['topic']) . '/*.json') ?: [];
                sort($files, SORT_STRING);
                $files = array_slice(array_values(array_filter($files, fn($f) => strcmp(basename($f), $job['cursor'] ?? '') > 0)), 0, WEBSUB_BATCH);
                $subs = [];
                foreach ($files as $f)
                    if ($s = readSubscription($ctx, $f))
                        $subs[$f] = $s;
                    else
                        @unlink($f);
                $statuses = $subs ? ($ctx->ping)(array_map(fn($s) => ['url' => $s['callback'], 'headers' => ['Link' => hubLinks($ctx->config, $job['topic'])]
                    + (isset($s['secret']) ? ['X-Hub-Signature' => 'sha256=' . hash_hmac('sha256', '', $s['secret'])] : [])], array_values($subs))) : [];
                foreach (array_keys($subs) as $n => $f) {
                    $status = $statuses[$n] ?? 0;
                    if ($status === 410) {
                        @unlink($f);
                        Log::event('websub.gone', ['topic' => $job['topic'], 'callbackHost' => $subs[$f]['host'] ?? null]);
                    } elseif ($status < 200 || $status >= 300)
                        Log::event('websub.failed', ['topic' => $job['topic'], 'callbackHost' => $subs[$f]['host'] ?? null, 'status' => $status]);
                }
                $sent += count($subs);
                // Another change meanwhile: that job starts over and stays.
                $now = json_decode(@file_get_contents($pendingFile) ?: 'null', true);
                if (($now['changedAt'] ?? null) !== $job['changedAt'])
                    continue;
                if (!$files) {
                    @unlink($pendingFile);
                    Log::event('websub.notified', ['topic' => $job['topic']]);
                    break;
                }
                writeAtomic($pendingFile, json_encode(['cursor' => basename(end($files))] + $job, JSON_FLAGS), 0644);
            } while (microtime(true) - $start < $budget);
        }
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
    return $sent;
}

/**
 * The default pings: POSTs with an empty body, public addresses only, no redirects. In parallel with curl_multi where
 * PHP has curl, else one after the other. `requests` are ['url', 'headers']; returns their statuses (0 for errors).
 */
function websubPinger(Config $c): callable
{
    return function (array $requests) use ($c): array {
        if (!function_exists('curl_multi_init'))
            return array_map(function ($r) use ($c) {
                try {
                    return httpRequest('POST', $r['url'], $r['headers'], '', ['publicOnly' => !$c->allowPrivateClients, 'extraCa' => $c->extraCa,
                        'maxBytes' => 1024, 'timeout' => WEBSUB_PING_TIMEOUT])['status'];
                } catch (\Throwable) {
                    return 0;
                }
            }, $requests);
        return curlPings($c, $requests);
    };
}

function curlPings(Config $c, array $requests): array
{
    $out = array_fill(0, count($requests), 0);
    $mh = curl_multi_init();
    $running = [];
    $next = 0;
    $ca = caBundle($c->extraCa);
    $add = function (int $n) use ($c, $requests, $mh, &$running, $ca) {
        $url = $requests[$n]['url'];
        $p = parse_url($url);
        $host = trim($p['host'] ?? '', '[]');
        $port = $p['port'] ?? (strtolower($p['scheme'] ?? '') === 'https' ? 443 : 80);
        $ips = filter_var($host, FILTER_VALIDATE_IP) ? [$host] : resolveHost($host);
        if (!$ips || (!$c->allowPrivateClients && array_filter($ips, fn($ip) => !isPublicAddress($ip))))
            return;
        usort($ips, fn($a, $b) => str_contains($a, ':') <=> str_contains($b, ':'));
        $headers = ['Content-Length: 0', 'Expect:'];
        foreach ($requests[$n]['headers'] as $k => $v)
            $headers[] = "$k: $v";
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true, CURLOPT_POSTFIELDS => '', CURLOPT_HTTPHEADER => $headers, CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_TIMEOUT => WEBSUB_PING_TIMEOUT, CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_USERAGENT => 'pups-php/' . VERSION,
            // Pinned to the address that was checked, so that DNS can't change it in between.
            CURLOPT_RESOLVE => ["$host:$port:" . (str_contains($ips[0], ':') ? "[$ips[0]]" : $ips[0])],
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS, CURLOPT_WRITEFUNCTION => fn($ch, $data) => strlen($data),
        ] + ($ca ? [CURLOPT_CAINFO => $ca] : []));
        curl_multi_add_handle($mh, $ch);
        $running[spl_object_id($ch)] = [$ch, $n];
    };
    do {
        while (count($running) < WEBSUB_CONCURRENCY && $next < count($requests))
            $add($next++);
        if (!$running)
            break;
        curl_multi_exec($mh, $active);
        if ($active)
            curl_multi_select($mh, 1.0);
        while ($info = curl_multi_info_read($mh)) {
            [$ch, $n] = $running[spl_object_id($info['handle'])];
            $out[$n] = $info['result'] === CURLE_OK ? (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE) : 0;
            curl_multi_remove_handle($mh, $ch);
            unset($running[spl_object_id($info['handle'])]);
        }
    } while ($running || $next < count($requests));
    curl_multi_close($mh);
    return $out;
}
