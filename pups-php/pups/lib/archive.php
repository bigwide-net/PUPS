<?php

namespace Pups;

/**
 * The owner's feeds, kept by this server (RFC-7 "Kept feeds"). Apps write a feed file with
 * PUT, or send single items with POST; the server keeps the archives of RFC-13. It gives new
 * items their index and post URL, puts every item into exactly one archive, starts a new
 * archive when the newest is full, applies edits and deletes in the item's archive, and
 * writes the feed file with copies of the newest items. Apps never write archives.
 *
 * If the feed's `_submissions` names this server's comment endpoint, the server also keeps the
 * posts' `_source.comments` (RFC-1): the comment feed and the counts that comments.php writes.
 *
 * Only feed files with `"_pups": { "pupsControlled": true }` are kept; others are ordinary
 * files. Documents are handled as objects (stdClass), so that `{}` stays `{}` and fields the
 * server doesn't know survive unchanged.
 */

const FEED_REL = 'https://bigwide.net/ns/feed';
const FEED_SPEC = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-7-Feed-Publishing-with-PUPS.md';
const ARCHIVE_SPEC = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-13-JSON-Feed-Archives.md';
const JSON_FEED_VERSION = 'https://jsonfeed.org/version/1.1';
/** Items in the feed file (RFC-7 "Feed size"). */
const FEED_ITEMS = 30;
/** Items in an archive of a new feed (RFC-7 "Archives"). */
const ARCHIVE_SIZE = 20;
const FEED_NAME = '[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?';
const MAX_ITEM_ID = 200;
const FEED_JSON = JSON_FLAGS | JSON_PRESERVE_ZERO_FRACTION;
const FEED_COMMENT = 'This feed is kept by a Personal Upload Server (PUPS), following ' . FEED_SPEC
    . '. It contains the newest items; all items are in the archives, starting with the one at _archive.archive_url.';
/** Top-level fields of the feed file that the server sets, not the apps. */
const MANAGED_FIELDS = ['version', 'home_page_url', 'feed_url', 'user_comment', 'next_url', 'items', '_archive', 'hubs'];
/** Names in `/feed/` that belong to the main feed, so no named feed can have them (RFC-7 "Named feeds"). */
const RESERVED_FEED_NAMES = ['images', 'media', 'comments'];

/**
 * Whether `path` is a feed file (RFC-7 "Feeds and their files"): a declared file with the feed
 * relation, such as /feed.json, or `<name>.json` directly in a declared directory with it.
 */
function isFeedPath(string $path, Config $c): bool
{
    foreach ($c->wellKnown as $e) {
        if (!in_array(FEED_REL, $e['rels'], true))
            continue;
        if ($e['path'] === $path && str_ends_with($path, '.json'))
            return true;
        if (str_ends_with($e['path'], '/') && str_starts_with($path, $e['path'])
                && preg_match('#^(' . FEED_NAME . ')\.json$#D', substr($path, strlen($e['path'])), $m) && !in_array($m[1], RESERVED_FEED_NAMES, true))
            return true;
    }
    return false;
}

/** The feed file that `path` is an archive of (`/feed/feed.000002.json` → `/feed.json`), or null. */
function archiveOwner(string $path, Config $c): ?string
{
    return preg_match('#^(/.+)/feed\.\d{6,}\.json$#D', $path, $m) && isFeedPath("$m[1].json", $c) ? "$m[1].json" : null;
}

/**
 * The feed file whose archives or comment feeds `path` belongs to, if it were kept
 * (`/feed/feed.000002.json`, `/feed/comments/47.json` → `/feed.json`), or null. Only the server writes these.
 */
function keptFileOwner(string $path, Config $c): ?string
{
    return archiveOwner($path, $c)
        ?? (preg_match('#^(/.+?)/comments/.+$#D', $path, $m) && isFeedPath("$m[1].json", $c) ? "$m[1].json" : null);
}

/** The ids of comments that this server publishes, and that name the files of their replies. */
const COMMENT_ID = '[A-Za-z0-9_-]{1,64}';

/**
 * A comment feed (RFC-7 "Publishing comments"): with the post's `index` alone, that of the post,
 * `<feed dir>/comments/<index>.json`, e.g. /feed/comments/47.json; with a comment's id, the replies to
 * that comment, on any level, `<feed dir>/comments/<index>/<comment id>.json`.
 */
