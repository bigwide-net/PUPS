<?php

namespace Pups;

function invalidToken(string $message): HttpError
{
    return new HttpError(401, 'invalid_token', $message, ['WWW-Authenticate' => 'Bearer error="invalid_token"']);
}

/**
 * Authenticates the bearer token from the Authorization header (never from the URL or the
 * body). With `write`, also counts the request against the per-grant write rate limit.
 */
function authenticate(Request $req, Ctx $ctx, bool $write = false): array
{
    $auth = $req->header('authorization') ?? '';
    if (strlen($auth) > Limits::HEADER || !preg_match('#^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$#Di', $auth, $m))
        throw invalidToken('A bearer token is required');
    $r = $ctx->state->authenticate($m[1], $write ? $ctx->config->writesPerMinute : 0);
    if (!$r) {
        Log::event('api.invalid-token', ['token' => fp($m[1]), 'url' => $req->target]);
        throw invalidToken('The access token is invalid, expired or revoked');
    }
    if ($r['rateLimited']) {
        Log::event('api.rate-limited', ['client' => $r['grant']['clientId'], 'grant' => $r['grant']['id']]);
        throw new HttpError(429, 'rate_limited', 'Too many writes; slow down', ['Retry-After' => '60']);
    }
    return $r['grant'];
}

/** Throws 403 unless a write scope of the grant covers the path (or, with `read`, a read scope does too). */
function requireScope(array $grant, string $path, bool $read = false): void
{
    foreach ($read ? readPrefixes($grant['scope']) : writePrefixes($grant['scope']) as $prefix)
        if (covers($prefix, $path))
            return;
    throw new HttpError(403, 'insufficient_scope', 'The path is outside the granted scope', ['WWW-Authenticate' => 'Bearer error="insufficient_scope"']);
}

function etagMatches(string $header, string $etag): bool
{
    foreach (explode(',', $header) as $x) {
        $x = preg_replace('#^W/#', '', trim($x));
        if ($x === '*' || $x === $etag)
            return true;
    }
    return false;
}

/**
 * PUT or DELETE of a file (RFC-6 "Upload API"). `rawPath` is percent-encoded and relative
 * to storage_base, starting with `/`. Shared by the direct API and the POST fallback.
 */
function writeFile(Request $req, string $method, string $rawPath, Ctx $ctx): Response
{
    $c = $ctx->config;
    $grant = authenticate($req, $ctx, true);
    $path = parsePath($rawPath, $c);
    requireScope($grant, $path);
    $ifMatch = reqHeader($req, 'if-match');
    $ifNoneMatch = reqHeader($req, 'if-none-match');
    $files = $ctx->files;
    if (($owner = keptFileOwner($path, $c)) && isKeptFile($ctx, $owner))
        throw new HttpError(403, 'forbidden', "This server writes the archives and comment feeds of $owner (RFC-7). Change its items with PUT or POST of $owner.");

    if ($method === 'DELETE')
        return $files->locked(function () use ($files, $path, $ifMatch, $grant) {
            $existing = $files->stat($path);
            if (!$existing)
                throw new HttpError(404, 'not_found', 'The file does not exist');
            if ($ifMatch && !etagMatches($ifMatch, $existing['etag']))
                throw new HttpError(412, 'precondition_failed', 'The file has changed');
            $files->delete($path);
            Log::event('file.deleted', ['client' => $grant['clientId'], 'grant' => $grant['id'], 'path' => $path, 'ifMatch' => $ifMatch, 'etag' => $existing['etag']]);
            return new Response(204);
        });

    // Check the type and the size before storing a single byte.
    $contentType = reqHeader($req, 'content-type');
    $type = checkUploadType($path, $contentType);
    $tooLarge = new HttpError(413, 'too_large', "Files may be at most $c->maxUploadBytes bytes");
    if ((int) ($req->header('content-length') ?? 0) > $c->maxUploadBytes)
        throw $tooLarge;
    $tmp = $files->tempFile();
    try {
        $out = fopen($tmp, 'wb');
        $in = $req->stream();
        $bytes = 0;
        while (!feof($in) && ($chunk = fread($in, 65536)) !== false && $chunk !== '') {
            $bytes += strlen($chunk);
            if ($bytes > $c->maxUploadBytes) {
                fclose($out);
                throw $tooLarge;
            }
            fwrite($out, $chunk);
        }
        fclose($out);
        if ($type[2] && !isUtf8(file_get_contents($tmp)))
            throw new HttpError(415, 'unsupported_type', 'Text files must be UTF-8');
        // A feed file with the marker is kept by the server (RFC-7 "Kept feeds").
        $kept = isFeedPath($path, $c) && isKept(json_decode(file_get_contents($tmp), false, 512)) ? file_get_contents($tmp) : null;

        // Under the lock, no other request can change the file between the precondition check and the write.
        return $files->locked(function () use ($files, $path, $rawPath, $tmp, $bytes, $ifMatch, $ifNoneMatch, $grant, $contentType, $c, $kept, $ctx) {
            $existing = $files->stat($path);
            if ($ifNoneMatch && (trim($ifNoneMatch) === '*' ? $existing : $existing && etagMatches($ifNoneMatch, $existing['etag'])))
                throw new HttpError(412, 'precondition_failed', 'The file already exists');
            if ($ifMatch && (!$existing || !etagMatches($ifMatch, $existing['etag'])))
                throw new HttpError(412, 'precondition_failed', $existing ? 'The file has changed' : 'The file does not exist');
            if ($kept !== null)
                return putKeptFeed($ctx, $path, $rawPath, $kept, $existing, $grant);
            if ($c->maxStorageBytes && $files->used() - ($existing['size'] ?? 0) + $bytes > $c->maxStorageBytes)
                throw new HttpError(507, 'insufficient_storage', 'The storage quota is reached');
            $etag = $files->commit($path, $tmp);
            Log::event($existing ? 'file.replaced' : 'file.created', [
                'client' => $grant['clientId'], 'grant' => $grant['id'], 'path' => $path, 'bytes' => $bytes, 'contentType' => $contentType,
                'ifMatch' => $ifMatch, 'ifNoneMatch' => $ifNoneMatch, 'oldEtag' => $existing['etag'] ?? null, 'etag' => $etag,
                // Private files have no public URL.
                ...(isPrivate($path) ? [] : ['url' => publicUrl($path, $c)]),
            ]);
            return new Response($existing ? 200 : 201, ['ETag' => $etag] + ($existing ? [] : ['Location' => $c->storageBase . substr($rawPath, 1)]));
        });
    } finally {
        if (is_file($tmp))
            @unlink($tmp);
    }
}

