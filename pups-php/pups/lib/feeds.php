<?php

namespace Pups;

/**
 * Reading the posts that mentions and comments point to: fetching them with limits, parsing
 * JSON Feed, RSS 2.0 and HTML pages (h-entry) into one shape, and finding an item by its id,
 * also in archive pages (RFC-4 "Archived items", RFC-11 "Fetching the source"). The owner's
 * own feeds are read from storage, not over HTTP.
 *
 * A parsed feed: ['url', 'title', 'account', 'submissions' (?array), 'next' (?string),
 * 'updates' (?string: the feed file of an RFC-13 archive), 'page' (true for an HTML page), 'items']. An item: ['id' (?string), 'url', 'title', 'html',
 * 'text', 'markdown', 'author', 'account', 'inReplyTo', 'date', 'allowComments', 'notifyReplies', 'links'].
 * `notifyReplies` is false if the author wants no reply mentions (RFC-4 `commenting`, RFC-11 "Opting out").
 */

const FEED_MAX_BYTES = 1024 * 1024;
const FEED_TIMEOUT = 10;
const MAX_REDIRECTS = 3;
/** Pages of a feed searched for an item, the feed itself included (RFC-4 asks for at least 10). */
const MAX_PAGES = 11;
const NS_SOURCE = 'http://source.scripting.com/';
const NS_RM = ['https://rssmention.bigwide.net/', 'http://rssmention.bigwide.net/'];
const NS_ATOM = 'http://www.w3.org/2005/Atom';
const NS_DC = 'http://purl.org/dc/elements/1.1/';
const NS_CONTENT = 'http://purl.org/rss/1.0/modules/content/';

/** A document that can't be read. `gone`: it answered 404 or 410. */
final class FetchError extends \Exception
{
    public function __construct(string $message, public bool $gone = false)
    {
        parent::__construct($message);
    }
}

/** The default fetch: GET with limits, public addresses only, no redirects (fetchDoc() follows them). */
function httpFetch(Config $c): callable
{
    return fn(string $url) => httpRequest('GET', $url, [
        'Accept' => 'application/feed+json, application/json, application/rss+xml, application/xml;q=0.9, text/html;q=0.8',
    ], '', ['publicOnly' => !$c->allowPrivateClients, 'extraCa' => $c->extraCa, 'maxBytes' => FEED_MAX_BYTES, 'timeout' => FEED_TIMEOUT]);
}

/** Splits `feed URL#id` into the URL and the decoded id (null without a fragment). */
function splitRef(string $ref): array
{
    $parts = explode('#', $ref, 2);
    return [$parts[0], isset($parts[1]) && $parts[1] !== '' ? rawurldecode($parts[1]) : null];
}

/** Do two references name the same item? The fragments are compared decoded (RFC-4). */
function sameRef(?string $a, ?string $b): bool
{
    return $a !== null && $b !== null && splitRef($a) === splitRef($b);
}

function urlHost(string $url): ?string
{
    $host = parse_url($url, PHP_URL_HOST);
    return is_string($host) ? asciiHost(trim($host, '[]')) : null;
}

/** Resolves a URL from a document (a redirect, next_url) against the document's URL. */
function resolveUrl(string $base, string $ref): string
{
    if (preg_match('#^[a-z][a-z0-9+.-]*:#i', $ref))
        return $ref;
    $p = parse_url($base);
    $origin = "$p[scheme]://$p[host]" . (isset($p['port']) ? ":$p[port]" : '');
    if (str_starts_with($ref, '//'))
        return "$p[scheme]:$ref";
    if (str_starts_with($ref, '/'))
        return $origin . $ref;
    $dir = preg_replace('#/[^/]*$#', '/', $p['path'] ?? '/');
    return $origin . $dir . $ref;
}

/** URLs of this server that it must never fetch: its own receiving endpoints. */
function isOwnEndpoint(string $url, Config $c): bool
{
    foreach (['/pups/mention', '/pups/comments', '/pups/inbox'] as $p)
        if (str_starts_with(strtolower($url), strtolower($c->base . $p)))
            return true;
    return false;
}

/**
 * The storage path of a URL that this server serves publicly (the owner's feeds and other
 * files), or null. Private files never count.
 */
function ownerStoragePath(string $url, Config $c): ?string
{
    $url = explode('#', $url, 2)[0];
    if (str_contains($url, '?'))
        return null;
    $raw = null;
    foreach ($c->wellKnown as $e)
        if ($e['url'] !== null && ($url === $e['url'] || (str_ends_with($e['url'], '/') && str_starts_with($url, $e['url']))))
            $raw = encodePath($e['path']) . substr($url, strlen($e['url']));
    foreach ([$c->publicBase, $c->storageBase] as $base)
        if ($raw === null && str_starts_with($url, $base))
            $raw = '/' . substr($url, strlen($base));
    $path = $raw === null ? null : tryParsePath($raw, $c);
    return $path !== null && !isPrivate($path) ? $path : null;
}