function commentFeedPath(string $feedPath, int $index, ?string $commentId = null): string
{
    if ($commentId !== null && !preg_match('/^' . COMMENT_ID . '$/D', $commentId))
        throw new \InvalidArgumentException("Not a comment id: $commentId");
    return substr($feedPath, 0, -5) . "/comments/$index" . ($commentId === null ? '' : "/$commentId") . '.json';
}

/**
 * The parts of a comment feed's path: [feed file, post index, comment id or null], if `path` is one
 * of a feed file (see commentFeedPath()), else null.
 */
function commentFeedParts(string $path, Config $c): ?array
{
    return preg_match('#^(/.+?)/comments/(\d{1,9})(?:/(' . COMMENT_ID . '))?\.json$#D', $path, $m) && isFeedPath("$m[1].json", $c)
        ? ["$m[1].json", (int) $m[2], ($m[3] ?? '') === '' ? null : $m[3]] : null;
}

/** An item's `_source.comments` (RFC-1), if it has a valid `count`. */
function commentsOf(\stdClass $item): ?\stdClass
{
    $c = ($item->_source ?? null) instanceof \stdClass ? ($item->_source->comments ?? null) : null;
    return $c instanceof \stdClass && is_int($c->count ?? null) && $c->count >= 0 ? $c : null;
}

/** Sets or removes an item's `_source.comments`; `_source` goes when nothing else is left in it. */
function setComments(\stdClass $item, ?\stdClass $comments): void
{
    $source = ($item->_source ?? null) instanceof \stdClass ? $item->_source : (object) ['about' => SOURCE_ABOUT];
    if ($comments) {
        $source = (object) (['about' => SOURCE_ABOUT] + (array) $source);
        $source->comments = $comments;
    } else
        unset($source->comments);
    if (array_diff(array_keys((array) $source), ['about']))
        $item->_source = $source;
    else
        unset($item->_source);
}

/** Whether an item accepts comments, as far as it says (RFC-4 `_commenting`, default true). */
function allowsComments(\stdClass $item): bool
{
    return !(($item->_commenting ?? null) instanceof \stdClass && ($item->_commenting->allowComments ?? null) === false);
}

/** Throws 507 if writing `files` (path => text) would exceed the storage quota. */
function checkQuota(Ctx $ctx, array $files): void
{
    $max = $ctx->config->maxStorageBytes;
    if (!$max)
        return;
    $growth = 0;
    foreach ($files as $p => $t)
        $growth += strlen($t) - ($ctx->files->stat($p)['size'] ?? 0);
    if ($growth > 0 && $ctx->files->used() + $growth > $max)
        throw new HttpError(507, 'insufficient_storage', 'The storage quota is reached');
}

function archivePath(string $feedPath, int $n): string
{
    return substr($feedPath, 0, -5) . sprintf('/feed.%06d.json', $n);
}

/** A JSON Feed as an object, or null if `text` isn't one. */
function parseJsonFeed(?string $text): ?\stdClass
{
    $doc = $text === null ? null : json_decode($text, false, 512);
    return $doc instanceof \stdClass && is_string($doc->version ?? null) && str_starts_with($doc->version, 'https://jsonfeed.org/version/1')
        && is_array($doc->items ?? null) ? $doc : null;
}

/** Whether a document carries the marker of RFC-7. */
function isKept(mixed $doc): bool
{
    return $doc instanceof \stdClass && ($doc->_pups ?? null) instanceof \stdClass && ($doc->_pups->pupsControlled ?? null) === true;
}

/** Whether a stored feed file is kept by this server. */
function isKeptFile(Ctx $ctx, string $path): bool
{
    return isKept(parseJsonFeed($ctx->files->read($path)));
}

function itemIndex(mixed $item): ?int
{
    $i = $item instanceof \stdClass && ($item->_archive ?? null) instanceof \stdClass ? ($item->_archive->index ?? null) : null;
    return is_int($i) && $i >= 0 ? $i : null;
}

function itemId(mixed $item): ?string
{
    $id = $item instanceof \stdClass ? ($item->id ?? null) : null;
    return is_string($id) || is_int($id) ? (string) $id : null;
}

function setIndex(\stdClass $item, ?int $index): void
{
    $archive = ($item->_archive ?? null) instanceof \stdClass ? $item->_archive : new \stdClass();
    if ($index === null)
        unset($archive->index);
    else
        $archive->index = $index;
    if ((array) $archive)
        $item->_archive = $archive;
    else
        unset($item->_archive);
}

