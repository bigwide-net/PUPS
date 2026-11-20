<?php

namespace Pups;

/**
 * host-meta.json is the domain's index and the source of truth (RFC-6 "Editing
 * host-meta.json"): PUPS keeps no separate registry, never touches the owner's links, and
 * changes the file only under the storage lock, checking that it is unchanged before writing.
 * It lives in the storage directory at .well-known/host-meta.json, so the owner can edit it.
 *
 * Documents are handled as stdClass objects, so that `{}` stays `{}` when written back.
 */

const MAX_LINKS = 1000;
const MAX_APPDATA_LINKS = 10;
const MAX_TITLES = 20;
/** host-meta.json may be edited by hand; larger files are neither read nor changed. */
const MAX_HOST_META_BYTES = 1024 * 1024;

/** Rels nobody may register through PUPS: discovery and identity relations. */
const RESERVED_RELS = [
    PUPS_REL, 'http://webfinger.net/rel/profile-page', 'http://webfinger.net/rel/avatar', 'me', 'self', 'lrdd',
    'authorization_endpoint', 'token_endpoint', 'indieauth-metadata', 'micropub', 'openid', 'openid2.provider',
    'http://openid.net/specs/connect/1.0/issuer',
];

/** The generated host-meta.json: the PUPS link, and the mention link of the built-in receiver (RFC-11). */
function defaultHostMeta(Config $c): object
{
    return (object) ['links' => [
        (object) ['rel' => PUPS_REL, 'type' => 'application/json', 'href' => $c->configUrl],
        ...($c->mentions ? [mentionLink($c)] : []),
    ]];
}

/** The stored host-meta.json: ['text', 'etag'], or null. */
function readHostMeta(Ctx $ctx): ?array
{
    $info = $ctx->files->stat(HOST_META_PATH);
    if ($info && $info['size'] > MAX_HOST_META_BYTES)
        throw new HttpError(409, 'invalid_host_meta', 'host-meta.json is larger than ' . MAX_HOST_META_BYTES . ' bytes');
    return $info ? ['text' => file_get_contents($info['abs']), 'etag' => $info['etag']] : null;
}

function parseHostMeta(string $text): object
{
    try {
        $doc = json_decode($text, false, 64, JSON_THROW_ON_ERROR);
    } catch (\JsonException $e) {
        throw new \UnexpectedValueException("host-meta.json is not valid JSON ({$e->getMessage()})");
    }
    if (!$doc instanceof \stdClass)
        throw new \UnexpectedValueException('host-meta.json is not a JSON object');
    if (isset($doc->links) && !is_array($doc->links))
        throw new \UnexpectedValueException('links in host-meta.json is not an array');
    if (isset($doc->properties) && !$doc->properties instanceof \stdClass)
        throw new \UnexpectedValueException('properties in host-meta.json is not an object');
    return $doc;
}

/** The current document for display: ['doc', 'stored', 'error']. */
function currentHostMeta(Ctx $ctx): array
{
    try {
        $stored = readHostMeta($ctx);
        return ['doc' => $stored ? parseHostMeta($stored['text']) : defaultHostMeta($ctx->config), 'stored' => (bool) $stored, 'error' => null];
    } catch (HttpError | \UnexpectedValueException $e) {
        return ['doc' => (object) [], 'stored' => true, 'error' => $e->getMessage()];
    }
}

/**
 * Read-modify-write under the storage lock. `fn` changes the document and returns whether it
 * changed. Just before writing, the file is checked once more, in case the owner edited it
 * in between (an editor doesn't take our lock).
 */