/** Fetches a document, following at most 3 redirects. Returns ['url' (after redirects), 'contentType', 'body']. */
function fetchDoc(Ctx $ctx, string $url): array
{
    for ($i = 0; ; $i++) {
        if (!preg_match('#^https?://[^/?\#]+#i', $url) || isOwnEndpoint($url, $ctx->config))
            throw new FetchError("Refusing to fetch $url");
        try {
            $r = ($ctx->http)($url);
        } catch (\Throwable $e) {
            throw new FetchError("$url could not be fetched: {$e->getMessage()}");
        }
        $location = $r['headers']['location'] ?? null;
        if (in_array($r['status'], [301, 302, 303, 307, 308], true) && is_string($location)) {
            if ($i >= MAX_REDIRECTS)
                throw new FetchError("$url redirects more than " . MAX_REDIRECTS . ' times');
            $url = resolveUrl($url, $location);
            continue;
        }
        if ($r['status'] === 404 || $r['status'] === 410)
            throw new FetchError("$url answered HTTP {$r['status']}", true);
        if ($r['status'] !== 200)
            throw new FetchError("$url answered HTTP {$r['status']}");
        if ($r['body'] === null)
            throw new FetchError("$url is larger than " . FEED_MAX_BYTES . ' bytes');
        return ['url' => $url, 'contentType' => strtolower(trim(explode(';', $r['headers']['content-type'] ?? '')[0])), 'body' => $r['body']];
    }
}

/** A feed or HTML page by URL: read from storage if this server serves it, else fetched. Throws FetchError. */
function loadFeed(Ctx $ctx, string $url): array
{
    $path = ownerStoragePath($url, $ctx->config);
    if ($path !== null) {
        $body = $ctx->files->read($path);
        if ($body === null)
            throw new FetchError("$url doesn't exist", true);
        $doc = ['url' => $url, 'contentType' => '', 'body' => $body];
    } else
        $doc = fetchDoc($ctx, $url);
    $feed = parseFeed($doc['body']) ?? (str_contains($doc['contentType'], 'html') || preg_match('/^\s*<(!doctype html|html)/i', $doc['body']) ? parseHtmlPage($doc['body']) : null);
    if ($feed === null)
        throw new FetchError("$url is neither a JSON Feed, an RSS 2.0 feed nor an HTML page");
    if ($feed['page'])
        foreach ($feed['items'] as &$item) {
            $item['links'] = array_map(fn($l) => resolveUrl($doc['url'], $l), $item['links']);
            $item['inReplyTo'] = $item['inReplyTo'] === null ? null : resolveUrl($doc['url'], $item['inReplyTo']);
            $item['url'] = $item['url'] === null ? $doc['url'] : resolveUrl($doc['url'], $item['url']);
        }
    unset($item);
    return ['url' => $doc['url']] + $feed;
}

/**
 * Finds the item that a reference (`feed URL#id`) names. Without a fragment, it is the only
 * item of the feed, or the post of an HTML page. Returns ['feed' (the first page), 'item'
 * (?array), 'complete']: `complete` is false if the search gave up early (a page limit, an
 * error, another host, no fragment in a feed with several items), so that a missing item
 * isn't taken as deleted. Throws FetchError if the feed itself can't be read.
 */
function findItem(Ctx $ctx, string $ref): array
{
    [$url, $id] = splitRef($ref);
    $first = $feed = loadFeed($ctx, $url);
    if ($feed['page'] || $id === null)
        return ['feed' => $first, 'item' => $feed['page'] || count($feed['items']) === 1 ? ($feed['items'][0] ?? null) : null,
            'complete' => $feed['page'] || count($feed['items']) <= 1];
    $seen = [$feed['url'] => true];
    for ($page = 1; ; $page++) {
        foreach ($feed['items'] as $item)
            if ($item['id'] === $id)
                return ['feed' => $first, 'item' => $item, 'complete' => true];
        if ($feed['next'] === null)
            return ['feed' => $first, 'item' => null, 'complete' => true];
        $next = resolveUrl($feed['url'], $feed['next']);
        if (isset($seen[$next]))
            return ['feed' => $first, 'item' => null, 'complete' => true];
        if ($page >= MAX_PAGES || urlHost($next) !== urlHost($url))
            return ['feed' => $first, 'item' => null, 'complete' => false];
        try {
            $feed = loadFeed($ctx, $next);
        } catch (FetchError) {
            return ['feed' => $first, 'item' => null, 'complete' => false];
        }
        $seen[$next] = $seen[$feed['url']] = true;
    }
}