/** A JSON value with the keys of every object sorted, for comparing items. */
function canonical(mixed $v): string
{
    $sort = function (mixed $v) use (&$sort): mixed {
        if (is_array($v))
            return array_map($sort, $v);
        if (!$v instanceof \stdClass)
            return $v;
        $a = (array) $v;
        ksort($a, SORT_STRING);
        return (object) array_map($sort, $a);
    };
    return json_encode($sort($v), FEED_JSON);
}

function deepCopy(mixed $v): mixed
{
    return json_decode(json_encode($v, FEED_JSON), false, 512);
}

/** Checks a new or changed item from an app, and gives it an id if it has none (16 random URL-safe characters). Throws 400. */
function checkItem(mixed $item): \stdClass
{
    if (!$item instanceof \stdClass)
        throw new HttpError(400, 'invalid_request', 'An item must be a JSON object');
    if (!isset($item->id))
        $item = (object) (['id' => 'p-' . randomToken(12)] + (array) $item);
    elseif (!is_string($item->id) || $item->id === '' || strlen($item->id) > MAX_ITEM_ID || preg_match('/[\x00-\x1f\x7f]/', $item->id))
        throw new HttpError(400, 'invalid_request', 'An item id must be a string of 1 to ' . MAX_ITEM_ID . ' characters without control characters');
    if (!is_string($item->content_html ?? null) && !is_string($item->content_text ?? null))
        throw new HttpError(400, 'invalid_request', "The item \"$item->id\" needs content_html or content_text (JSON Feed)");
    return $item;
}

/**
 * A feed file and its archives while the server changes them, under the storage lock. Archives
 * are read when needed; commit() writes the changed archives, from the oldest to the newest,
 * and then the feed file (RFC-13 "The archive comes first").
 */
final class KeptFeed
{
    /** The feed file's fields. Its items are rebuilt from the archives on commit(). */
    public \stdClass $doc;
    /** The items of the stored feed file, newest first: where items are looked for first. */
    private array $window;
    private int $size = ARCHIVE_SIZE;
    /** The number of the newest archive, or null for a feed without archives (no item yet). */
    private ?int $newest = null;
    /** The index of the next new item (RFC-13 "Indexes"). */
    private int $next = 0;
    /** `next_url` of a handed-over feed without archives: the oldest archive continues it. */
    private ?string $oldChain = null;
    /** @var array<int, ?\stdClass> */
    private array $archives = [];
    /** @var array<int, true> */
    private array $changed = [];
    private string|false|null $template = false;
    /** Whether every post's `_source.comments` must be brought up to date on commit(). */
    private bool $refresh = false;
    /** Indexes of deleted posts, whose comment feeds go on commit(). */
    private array $dropped = [];

    /** `stored` is the stored feed file, or null for a new feed. A feed without archives gets them now. */
    public function __construct(private Ctx $ctx, public string $path, ?\stdClass $stored)
    {
        $this->doc = $stored ?? (object) ['version' => JSON_FEED_VERSION, 'items' => []];
        $archive = $this->doc->_archive ?? null;
        $url = $archive instanceof \stdClass ? ($archive->archive_url ?? null) : null;
        $prefix = preg_quote(substr($path, 0, -5), '#');
        if (is_string($url) && preg_match("#^$prefix/feed\.(\d{6,})\.json$#D", pathFromPublicUrl($url, $ctx->config) ?? '', $m)) {
            $this->newest = (int) $m[1];
            $size = $archive->archive_size ?? null;
            $this->size = is_int($size) && $size > 0 ? $size : ARCHIVE_SIZE;
            $this->window = $this->items($this->doc);
            $counter = $this->archive($this->newest)?->_archive?->next_index ?? null;
            $this->next = is_int($counter) && $counter >= 0 ? $counter : $this->nextFree([...$this->window, ...$this->archive($this->newest)?->items ?? []]);
        } else
            $this->start();
    }

    /**
     * Starts the archives of a feed that has none (RFC-13 "Starting the archives"): its items get
     * indexes, from the oldest to the newest, and go into archives of 20, the oldest first.
     */
    private function start(): void
    {
        $items = $this->items($this->doc);
        $counter = $this->doc->_archive->next_index ?? null;
        $next = $this->nextFree($items, is_int($counter) ? $counter : 0);
        for ($i = count($items) - 1; $i >= 0; $i--)
            if (itemIndex($items[$i]) === null)
                setIndex($items[$i], $next++);
        $this->next = $next;
        $this->window = $items;
        $this->oldChain = is_string($this->doc->next_url ?? null) ? $this->doc->next_url : null;
        foreach (array_chunk(array_reverse($items), $this->size) as $n => $chunk)
            $this->create($n, array_reverse($chunk));
        $this->refresh = true;
    }