/** POST fallback for hosts that block PUT and DELETE (only when declared). `method=POST` posts an item to a feed. */
function postEndpoint(Request $req, Ctx $ctx): Response
{
    if ($req->method !== 'POST')
        throw methodNotAllowed('POST, OPTIONS');
    $q = $req->query();
    $method = field($q, 'method');
    $path = field($q, 'path', Limits::RAW_PATH);
    if ($method !== 'PUT' && $method !== 'DELETE' && $method !== 'POST')
        throw new HttpError(400, 'invalid_request', 'method must be PUT, DELETE or POST');
    if ($path === null)
        throw new HttpError(400, 'invalid_path', 'path is required');
    // `path` was percent-decoded once by the query parser; re-encode it so that it is decoded exactly once.
    return $method === 'POST' ? postItem($req, encodePath($path), $ctx) : writeFile($req, $method, encodePath($path), $ctx);
}

/**
 * Headers on every uploaded file: they make sure an upload is always treated as data (RFC-6
 * "Serving files"). A fresh read must not be stored by any cache; `Vary` keeps a cache that
 * stored a public read from answering a request with a token with it.
 */
function fileHeaders(string $contentType, bool $fresh = false): array
{
    return [
        'Content-Type' => $contentType,
        'X-Content-Type-Options' => 'nosniff',
        'Content-Security-Policy' => 'sandbox',
        'Cache-Control' => $fresh ? 'private, no-store' : 'no-cache',
        'Vary' => 'Authorization',
        'Accept-Ranges' => 'bytes',
    ];
}

/** On every response for a private path, errors included: no cache may store it, or a 404 that would later hide it. */
const PRIVATE_HEADERS = ['Cache-Control' => 'no-store', 'Vary' => 'Authorization'];

/**
 * Read of an uploaded file, with conditional and range requests. `rawPath` is percent-encoded.
 * With a bearer token of any scope, it is a fresh read (RFC-6 "Fresh reads"): caches pass it
 * on, and an invalid token gets 401 instead of a public read. Files come from disk either way.
 * Private files (RFC-6 "Private areas") need a token whose scope covers them, which is checked
 * before looking for the file, so that the answer never tells whether it exists.
 */
