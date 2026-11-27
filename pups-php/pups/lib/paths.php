<?php

namespace Pups;

const MAX_PATH_BYTES = 512;
/** At most this many scopes in one request. */
const MAX_SCOPES = 20;

function isDeclaredWellKnownFile(string $path, Config $c): bool
{
    if (!str_starts_with($path, '/.well-known/'))
        return false;
    foreach ($c->wellKnown as $e)
        if ($e['path'] === $path)
            return true;
    return false;
}

/**
 * Validates a storage path (RFC-6 "Paths"). `raw` is percent-encoded and starts with `/`.
 * Returns the decoded, normalized path, or throws 400.
 */
function parsePath(string $raw, Config $c): string
{
    $fail = fn(string $m) => new HttpError(400, 'invalid_path', $m);
    if (strlen($raw) > 3 * MAX_PATH_BYTES)
        throw $fail('The path is longer than ' . MAX_PATH_BYTES . ' bytes');
    if (preg_match('/%(?![0-9A-Fa-f]{2})/', $raw))
        throw $fail('The path is not valid percent-encoded UTF-8');
    $path = rawurldecode($raw);
    if (!isUtf8($path))
        throw $fail('The path is not valid percent-encoded UTF-8');
    if (!str_starts_with($path, '/'))
        throw $fail('The path must start with /');
    if (strlen($path) > MAX_PATH_BYTES)
        throw $fail('The path is longer than ' . MAX_PATH_BYTES . ' bytes');
    if (str_ends_with($path, '/'))
        throw $fail('The path ends with /');
    // Bidi controls and other invisible characters too: they can disguise a file name.
    if (preg_match('/[\\\\:]/', $path) || hasUnsafeChars($path))
        throw $fail('The path contains a backslash, colon, or a control or invisible character');
    $segments = explode('/', substr($path, 1));
    $dot = false;
    foreach ($segments as $seg) {
        if ($seg === '')
            throw $fail('The path has an empty segment');
        if ($seg === '.' || $seg === '..')
            throw $fail('The path has a dot segment');
        if (str_ends_with($seg, '.') || str_ends_with($seg, ' '))
            throw $fail('A path segment ends with a dot or a space');
        $dot = $dot || $seg[0] === '.';
    }
    if ($dot && !isDeclaredWellKnownFile($path, $c))
        throw $fail('A path segment starts with a dot');
    return $path;
}

/** parsePath(), but null instead of an exception. */
function tryParsePath(string $raw, Config $c): ?string
{
    try {
        return parsePath($raw, $c);
    } catch (HttpError) {
        return null;
    }
}

/** Percent-encodes a decoded path segment by segment. */
function encodePath(string $path): string
{
    return implode('/', array_map('rawurlencode', explode('/', $path)));
}

/** The app's own directory. */
function appdataPrefix(string $clientHost): string
{
    return "/appdata/$clientHost/";
}

/**
 * Is a normalized path (or scope prefix) in a private area (RFC-6 "Private areas"): in
 * /pups/private/, or in the private folder of an app's directory? Case-insensitive, because
 * the disk may be: /APPDATA/x/Private/a.json must not serve /appdata/x/private/a.json publicly.
 */
function isPrivate(string $path): bool
{
    return (bool) preg_match('#^(/pups/private/|/appdata/[^/]+/private/[^/])#i', $path);
}

/**
 * Parses one scope string for a client (RFC-6 "Scopes"). Null if the scope is invalid: only
 * `identify`, `identity-tokens` (RFC-10, if the server issues them), the app's own directory,
 * declared well-known paths and, for reading, declared paths in /pups/private/ exist.
 * Returns ['kind' => 'identify'|'identity-tokens'] or ['kind' => 'write'|'read', 'prefix' => …, 'wellKnown' => entry|null].
 */