    /** The items of a document that are objects with an id. Items without an id get one. */
    private function items(\stdClass $doc): array
    {
        $items = [];
        foreach (is_array($doc->items ?? null) ? $doc->items : [] as $item)
            if ($item instanceof \stdClass)
                $items[] = itemId($item) === null ? (object) (['id' => 'p-' . randomToken(12)] + (array) $item) : $item;
        return $doc->items = $items;
    }

    private function nextFree(array $items, int $counter = 0): int
    {
        foreach ($items as $item)
            $counter = max($counter, (itemIndex($item) ?? -1) + 1);
        return $counter;
    }

    private function archiveUrl(int $n): string
    {
        return publicUrl(archivePath($this->path, $n), $this->ctx->config);
    }

    /** The item's address: its archive's URL + `#id` (RFC-13 "Items"). */
    public function address(int $n, string $id): string
    {
        return $this->archiveUrl($n) . '#' . rawurlencode($id);
    }

    /** An archive, or null if it is missing or isn't a JSON Feed. */
    private function archive(int $n): ?\stdClass
    {
        if (!array_key_exists($n, $this->archives)) {
            $doc = parseJsonFeed($this->ctx->files->read(archivePath($this->path, $n)));
            if ($doc)
                $this->items($doc);
            $this->archives[$n] = $doc;
        }
        return $this->archives[$n];
    }

    /** The newest archive; if the owner deleted it, it is created again. */
    private function newestArchive(): \stdClass
    {
        return $this->archive($this->newest) ?? $this->create($this->newest, []);
    }

    /**
     * Creates archive `n` with the feed fields of the feed file (RFC-13 "Feed fields of an
     * archive"), without the fields that describe the live feed.
     */
    private function create(int $n, array $items): \stdClass
    {
        $a = (object) ['version' => JSON_FEED_VERSION];
        $skip = [...MANAGED_FIELDS, 'author', '_pups', '_submissions'];
        foreach ($this->doc as $k => $v)
            if (!in_array($k, $skip, true))
                $a->$k = deepCopy($v);
        if (($a->_podcast ?? null) instanceof \stdClass)
            unset($a->_podcast->liveItems);
        $a->home_page_url = $this->ctx->config->me;
        $a->feed_url = $this->archiveUrl($n);
        $a->user_comment = 'This is an archive of ' . publicUrl($this->path, $this->ctx->config) . ', kept by a Personal Upload Server (PUPS) following '
            . FEED_SPEC . '. New items appear in the feed at _archive.updates_url, older ones are in the archive at next_url.';
        $next = $n ? $this->archiveUrl($n - 1) : $this->oldChain;
        if ($next !== null)
            $a->next_url = $next;
        $a->_pups = (object) ['about' => FEED_SPEC, 'pupsControlled' => true];
        $a->_archive = new \stdClass();
        $a->items = $items;
        // Only the newest archive holds the counter: the one before loses it on commit().
        if ($this->newest !== null && $n > $this->newest && $this->archive($this->newest))
            $this->changed[$this->newest] = true;
        $this->newest = max($this->newest ?? $n, $n);
        $this->changed[$n] = true;
        return $this->archives[$n] = $a;
    }

    /** The lowest and highest index in archive `n`, or [null, null] if it holds none. */
    private function bounds(int $n): array
    {
        $indexes = array_filter(array_map('Pups\itemIndex', $this->archive($n)?->items ?? []), fn($i) => $i !== null);
        return $indexes ? [min($indexes), max($indexes)] : [null, null];
    }

    /** The position of the item `id` in archive `n`; with `index`, only if it has that index; without `id`, the item with `index`. */
    private function position(int $n, ?string $id, ?int $index = null): ?int
    {
        foreach ($this->archive($n)?->items ?? [] as $p => $item)
            if (($id === null || itemId($item) === $id) && ($index === null || itemIndex($item) === $index))
                return $p;
        return null;
    }