function serveFile(Request $req, string $rawPath, Ctx $ctx): Response
{
    $path = tryParsePath($rawPath, $ctx->config);
    // Also for a path that is invalid, so that even its 404 is never cached.
    $private = isPrivate($path ?? rawurldecode($rawPath));
    try {
        // Other schemes (Basic, from a password-protected site) are no fresh reads.
        $fresh = !strncasecmp($req->header('authorization') ?? '', 'Bearer', 6);
        if ($private && !$fresh)
            throw new HttpError(401, 'invalid_token', 'A bearer token is required for private files', ['WWW-Authenticate' => 'Bearer']);
        if ($fresh) {
            $grant = authenticate($req, $ctx);
            if ($private)
                requireScope($grant, $path ?? rawurldecode($rawPath), true);
        }
        return fileResponse($req, $path, $fresh, $ctx);
    } catch (HttpError $e) {
        throw $private ? new HttpError($e->status, $e->error, $e->getMessage(), PRIVATE_HEADERS + $e->headers) : $e;
    }
}

/** serveFile() after the token checks. `path` is normalized, or null if it is invalid. */
function fileResponse(Request $req, ?string $path, bool $fresh, Ctx $ctx): Response
{
    // Uploads never contain JavaScript; refusing service worker scripts is defence in depth.
    if (strtolower($req->header('service-worker') ?? '') === 'script')
        throw new HttpError(403, 'forbidden', 'Uploaded files can never be service workers');
    $type = $path ? fileType($path) : null;
    $info = $type ? $ctx->files->stat($path) : null;
    if (!$info)
        throw new HttpError(404, 'not_found', 'Not found');
    $headers = fileHeaders(servedType($type), $fresh) + ['ETag' => $info['etag'], 'Last-Modified' => gmdate('D, d M Y H:i:s', $info['mtime']) . ' GMT'];
    $inm = reqHeader($req, 'if-none-match');
    $ims = $inm === null ? reqHeader($req, 'if-modified-since') : null;
    if (($inm !== null && etagMatches($inm, $info['etag'])) || ($ims !== null && ($t = strtotime($ims)) && $info['mtime'] <= $t))
        return new Response(304, $headers);
    $ifMatch = reqHeader($req, 'if-match');
    if ($ifMatch !== null && !etagMatches($ifMatch, $info['etag']))
        return new Response(412, $headers);
    $size = $info['size'];
    $offset = 0;
    $length = $size;
    $status = 200;
    $range = reqHeader($req, 'range');
    $ifRange = reqHeader($req, 'if-range');
    if ($range !== null && ($ifRange === null || $ifRange === $info['etag']) && preg_match('/^bytes=(\d*)-(\d*)$/D', trim($range), $m) && "$m[1]$m[2]" !== '') {
        if ($m[1] === '') {
            $offset = max(0, $size - (int) $m[2]);
        } else {
            $offset = (int) $m[1];
            $end = $m[2] === '' ? $size - 1 : min((int) $m[2], $size - 1);
            if ($offset >= $size || $end < $offset)
                return new Response(416, $headers + ['Content-Range' => "bytes */$size"]);
            $length = $end - $offset + 1;
        }
        $length = min($length, $size - $offset);
        if ($offset || $length < $size) {
            $status = 206;
            $headers['Content-Range'] = 'bytes ' . $offset . '-' . ($offset + $length - 1) . "/$size";
        }
    }
    $r = new Response($status, $headers + ['Content-Length' => $length]);
    $r->file = [$info['abs'], $offset, $length];
    return $r;
}

/**
 * The upload API at storage_base and public reads. Declared well-known paths whose public
 * URL differs from their storage path (e.g. /.well-known/about.md when PUPS is installed in a
 * folder) are read at that URL. Returns null if the path is none of these.
 */
function fileRoutes(Request $req, string $abs, ?string $rel, Ctx $ctx): ?Response
{
    $c = $ctx->config;
    switch ($req->method) {
        case 'PUT':
        case 'DELETE':
            return $rel === null ? null : writeFile($req, $req->method, $rel, $ctx);
        case 'POST':
            // Only feed files take POST; for everything else, the path doesn't exist as an endpoint.
            return $rel !== null && ($path = tryParsePath($rel, $c)) !== null && isFeedPath($path, $c) ? postItem($req, $rel, $ctx) : null;
        case 'GET':
        case 'HEAD':
            foreach ($c->wellKnown as $e) {
                $urlPath = $e['url'] === null ? null : substr($e['url'], strlen($c->origin));
                if ($urlPath !== null && covers($urlPath, $abs) && $e['url'] !== $c->storageBase . substr($e['path'], 1))
                    return serveFile($req, $e['path'] . substr($abs, strlen($urlPath)), $ctx);
            }
            return $rel === null ? null : serveFile($req, $rel, $ctx);
        default:
            return null;
    }
}