function parseScope(string $scope, string $clientHost, Config $c): ?array
{
    if ($scope === 'identify')
        return ['kind' => 'identify'];
    if ($scope === IDENTITY_SCOPE)
        return $c->identityTokens ? ['kind' => IDENTITY_SCOPE] : null;
    if (!preg_match('#^(write|read):(/(?:[A-Za-z0-9\-._~/]|%[0-9A-Fa-f]{2})*)$#D', $scope, $m))
        return null;
    [, $kind, $prefix] = $m;
    $prefix = rawurldecode($prefix);
    if (!isUtf8($prefix))
        return null;
    if ($kind === 'write' && $prefix === appdataPrefix($clientHost))
        return ['kind' => 'write', 'prefix' => $prefix, 'wellKnown' => null];
    // Validate the prefix like a path (a directory prefix without its trailing slash).
    $asPath = str_ends_with($prefix, '/') ? substr($prefix, 0, -1) : $prefix;
    if ($asPath === '' || tryParsePath(encodePath($asPath), $c) === null)
        return null;
    // A read scope exists only for private paths: public files need none.
    foreach ($c->wellKnown as $e)
        if ((str_ends_with($e['path'], '/') ? str_starts_with($prefix, $e['path']) : $prefix === $e['path'])
                && ($kind === 'write' || str_starts_with($e['path'], PRIVATE_PATH)))
            return ['kind' => $kind, 'prefix' => $prefix, 'wellKnown' => $e];
    return null;
}

/** Parses a space-separated scope string into [scope string => parsed]. Null if any scope is invalid or none is given. */
function parseScopes(string $scope, string $clientHost, Config $c): ?array
{
    $items = array_values(array_filter(explode(' ', $scope), fn($x) => $x !== ''));
    if (count($items) > MAX_SCOPES)
        return null;
    $out = [];
    foreach ($items as $item) {
        $parsed = parseScope($item, $clientHost, $c);
        if (!$parsed)
            return null;
        $out[$item] = $parsed;
    }
    return $out ?: null;
}

/** Does a write scope prefix cover a normalized path? */
function covers(string $prefix, string $path): bool
{
    return str_ends_with($prefix, '/') ? str_starts_with($path, $prefix) : $path === $prefix;
}

/** Write prefixes of a granted scope string. The granted scope was validated when it was granted. */
function writePrefixes(string $scope): array
{
    $out = [];
    foreach (explode(' ', $scope) as $x)
        if (str_starts_with($x, 'write:'))
            $out[] = rawurldecode(substr($x, 6));
    return $out;
}

/** Prefixes that allow reading private files: those of the write scopes and of the read scopes. */
function readPrefixes(string $scope): array
{
    $out = writePrefixes($scope);
    foreach (explode(' ', $scope) as $x)
        if (str_starts_with($x, 'read:'))
            $out[] = rawurldecode(substr($x, 5));
    return $out;
}

/**
 * Does a scope need step-up confirmation? Everything but `identify` and the app's own directory does, `identity-tokens`
 * too. (In same-domain mode, every approval is confirmed anyway, so the consent screen is never skipped.)
 */
function needsStepUp(array $scope, string $clientHost): bool
{
    return $scope['kind'] === IDENTITY_SCOPE || $scope['kind'] !== 'identify' && $scope['prefix'] !== appdataPrefix($clientHost);
}

/** The public URL of a stored file (RFC-6 "Public URLs"). */
function publicUrl(string $path, Config $c): string
{
    foreach ($c->wellKnown as $e)
        if ($e['url'] !== null && covers($e['path'], $path))
            return $e['url'] . encodePath(substr($path, strlen($e['path'])));
    return $c->publicBase . encodePath(substr($path, 1));
}

/** Maps a public URL back to a normalized storage path, or null. */
function pathFromPublicUrl(string $url, Config $c): ?string
{
    $raw = null;
    foreach ($c->wellKnown as $e)
        if ($e['url'] !== null && (str_ends_with($e['path'], '/') ? str_starts_with($url, $e['url']) : $url === $e['url']))
            $raw = $e['path'] . substr($url, strlen($e['url']));
    if ($raw === null && str_starts_with($url, $c->publicBase))
        $raw = '/' . substr($url, strlen($c->publicBase));
    if ($raw === null || preg_match('/[?#]/', $raw))
        return null;
    return tryParsePath($raw, $c);
}