    /**
     * Finds an item: with its index as RFC-13 "Finding an item by index" describes, else in the
     * feed file and the newest archive, and with `everywhere` in all archives. Without `id`, the item
     * with `index`.
     * @return ?array [archive number, position]
     */
    public function find(?string $id, ?int $index, bool $everywhere = false): ?array
    {
        if ($this->newest === null || ($id === null && $index === null))
            return null;
        if ($index === null)
            foreach ($this->window as $item)
                if (itemId($item) === $id && ($index = itemIndex($item)) !== null)
                    break;
        if ($index !== null) {
            $start = min($this->newest, intdiv($index, $this->size));
            for ($n = $start; $n >= 0; $n--) {
                if (($p = $this->position($n, $id, $index)) !== null)
                    return [$n, $p];
                if (($this->bounds($n)[1] ?? PHP_INT_MAX) < $index)
                    break;
            }
            for ($n = $start + 1; $n <= $this->newest; $n++) {
                if (($p = $this->position($n, $id, $index)) !== null)
                    return [$n, $p];
                if (($this->bounds($n)[0] ?? -1) > $index)
                    break;
            }
            return null;
        }
        for ($n = $this->newest; $n >= ($everywhere ? 0 : $this->newest); $n--)
            if (($p = $this->position($n, $id)) !== null)
                return [$n, $p];
        return null;
    }

    /** The post URL template from host-meta.json (RFC-6 "Post URLs"), or null. */
    private function template(): ?string
    {
        if ($this->template === false) {
            try {
                $stored = readHostMeta($this->ctx);
                $t = $stored ? (parseHostMeta($stored['text'])->properties ?? null)?->{POST_URL_TEMPLATE_PROP} ?? null : null;
            } catch (\Throwable) {
                $t = null;
            }
            $this->template = is_string($t) && str_starts_with($t, 'https://') && preg_match('/\{(index|id)\}/', $t) ? $t : null;
        }
        return $this->template;
    }

    /** Gives an item without `url` the URL of its page (RFC-7 "Post URLs"). */
    private function withPostUrl(\stdClass $item): void
    {
        $index = itemIndex($item);
        if ((is_string($item->url ?? null) && $item->url !== '') || $index === null || ($t = $this->template()) === null)
            return;
        $item->url = strtr($t, ['{feed}' => substr($this->path, 1, -5), '{index}' => (string) $index, '{id}' => rawurlencode(itemId($item))]);
    }

    /** Whether this server keeps the posts' `_source.comments`: `_submissions` names its comment endpoint. */
    private function ownsComments(): bool
    {
        $s = $this->doc->_submissions ?? null;
        return $this->ctx->config->comments && $s instanceof \stdClass && ($s->url ?? null) === commentUrl($this->ctx->config);
    }

    /** Whether the feed accepts comments at this server: it has a comments policy. */
    private function commentsOpen(): bool
    {
        return $this->ownsComments() && ($this->doc->_submissions->policies ?? null) instanceof \stdClass
            && ($this->doc->_submissions->policies->comments ?? null) instanceof \stdClass;
    }

    /**
     * Sets an item's `_source.comments` as this server keeps it: the comment feed and counts of `old`, the
     * stored item, if it has comments; else `{count: 0, total: 0}` while the post accepts comments, and
     * nothing otherwise. Unless `always`, only in a feed whose comments this server keeps; elsewhere the
     * item keeps what the app sent.
     */
    private function withComments(\stdClass $item, ?\stdClass $old, bool $always = false): void
    {
        if (!$always && !$this->ownsComments())
            return;
        $c = $old ? commentsOf($old) : null;
        setComments($item, $c && $c->count ? deepCopy($c)
            : ($this->commentsOpen() && allowsComments($item) ? (object) ['count' => 0, 'total' => 0] : null));
    }

    /** Brings every post's `_source.comments` up to date, e.g. after the feed was opened for comments. */
    private function refreshComments(): void
    {
        for ($n = 0; $n <= ($this->newest ?? -1); $n++)
            foreach ($this->archive($n)?->items ?? [] as $item) {
                $before = canonical($item);
                $this->withComments($item, deepCopy($item), true);
                if (canonical($item) !== $before)
                    $this->changed[$n] = true;
            }
    }

    /** An item by its id or its index, in any archive: ['item', 'address'], or null. */
    public function get(?string $id, ?int $index = null): ?array
    {
        $at = $this->find($id, $index, true);
        $item = $at ? $this->archives[$at[0]]->items[$at[1]] : null;
        return $item ? ['item' => $item, 'address' => $this->address($at[0], itemId($item))] : null;
    }

    /**
     * Sets a post's comment feed and counts (RFC-1 `_source.comments`) after a comment was published or
     * removed. The post isn't modified otherwise and gets no `date_modified`. Returns false if there is no
     * such post.
     */
    public function setCommentCounts(string $id, string $feedUrl, int $count, int $total): bool
    {
        $at = $this->find($id, null, true);
        if ($at === null)
            return false;
        $item = $this->archives[$at[0]]->items[$at[1]];
        $before = canonical($item);
        if ($count)
            setComments($item, (object) ['feedUrl' => $feedUrl, 'count' => $count, 'total' => $total]);
        else
            $this->withComments($item, null, true);
        if (canonical($item) !== $before)
            $this->changed[$at[0]] = true;
        return true;
    }