/** An ISO 8601 date in UTC, or null. */
function isoDate(?string $date): ?string
{
    $t = $date === null ? false : strtotime($date);
    return $t === false ? null : gmdate('Y-m-d\TH:i:s\Z', $t);
}

/** Parses a JSON Feed or an RSS 2.0 feed. Null if it is neither. */
function parseFeed(string $body): ?array
{
    $t = ltrim($body, "\xEF\xBB\xBF \t\r\n");
    if (str_starts_with($t, '{')) {
        $j = json_decode($t, true, 128);
        return is_array($j) && is_string($j['version'] ?? null) && str_starts_with($j['version'], 'https://jsonfeed.org/version/') ? jsonFeed($j) : null;
    }
    return str_starts_with($t, '<') && preg_match('/<rss[\s>]/', substr($t, 0, 4096)) ? rssFeed($t) : null;
}

function jsonFeed(array $j): array
{
    $str = fn($v) => is_string($v) ? $v : null;
    $firstName = fn($authors) => is_array($authors) && is_array($authors[0] ?? null) ? $str($authors[0]['name'] ?? null) : null;
    $feedAuthor = $firstName($j['authors'] ?? null) ?? (is_array($j['author'] ?? null) ? $str($j['author']['name'] ?? null) : null);
    $items = [];
    foreach (is_array($j['items'] ?? null) ? $j['items'] : [] as $it) {
        $id = is_array($it) ? ($it['id'] ?? null) : null;
        if (!is_string($id) && !is_int($id))
            continue;
        $src = is_array($it['_source'] ?? null) ? $it['_source'] : [];
        $items[] = [
            'id' => (string) $id, 'url' => $str($it['url'] ?? null), 'title' => $str($it['title'] ?? null),
            'html' => $str($it['content_html'] ?? null), 'text' => $str($it['content_text'] ?? null), 'markdown' => $str($src['markdown'] ?? null),
            'author' => $firstName($it['authors'] ?? null) ?? (is_array($it['author'] ?? null) ? $str($it['author']['name'] ?? null) : null) ?? $feedAuthor,
            'account' => is_array($src['accounts'] ?? null) ? $str($src['accounts']['socialspec'] ?? null) : null,
            'inReplyTo' => $str($src['inReplyTo'] ?? null), 'date' => isoDate($str($it['date_published'] ?? null)),
            'allowComments' => !is_array($it['_commenting'] ?? null) || ($it['_commenting']['allowComments'] ?? null) !== false,
            'notifyReplies' => !is_array($it['_commenting'] ?? null) || ($it['_commenting']['notifyReplies'] ?? null) !== false, 'links' => [],
        ];
    }
    $src = is_array($j['_source'] ?? null) ? $j['_source'] : [];
    // RFC-13 archive fields.
    $archive = fn(string $k) => $str(is_array($j['_archive'] ?? null) ? ($j['_archive'][$k] ?? null) : null);
    return [
        'title' => $str($j['title'] ?? null), 'account' => is_array($src['accounts'] ?? null) ? $str($src['accounts']['socialspec'] ?? null) : null,
        'submissions' => is_array($j['_submissions'] ?? null) ? $j['_submissions'] : null,
        // Feed files point to their newest archive with _archive.archive_url.
        'next' => $str($j['next_url'] ?? null) ?? $archive('archive_url'),
        // Archives point to their feed file with _archive.updates_url.
        'updates' => $archive('updates_url'),
        'page' => false, 'items' => $items,
    ];
}

/** The socialspec account of an RSS channel or item. */
function rssAccount(\SimpleXMLElement $e): ?string
{
    foreach ($e->children(NS_SOURCE)->account as $a)
        if ((string) ($a->attributes()['service'] ?? '') === 'socialspec')
            return trim((string) $a);
    return null;
}