function modifyHostMeta(Ctx $ctx, callable $fn, bool $createIfMissing = true): void
{
    $ctx->files->locked(function () use ($ctx, $fn, $createIfMissing) {
        for ($attempt = 0; $attempt < 5; $attempt++) {
            $stored = readHostMeta($ctx);
            if (!$stored && !$createIfMissing)
                return;
            try {
                $doc = $stored ? parseHostMeta($stored['text']) : defaultHostMeta($ctx->config);
            } catch (\UnexpectedValueException $e) {
                throw new HttpError(409, 'invalid_host_meta', "host-meta.json can't be changed: {$e->getMessage()}");
            }
            if (!$fn($doc))
                return;
            if (($ctx->files->stat(HOST_META_PATH)['etag'] ?? null) !== ($stored['etag'] ?? null))
                continue;
            $ctx->files->write(HOST_META_PATH, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
            Log::event('host-meta.written', ['links' => count($doc->links ?? []), 'properties' => count((array) ($doc->properties ?? []))]);
            return;
        }
        throw new HttpError(409, 'conflict', 'host-meta.json changed concurrently; try again');
    });
}

function linkOwner(mixed $l): ?string
{
    $owner = is_object($l) && isset($l->properties) && is_object($l->properties) ? ($l->properties->{PUPS_CLIENT_PROP} ?? null) : null;
    return is_string($owner) ? $owner : null;
}

/**
 * An http(s) URL in canonical form, as stored in host-meta.json: lowercase scheme and host,
 * no default port, characters outside the URL syntax percent-encoded. Throws 400.
 */
function canonicalHref(mixed $href): string
{
    $fail = new HttpError(400, 'invalid_request', 'href must be an http(s) URL without control or invisible characters');
    if (!is_string($href) || strlen($href) > Limits::URL || hasUnsafeChars($href) || str_contains($href, '\\')
            || !preg_match('#^(https?)://([^/?\#@]+)(/[^?\#]*)?(\?[^\#]*)?(\#.*)?$#Dis', $href, $m))
        throw $fail;
    $scheme = strtolower($m[1]);
    if (!preg_match('#^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?$#D', $m[2], $hm))
        throw $fail;
    $host = strtolower($hm[1]);
    $port = $hm[2] ?? '';
    $port = $port === '' || ($scheme === 'https' && $port === '443') || ($scheme === 'http' && $port === '80') ? '' : ':' . (int) $port;
    $path = ($m[3] ?? '') === '' ? '/' : $m[3];
    if (preg_match('#/(\.|%2e){1,2}(/|$)#i', $path))
        throw $fail;
    $encode = fn(string $s, string $keep) => preg_replace_callback('`%(?![0-9A-Fa-f]{2})|[^' . $keep . '%]`',
        fn($c) => rawurlencode($c[0]), $s);
    return "$scheme://$host$port" . $encode($path, URL_CHARS)
        . (isset($m[4]) && $m[4] !== '' ? '?' . $encode(substr($m[4], 1), URL_CHARS . '?') : '')
        . (isset($m[5]) && $m[5] !== '' ? '#' . $encode(substr($m[5], 1), URL_CHARS . '?#') : '');
}

function relOnClientHost(string $rel, string $clientHost): bool
{
    if (!preg_match('#^https?://([a-z0-9.-]+)(?:[/?\#]|$)#D', $rel, $m))
        return false;
    $h = $m[1];
    return $h === $clientHost || $h === "www.$clientHost" || (str_starts_with($clientHost, 'www.') && $h === substr($clientHost, 4));
}

/** Maps an href to a path inside the grant's write scope, never a private one, or throws 403. */
function ownFile(mixed $href, array $grant, Config $c): string
{
    if (!is_string($href) || strlen($href) > Limits::URL)
        throw new HttpError(400, 'invalid_request', 'href must be a URL');
    $path = pathFromPublicUrl($href, $c);
    if (!$path)
        throw new HttpError(403, 'insufficient_scope', 'href must be the public URL of a file on this server');
    if (isPrivate($path))
        throw new HttpError(403, 'forbidden', "Private files can't be linked: they have no public URL");
    requireScope($grant, $path);
    return $path;
}

/** `titles` of a request (RFC 7033: a language tag or "default" → a title), or null. */
function linkTitles(mixed $titles): ?object
{
    if ($titles === null)
        return null;
    if (!is_array($titles) || ($titles && array_is_list($titles)) || count($titles) > MAX_TITLES)
        throw new HttpError(400, 'invalid_request', 'titles must map at most ' . MAX_TITLES . ' language tags or "default" to titles of at most 255 characters');
    foreach ($titles as $k => $v)
        if (!preg_match('/^(default|[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*)$/D', (string) $k) || !is_string($v)
                || !preg_match('/^.{1,255}$/Dsu', $v) || hasUnsafeChars($v))
            throw new HttpError(400, 'invalid_request', 'titles must map at most ' . MAX_TITLES . ' language tags or "default" to titles of at most 255 characters');
    return $titles ? (object) $titles : null;
}

/** `properties` of a request: only the declared link properties of the well-known path. */
function linkProperties(mixed $props, array $allowed): array
{
    if ($props === null)
        return [];
    if (!is_array($props) || ($props && array_is_list($props)))
        throw new HttpError(400, 'invalid_request', 'properties must be an object');
    foreach ($props as $k => $v) {
        if (!in_array((string) $k, $allowed, true))
            throw new HttpError(403, 'property_not_allowed', 'The link property ' . substr((string) $k, 0, 512) . ' is not allowed for this link');
        if (!is_string($v) || $v === '' || strlen($v) > 2048 || hasUnsafeChars($v))
            throw new HttpError(400, 'invalid_request', 'Link property values must be non-empty strings of at most 2048 characters without control or invisible characters');
    }
    return $props;
}

/** The link `add` writes: rel, href, type, titles, and the link properties with the ownership marker. */
function newLink(string $rel, string $href, ?string $type, ?object $titles, array $props, string $clientId): object
{
    return (object) array_filter(['rel' => $rel, 'href' => $href, 'type' => $type, 'titles' => $titles,
        'properties' => (object) [...$props, PUPS_CLIENT_PROP => $clientId]], fn($v) => $v !== null);
}

function addLink(object $doc, array $body, array $grant, Config $c): bool
{
    $rel = $body['rel'] ?? null;
    $type = $body['type'] ?? null;
    $href = canonicalHref($body['href'] ?? null);
    if ($type !== null && (!is_string($type) || strlen($type) > 255))
        throw new HttpError(400, 'invalid_request', 'type must be a media type of at most 255 characters');
    if (!is_string($rel) || $rel === '' || strlen($rel) > 512 || hasUnsafeChars($rel))
        throw new HttpError(400, 'invalid_request', 'rel is required');
    if ($type !== null && !preg_match('#^[\w.+-]+/[\w.+-]+$#D', $type))
        throw new HttpError(400, 'invalid_request', 'type must be a media type');
    if (in_array($rel, RESERVED_RELS, true))
        throw new HttpError(403, 'rel_not_allowed', 'This link relation is reserved');
    $path = ownFile($href, $grant, $c);
    $doc->links ??= [];
    $prefix = appdataPrefix($grant['clientHost']);
    $appdata = covers($prefix, $path);
    $entry = null;
    if ($appdata) {
        if (!relOnClientHost($rel, $grant['clientHost']))
            throw new HttpError(403, 'rel_not_allowed', "Links to the app's own data must use a URI rel on {$grant['clientHost']}");
    } else {
        foreach ($c->wellKnown as $e)
            if (covers($e['path'], $path))
                $entry = $e;
        if (!$entry || !in_array($rel, $entry['rels'], true))
            throw new HttpError(403, 'rel_not_allowed', 'This rel is not allowed for this well-known path');
        if (in_array($rel, $entry['singleRels'], true))
            foreach ($doc->links as $l)
                if (is_object($l) && ($l->rel ?? null) === $rel && ($l->href ?? null) !== $href)
                    throw new HttpError(409, 'conflict', 'This rel allows only one link, and one exists already');
    }
    $titles = linkTitles($body['titles'] ?? null);
    $props = linkProperties($body['properties'] ?? null, $entry['linkProperties'] ?? []);
    foreach ($doc->links as $i => $l)
        if (is_object($l) && ($l->rel ?? null) === $rel && ($l->href ?? null) === $href) {
            // The app's own link takes the request's type, titles and properties; anyone else's stays.
            if (linkOwner($l) !== $grant['clientId']) {
                if (isset($body['titles']) || isset($body['properties']))
                    throw new HttpError(409, 'conflict', "This link exists already and belongs to the owner or another app; it can't be changed");
                return false;
            }
            $changed = newLink($rel, $href, $type, $titles, $props, $grant['clientId']);
            foreach ($l as $k => $v)
                if (!in_array($k, ['rel', 'href', 'type', 'titles', 'properties'], true))
                    $changed->{$k} = $v;
            if (json_encode($changed) === json_encode($l))
                return false;
            $doc->links[$i] = $changed;
            return true;
        }
    if (count($doc->links) >= MAX_LINKS)
        throw new HttpError(413, 'limit_reached', 'host-meta.json has ' . MAX_LINKS . ' links already');
    if ($appdata && count(array_filter($doc->links, fn($l) => linkOwner($l) === $grant['clientId'] && is_string($l->href ?? null)
            && covers($prefix, pathFromPublicUrl($l->href, $c) ?? ''))) >= MAX_APPDATA_LINKS)
        throw new HttpError(413, 'limit_reached', 'At most ' . MAX_APPDATA_LINKS . " links to an app's own data");
    $doc->links[] = newLink($rel, $href, $type, $titles, $props, $grant['clientId']);
    return true;
}

/**
 * Puts the links of one rel into the order of `hrefs`, in the positions they occupy. `hrefs`
 * must name every link of the rel exactly once, the owner's and other apps' included.
 */
function orderLinks(object $doc, array $body, array $grant, Config $c): bool
{
    $rel = $body['rel'] ?? null;
    $hrefs = $body['hrefs'] ?? null;
    if (!is_string($rel) || $rel === '' || strlen($rel) > 512 || hasUnsafeChars($rel))
        throw new HttpError(400, 'invalid_request', 'rel is required');
    if (!is_array($hrefs) || !array_is_list($hrefs) || count($hrefs) > MAX_LINKS)
        throw new HttpError(400, 'invalid_request', 'hrefs must be an array of URLs');
    $prefixes = writePrefixes($grant['scope']);
    if (!array_filter($c->wellKnown, fn($e) => in_array($rel, $e['rels'], true) && in_array($e['path'], $prefixes, true))
            && !(relOnClientHost($rel, $grant['clientHost']) && in_array(appdataPrefix($grant['clientHost']), $prefixes, true)))
        throw new HttpError(403, 'rel_not_allowed', 'The granted scopes allow no links of this rel');
    $wanted = array_map(fn($h) => canonicalHref($h), $hrefs);
    $links = $doc->links ?? [];
    $slots = array_keys(array_filter($links, fn($l) => is_object($l) && ($l->rel ?? null) === $rel));
    $current = array_map(fn($i) => $links[$i]->href ?? null, $slots);
    if (count(array_unique($wanted)) !== count($wanted) || count($wanted) !== count($current)
            || array_filter($wanted, fn($h) => !in_array($h, $current, true)))
        throw new HttpError(409, 'conflict', 'hrefs must list every link of this rel exactly once; reread host-meta.json');
    $ordered = array_map(fn($h) => $links[$slots[array_search($h, $current, true)]], $wanted);
    $changed = false;
    foreach ($slots as $n => $i)
        if ($links[$i] !== $ordered[$n]) {
            $doc->links[$i] = $ordered[$n];
            $changed = true;
        }
    return $changed;
}

function removeLink(object $doc, array $body, array $grant): bool
{
    $rel = $body['rel'] ?? null;
    if (!is_string($rel) || strlen($rel) > 512)
        throw new HttpError(400, 'invalid_request', 'rel and href are required');
    $href = canonicalHref($body['href'] ?? null);
    $before = count($doc->links ?? []);
    if (isset($doc->links))
        $doc->links = array_values(array_filter($doc->links, fn($l) => !(is_object($l) && ($l->rel ?? null) === $rel
            && ($l->href ?? null) === $href && linkOwner($l) === $grant['clientId'])));
    return count($doc->links ?? []) !== $before;
}

function setProperty(object $doc, array $body, array $grant, Config $c): bool
{
    $property = $body['property'] ?? null;
    $value = $body['value'] ?? null;
    if (!is_string($property) || $property === '' || strlen($property) > 512 || hasUnsafeChars($property))
        throw new HttpError(400, 'invalid_request', 'property must be a URI of at most 512 characters');
    if (str_starts_with($property, PUPS_PROP_PREFIX))
        throw new HttpError(403, 'property_not_allowed', "PUPS's own properties can't be set");
    $prefixes = writePrefixes($grant['scope']);
    $entries = array_filter($c->wellKnown, fn($e) => in_array($property, $e['properties'], true) && in_array($e['path'], $prefixes, true));
    if (!$entries)
        throw new HttpError(403, 'property_not_allowed', 'This property is not allowed for the granted scopes');
    if (!is_string($value) || $value === '' || strlen($value) > 2048 || hasUnsafeChars($value))
        throw new HttpError(400, 'invalid_request', 'value must be a non-empty string of at most 2048 characters without control or invisible characters');
    if (array_filter($entries, fn($e) => in_array($property, $e['urlProperties'], true)))
        ownFile($value, $grant, $c);
    $doc->properties ??= new \stdClass();
    if (($doc->properties->{$property} ?? null) === $value)
        return false;
    $doc->properties->{$property} = $value;
    return true;
}

/**
 * After a grant was revoked and the app has no other grant: remove its links to its own
 * data. Its well-known links stay (the files stay too) and become the owner's.
 * Properties are never removed.
 */
function onGrantRevoked(string $clientId, Ctx $ctx): void
{
    if ($ctx->state->clientHasGrant($clientId))
        return;
    try {
        modifyHostMeta($ctx, function (object $doc) use ($clientId, $ctx) {
            $changed = false;
            $doc->links = array_values(array_filter($doc->links ?? [], function ($l) use ($clientId, $ctx, &$changed) {
                if (linkOwner($l) !== $clientId)
                    return true;
                $changed = true;
                $path = is_string($l->href ?? null) ? pathFromPublicUrl($l->href, $ctx->config) : null;
                if ($path && str_starts_with($path, '/appdata/'))
                    return false;
                unset($l->properties->{PUPS_CLIENT_PROP});
                if (!(array) $l->properties)
                    unset($l->properties);
                return true;
            }));
            return $changed;
        }, false);
    } catch (\Throwable $e) {
        // An invalid host-meta.json must not make revocation fail.
        Log::event('host-meta.cleanup-failed', ['clientId' => $clientId, 'error' => $e->getMessage()]);
    }
}

/** POST <host_meta_endpoint>: apps add, change, remove and order links and set properties in host-meta.json. */
function hostMetaEndpoint(Request $req, Ctx $ctx): Response
{
    if ($req->method !== 'POST')
        throw methodNotAllowed('POST, OPTIONS');
    $grant = authenticate($req, $ctx);
    $raw = $req->body(Limits::JSON_BYTES);
    if ($raw === null)
        throw new HttpError(413, 'too_large', 'The request body is larger than ' . Limits::JSON_BYTES . ' bytes');
    $body = json_decode($raw, true, 16);
    if (!is_array($body) || ($body && array_is_list($body)))
        throw new HttpError(400, 'invalid_request', 'The body must be a JSON object');
    Log::event('host-meta.request', ['client' => $grant['clientId'], 'grant' => $grant['id'], 'body' => $body]);
    $action = $body['action'] ?? null;
    switch (is_string($action) && strlen($action) <= Limits::SHORT ? $action : null) {
        case 'add':
            modifyHostMeta($ctx, fn($doc) => addLink($doc, $body, $grant, $ctx->config));
            return json(['ok' => true], 201);
        case 'remove':
            modifyHostMeta($ctx, fn($doc) => removeLink($doc, $body, $grant), false);
            return new Response(204);
        case 'set-property':
            modifyHostMeta($ctx, fn($doc) => setProperty($doc, $body, $grant, $ctx->config));
            return json(['ok' => true], 201);
        case 'order':
            modifyHostMeta($ctx, fn($doc) => orderLinks($doc, $body, $grant, $ctx->config));
            return new Response(204);
        default:
            throw new HttpError(400, 'invalid_request', 'action must be add, remove, set-property or order');
    }
}