    private function now(): string
    {
        return gmdate('Y-m-d\TH:i:s\Z', intdiv($this->ctx->now(), 1000));
    }

    /**
     * Adds an item, or replaces the one it names: by `_archive.index`, or by id if the feed file or
     * the newest archive has it (a repeated request). An item with an index that no item has any
     * more is refused with `missing` (404 or 409).
     * @return array ['item' (as stored), 'address', 'created', 'changed']
     */
    public function put(mixed $item, int $missing = 404): array
    {
        $item = checkItem($item);
        $id = itemId($item);
        $index = itemIndex($item);
        $at = $this->find($id, $index);
        if ($at === null && $index !== null)
            throw new HttpError($missing, $missing === 404 ? 'not_found' : 'conflict', "The feed has no item \"$id\" with the index $index; it may have been deleted");
        if ($at) {
            $changed = $this->replace($at[0], $at[1], $item);
            return ['item' => $this->archives[$at[0]]->items[$at[1]], 'address' => $this->address($at[0], $id), 'created' => false, 'changed' => $changed];
        }
        if (!is_string($item->date_published ?? null))
            $item->date_published = $this->now();
        setIndex($item, $this->next++);
        $this->withPostUrl($item);
        $this->withComments($item, null);
        if ($this->newest !== null && count($this->newestArchive()->items) < $this->size) {
            array_unshift($this->archives[$this->newest]->items, $item);
            $this->changed[$this->newest] = true;
        } else
            $this->create($this->newest === null ? 0 : $this->newest + 1, [$item]);
        return ['item' => $item, 'address' => $this->address($this->newest, $id), 'created' => true, 'changed' => true];
    }

    /**
     * Replaces the item at a position with `item`, which keeps the old index and, if it has none,
     * the old `date_published`. Sets `date_modified` unless the app changed it.
     * @return bool whether the item changed
     */
    private function replace(int $n, int $p, \stdClass $item): bool
    {
        $old = $this->archives[$n]->items[$p];
        $item->id = $old->id;
        setIndex($item, itemIndex($old));
        if (is_string($old->date_published ?? null) && !is_string($item->date_published ?? null))
            $item->date_published = $old->date_published;
        $this->withPostUrl($item);
        $this->withComments($item, $old);
        $probe = clone $item;
        if (!isset($probe->date_modified) && isset($old->date_modified))
            $probe->date_modified = $old->date_modified;
        if (canonical($probe) === canonical($old))
            return false;
        if (($item->date_modified ?? null) === ($old->date_modified ?? null))
            $item->date_modified = $this->now();
        $this->archives[$n]->items[$p] = $item;
        $this->changed[$n] = true;
        return true;
    }

    /**
     * Deletes an item, found by its index or, without one, in all archives.
     * @return ?array ['item', 'address'], or null if there is no such item
     */
    public function delete(string $id, ?int $index): ?array
    {
        $at = $this->find($id, $index, true);
        if ($at === null)
            return null;
        [$item] = array_splice($this->archives[$at[0]]->items, $at[1], 1);
        $this->changed[$at[0]] = true;
        if (($index = itemIndex($item)) !== null)
            $this->dropped[] = $index;
        return ['item' => $item, 'address' => $this->address($at[0], $id)];
    }

    /** Replaces the owner's fields of the feed file with those of `body` (RFC-7 "Fields"). */
    public function setFields(\stdClass $body): void
    {
        $doc = new \stdClass();
        foreach ($body as $k => $v)
            if (!in_array($k, MANAGED_FIELDS, true))
                $doc->$k = $v;
        foreach (['_archive', 'next_url'] as $k)
            if (isset($this->doc->$k))
                $doc->$k = $this->doc->$k;
        $this->doc = $doc;
    }