function rssFeed(string $xml): ?array
{
    // No DTDs: they are the way to entity expansion attacks, and RSS doesn't need them.
    if (preg_match('/<!DOCTYPE/i', $xml))
        return null;
    $prev = libxml_use_internal_errors(true);
    $x = simplexml_load_string($xml, \SimpleXMLElement::class, LIBXML_NONET);
    libxml_clear_errors();
    libxml_use_internal_errors($prev);
    if (!$x || $x->getName() !== 'rss' || !isset($x->channel))
        return null;
    $ch = $x->channel;
    $text = fn(\SimpleXMLElement $e) => ($s = trim((string) $e)) === '' ? null : $s;
    $next = null;
    foreach ($ch->children(NS_ATOM)->link as $l)
        if ((string) ($l->attributes()['rel'] ?? '') === 'next')
            $next ??= $text($l->attributes()['href']);
    $submissions = null;
    foreach (NS_RM as $ns)
        if ($submissions === null && count($ch->children($ns)->submissions))
            $submissions = ['url' => $text($ch->children($ns)->submissions->children($ns)->url)];
    $items = [];
    foreach ($ch->item as $it) {
        $id = $text($it->guid);
        if ($id === null)
            continue;
        $off = function (string $field) use ($it) {
            foreach (NS_RM as $ns)
                if (count($it->children($ns)->commenting) && strtolower(trim((string) $it->children($ns)->commenting->children($ns)->$field)) === 'false')
                    return true;
            return false;
        };
        $items[] = [
            'id' => $id, 'url' => $text($it->link), 'title' => $text($it->title),
            'html' => $text($it->children(NS_CONTENT)->encoded) ?? $text($it->description), 'text' => null,
            'markdown' => $text($it->children(NS_SOURCE)->markdown),
            'author' => $text($it->children(NS_DC)->creator) ?? $text($it->author),
            'account' => rssAccount($it), 'inReplyTo' => $text($it->children(NS_SOURCE)->inReplyTo),
            'date' => isoDate($text($it->pubDate)), 'allowComments' => !$off('allowComments'), 'notifyReplies' => !$off('notifyReplies'), 'links' => [],
        ];
    }
    return ['title' => $text($ch->title), 'account' => rssAccount($ch), 'submissions' => $submissions, 'next' => $next, 'updates' => null, 'page' => false, 'items' => $items];
}

/** The class tokens of an element. */
function classes(\DOMElement $e): array
{
    return preg_split('/\s+/', trim($e->getAttribute('class')), -1, PREG_SPLIT_NO_EMPTY);
}

/** The first descendant (or the element itself) with a class, in document order. */
function firstWithClass(\DOMElement $root, string $class): ?\DOMElement
{
    if (in_array($class, classes($root), true))
        return $root;
    foreach ($root->getElementsByTagName('*') as $e)
        if (in_array($class, classes($e), true))
            return $e;
    return null;
}

function innerHtml(\DOMElement $e): string
{
    $out = '';
    foreach ($e->childNodes as $c)
        $out .= $e->ownerDocument->saveHTML($c);
    return $out;
}

/**
 * An HTML page as a feed with one post: the first h-entry, with its text in e-content and
 * its title in p-name; without one, the body and the page title (RFC-11). `links` holds the
 * reply links (u-in-reply-to, rel=in-reply-to) first, then every other link of the post.
 */
function parseHtmlPage(string $html): array
{
    $doc = new \DOMDocument();
    $prev = libxml_use_internal_errors(true);
    $doc->loadHTML('<?xml encoding="UTF-8">' . scrub($html), LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING);
    libxml_clear_errors();
    libxml_use_internal_errors($prev);
    $body = $doc->getElementsByTagName('body')->item(0);
    $pageTitle = ($t = $doc->getElementsByTagName('title')->item(0)) ? normalizeSpace($t->textContent) : null;
    $entry = $body ? firstWithClass($body, 'h-entry') : null;
    $root = $entry ?? $body;
    $text = fn(?\DOMElement $e) => $e ? (normalizeSpace($e->textContent) ?: null) : null;
    $content = $entry ? firstWithClass($entry, 'e-content') : null;
    $author = $entry ? firstWithClass($entry, 'p-author') : null;
    $authorName = $author ? ($text(in_array('h-card', classes($author), true) ? firstWithClass($author, 'p-name') : null) ?? $text($author)) : null;
    $url = $entry ? firstWithClass($entry, 'u-url') : null;
    $reply = $other = [];
    foreach ($root ? $root->getElementsByTagName('a') : [] as $a) {
        $href = trim($a->getAttribute('href'));
        if ($href !== '')
            in_array('u-in-reply-to', classes($a), true) || in_array('in-reply-to', preg_split('/\s+/', strtolower($a->getAttribute('rel'))), true)
                ? $reply[] = $href : $other[] = $href;
    }
    $item = [
        'id' => null, 'url' => $url ? ($url->getAttribute('href') ?: null) : null,
        'title' => $entry ? $text(firstWithClass($entry, 'p-name')) : $pageTitle,
        'html' => $root ? innerHtml($content ?? $root) : '', 'text' => null, 'markdown' => null,
        'author' => $authorName, 'account' => null, 'inReplyTo' => $reply[0] ?? null, 'date' => null, 'allowComments' => true, 'notifyReplies' => true,
        'links' => array_values(array_unique([...$reply, ...$other])),
    ];
    // A p-name that is the whole entry (an h-entry without e-content) is no title.
    if ($entry && !$content && $item['title'] === $text($entry))
        $item['title'] = null;
    return ['title' => $pageTitle, 'account' => null, 'submissions' => null, 'next' => null, 'updates' => null, 'page' => true, 'items' => $root ? [$item] : []];
}