    /** Applies a feed file that an app PUT: its items are compared with those of the stored feed file. */
    public function apply(\stdClass $body): void
    {
        if (!is_array($body->items ?? null))
            throw new HttpError(400, 'invalid_request', 'items must be an array');
        $before = [];
        foreach ($this->window as $item)
            $before[itemId($item)] = $item;
        $seen = [];
        $put = [];
        foreach ($body->items as $item) {
            $id = itemId($item);
            if ($id !== null && isset($seen[$id]))
                throw new HttpError(400, 'invalid_request', "Two items have the id \"$id\"");
            if ($id !== null)
                $seen[$id] = true;
            if ($id === null || !isset($before[$id]) || canonical($item) !== canonical($before[$id]))
                $put[] = $item;
        }
        $comments = [$this->ownsComments(), $this->commentsOpen()];
        $this->setFields($body);
        if ($comments !== [$this->ownsComments(), $this->commentsOpen()])
            $this->refresh = true;
        // Items the app removed from the feed file are deleted.
        foreach (array_diff_key($before, $seen) as $id => $item)
            $this->delete((string) $id, itemIndex($item));
        // The oldest first, so that new items get their indexes in the order of the feed.
        foreach (array_reverse($put) as $item)
            $this->put($item, 409);
    }

    /** The feed file as it is written: the fixed fields, the archive fields, and the newest items. */
    private function feedFile(): \stdClass
    {
        $c = $this->ctx->config;
        $d = (object) ['version' => JSON_FEED_VERSION];
        foreach ($this->doc as $k => $v)
            if (!in_array($k, ['version', 'items', 'author', 'next_url', '_archive', 'hubs'], true))
                $d->$k = $v;
        $author = $this->doc->author ?? null;
        if ($author instanceof \stdClass && !isset($d->authors))
            $d->authors = [$author];
        // While the WebSub hub is on (websub.php).
        if (websubOn($this->ctx))
            $d->hubs = [(object) ['type' => 'WebSub', 'url' => hubUrl($c)]];
        $d->home_page_url = $c->me;
        $d->feed_url = publicUrl($this->path, $c);
        $d->user_comment = FEED_COMMENT;
        $d->_pups = (object) (['about' => FEED_SPEC] + (($d->_pups ?? null) instanceof \stdClass ? (array) $d->_pups : []) + ['pupsControlled' => true]);
        $archive = ($this->doc->_archive ?? null) instanceof \stdClass ? clone $this->doc->_archive : new \stdClass();
        unset($archive->updates_url, $archive->number, $archive->next_index);
        $items = [];
        if ($this->newest === null) {
            if ($this->oldChain !== null)
                $d->next_url = $this->oldChain;
            if ($this->next)
                $archive->next_index = $this->next;
        } else {
            $archive->archive_url = $this->archiveUrl($this->newest);
            $archive->archive_template = str_replace('000000.json', '{number}.json', $this->archiveUrl(0));
            $archive->archive_size = $this->size;
            for ($n = $this->newest; $n >= 0 && count($items) < FEED_ITEMS; $n--)
                foreach ($this->archive($n)?->items ?? [] as $item)
                    if (count($items) < FEED_ITEMS)
                        $items[] = $item;
        }
        if ((array) $archive)
            $d->_archive = (object) (['about' => ARCHIVE_SPEC] + (array) $archive);
        $d->items = $items;
        return $d;
    }

    /**
     * Writes the changed archives, from the oldest to the newest, and then the feed file. Throws
     * 507 if the storage quota would be exceeded.
     * @return array ['text' (of the feed file), 'etag']
     */
    public function commit(): array
    {
        if ($this->refresh)
            $this->refreshComments();
        $this->refresh = false;
        $files = [];
        ksort($this->changed);
        $updates = publicUrl($this->path, $this->ctx->config);
        foreach (array_keys($this->changed) as $n) {
            $a = $this->archives[$n];
            $fields = ($a->_archive ?? null) instanceof \stdClass ? (array) $a->_archive : [];
            unset($fields['next_index']);
            $a->_archive = (object) (['about' => ARCHIVE_SPEC, 'updates_url' => $updates, 'number' => $n] + $fields + ($n === $this->newest ? ['next_index' => $this->next] : []));
            $files[archivePath($this->path, $n)] = json_encode($a, FEED_JSON | JSON_PRETTY_PRINT);
        }
        $text = $files[$this->path] = json_encode($this->feedFile(), FEED_JSON | JSON_PRETTY_PRINT);
        checkQuota($this->ctx, $files);
        foreach ($files as $p => $t)
            $etag = $this->ctx->files->write($p, $t);
        // A deleted post's comments go with it.
        foreach ($this->dropped as $index) {
            $comments = commentFeedPath($this->path, $index);
            if ($this->ctx->files->stat($comments))
                $this->ctx->files->delete($comments);
            $this->ctx->files->deleteDir(substr($comments, 0, -5) . '/');
        }
        $this->dropped = [];
        Log::event('feed.written', ['path' => $this->path, 'archives' => array_keys($this->changed), 'newest' => $this->newest, 'next' => $this->next]);
        $this->changed = [];
        return ['text' => $text, 'etag' => $etag];
    }
}

/**
 * PUT of a kept feed file (RFC-7 "Writing the feed file"), under the storage lock and after the
 * preconditions: applies the feed file to the stored one and its archives. The response holds
 * the feed file as stored; it has an ETag only if that is the body that was sent.
 */
function putKeptFeed(Ctx $ctx, string $path, string $rawPath, string $text, ?array $existing, array $grant): Response
{
    $body = parseJsonFeed($text);
    if ($body === null)
        throw new HttpError(400, 'invalid_request', 'A feed file with the _pups marker must be a JSON Feed (RFC-7)');
    $feed = new KeptFeed($ctx, $path, $existing ? parseJsonFeed($ctx->files->read($path)) : null);
    $feed->apply($body);
    $stored = $feed->commit();
    websubChanged($ctx, $path);
    Log::event($existing ? 'file.replaced' : 'file.created', ['client' => $grant['clientId'], 'grant' => $grant['id'], 'path' => $path, 'kept' => true, 'etag' => $stored['etag']]);
    $c = $ctx->config;
    return new Response($existing ? 200 : 201, [
        'Content-Type' => 'application/json; charset=utf-8',
        'Content-Location' => $c->storageBase . substr($rawPath, 1),
        ...($stored['text'] === $text ? ['ETag' => $stored['etag']] : []),
        ...($existing ? [] : ['Location' => $c->storageBase . substr($rawPath, 1)]),
    ], $stored['text']);
}

/**
 * POST of an item to a kept feed file (RFC-7 "Posting items"): adds the item, replaces the one
 * it names, or, with `"_pups": { "delete": true }`, deletes it. Answers with the item as stored
 * (or deleted) and its address; a new item gets 201 and its address as Location.
 */
function postItem(Request $req, string $rawPath, Ctx $ctx): Response
{
    $c = $ctx->config;
    $grant = authenticate($req, $ctx, true);
    $path = parsePath($rawPath, $c);
    requireScope($grant, $path);
    if (!isFeedPath($path, $c))
        throw new HttpError(405, 'method_not_allowed', 'POST is accepted only on feed files (RFC-7)', ['Allow' => 'GET, HEAD, PUT, DELETE, OPTIONS']);
    $type = strtolower(trim(explode(';', reqHeader($req, 'content-type') ?? '')[0]));
    if ($type !== 'application/json' && $type !== 'application/feed+json')
        throw new HttpError(415, 'unsupported_type', 'An item is sent as application/json');
    $text = $req->body($c->maxUploadBytes) ?? throw new HttpError(413, 'too_large', "Items may be at most $c->maxUploadBytes bytes");
    $item = json_decode($text, false, 512);
    if (!$item instanceof \stdClass)
        throw new HttpError(400, 'invalid_request', 'The body must be a JSON Feed item');
    return $ctx->files->locked(function () use ($ctx, $path, $item, $grant) {
        $stored = parseJsonFeed($ctx->files->read($path));
        if ($stored === null)
            throw new HttpError(404, 'not_found', "There is no feed at $path");
        if (!isKept($stored))
            throw new HttpError(409, 'not_pups_controlled', "$path has no \"_pups\": { \"pupsControlled\": true }, so this server doesn't keep it (RFC-7)");
        $feed = new KeptFeed($ctx, $path, $stored);
        $log = ['client' => $grant['clientId'], 'grant' => $grant['id'], 'path' => $path];
        if (($item->_pups ?? null) instanceof \stdClass && ($item->_pups->delete ?? null) === true) {
            $id = itemId($item) ?? throw new HttpError(400, 'invalid_request', 'A delete names the item by its id');
            $deleted = $feed->delete($id, itemIndex($item)) ?? throw new HttpError(404, 'not_found', "The feed has no item \"$id\"");
            $feed->commit();
            websubChanged($ctx, $path);
            Log::event('item.deleted', $log + ['id' => $id]);
            return json($deleted);
        }
        $r = $feed->put($item);
        if ($r['changed']) {
            $feed->commit();
            websubChanged($ctx, $path);
        }
        Log::event($r['created'] ? 'item.created' : ($r['changed'] ? 'item.replaced' : 'item.unchanged'), $log + ['id' => itemId($r['item'])]);
        return json(['item' => $r['item'], 'address' => $r['address']], $r['created'] ? 201 : 200, $r['created'] ? ['Location' => $r['address']] : []);
    });
}
