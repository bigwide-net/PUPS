<?php
/**
 * The Personal Upload Server (RFC-6) for PHP: routing, error handling and sending the
 * response. index.php calls run(); the tests call handle() directly. See README.md.
 */

namespace Pups;

foreach (['sanitize', 'crypto', 'http', 'config', 'log', 'paths', 'filetypes', 'state', 'storage', 'cimd', 'webauthn', 'html', 'owner', 'context', 'content', 'feeds', 'inbox'] as $f)
    require_once __DIR__ . "/lib/$f.php";
foreach (['discovery', 'hostmeta', 'files', 'oauth', 'admin', 'setup', 'mentions', 'inbox'] as $f)
    require_once __DIR__ . "/handler/$f.php";

/** Paths (relative to the base) that are never CORS-enabled: the owner pages and their assets. */
const OWNER_PAGES = ['/', '/oauth/authorize', '/pups/apps', '/pups/sign-in', '/pups/server', '/pups/setup', '/pups/inbox/dismiss', '/pups/assets/owner.css', '/pups/assets/owner.js'];

/** Handles one request. Never throws. */
function handle(Request $req, Ctx $ctx): Response
{
    $c = $ctx->config;
    $abs = $req->path();
    $b = $c->basePath;
    // The path relative to the base, or null if the request is outside it (/.well-known/ in a folder installation).
    $rel = $b === '' ? $abs : ($abs === $b ? '/' : (str_starts_with($abs, "$b/") ? substr($abs, strlen($b)) : null));
    $ownerPage = $rel !== null && in_array($rel, OWNER_PAGES, true);
    ensureMentionLink($ctx);
    try {
        if ($req->method === 'OPTIONS' && !$ownerPage)
            $res = preflight();
        else
            $res = dispatch($req, $abs, $rel, $ctx) ?? throw new HttpError(404, 'not_found', 'Not found');
    } catch (HttpError $e) {
        $res = errorResponse($e);
    } catch (\Throwable $e) {
        Log::event('error', ['url' => $req->target, 'error' => get_class($e) . ': ' . $e->getMessage(), 'at' => basename($e->getFile()) . ':' . $e->getLine()]);
        $res = json(['error' => 'server_error', 'message' => 'Internal server error'], 500)->noteError('server_error', $e->getMessage());
    }
    if (!$ownerPage)
        $res->set(corsHeaders());
    if (str_starts_with($c->origin, 'https:'))
        $res->set(['Strict-Transport-Security' => 'max-age=31536000']);
    return $res;
}

function dispatch(Request $req, string $abs, ?string $rel, Ctx $ctx): ?Response
{
    $c = $ctx->config;
    $m = $req->method === 'HEAD' ? 'GET' : $req->method;
    // Served at the domain root, also in a folder installation.
    if ($abs === HOST_META_PATH && $m === 'GET')
        return hostMetaDocument($ctx);
    if ($abs === OAUTH_METADATA_PATH && $m === 'GET')
        return jsonDocument(oauthMetadata($c));
    switch ($rel) {
        case '/':
            return $m === 'GET' ? startPage($ctx) : null;
        case CONFIG_PATH:
            return $m === 'GET' ? jsonDocument(configDocument($c)) : null;
        case '/oauth/authorize':
            return htmlErrors($c, fn() => match ($m) {
                'GET' => authorize($req, $ctx),
                'POST' => decide($req, $ctx),
                default => errorPage($c, 'Method not allowed', 'Use GET or POST.', 405),
            });
        case '/oauth/token':
            return token($req, $ctx);
        case '/oauth/revoke':
            return revoke($req, $ctx);
        case '/pups/setup':
            return setupEndpoint($req, $ctx);
        case '/pups/apps':
            return appsEndpoint($req, $ctx);
        case '/pups/sign-in':
            return signInEndpoint($req, $ctx);
        case '/pups/server':
            return serverEndpoint($req, $ctx);
        case '/pups/host-meta':
            return hostMetaEndpoint($req, $ctx);
        case '/pups/probe':
            return probeEndpoint($req);
        case '/pups/post':
            return $c->postFallback ? postEndpoint($req, $ctx) : null;
        case '/pups/assets/owner.css':
        case '/pups/assets/owner.js':
            return asset(substr($rel, 13));
        case '/pups/mention':
            return mentionEndpoint($req, $ctx);
        case '/pups/comments':
            return commentEndpoint($req, $ctx);
        case '/pups/inbox/action':
            return inboxActionEndpoint($req, $ctx);
        case '/pups/inbox/dismiss':
            return htmlErrors($c, fn() => dismissPage($req, $ctx));
    }
    if ($rel !== null && str_starts_with($rel, '/pups/comments/status/'))
        return commentStatusEndpoint($req, substr($rel, 22), $ctx);
    return fileRoutes($req, $abs, $rel, $ctx);
}

function asset(string $name): Response
{
    return new Response(200, [
        'Content-Type' => (str_ends_with($name, '.js') ? 'text/javascript' : 'text/css') . '; charset=utf-8',
        'Cache-Control' => 'public, max-age=86400', 'X-Content-Type-Options' => 'nosniff',
    ], file_get_contents(__DIR__ . "/assets/$name"));
}

/** Sends a response with PHP's functions. */
function emit(Response $res, Request $req): int
{
    if ($res->file === null && $res->body !== null)
        $res->set(['Content-Length' => strlen($res->body)]);
    http_response_code($res->status);
    header_remove('X-Powered-By');
    foreach ($res->headers() as $k => $v)
        \header("$k: $v");
    if ($req->method === 'HEAD')
        return 0;
    if ($res->file === null) {
        echo $res->body ?? '';
        return strlen($res->body ?? '');
    }
    // Large files: no output buffering, no compression (it would break ranges and Content-Length).
    while (ob_get_level())
        ob_end_clean();
    [$path, $offset, $length] = $res->file;
    $f = fopen($path, 'rb');
    fseek($f, $offset);
    $left = $length;
    while ($left > 0 && !feof($f) && ($chunk = fread($f, min(65536, $left))) !== false && $chunk !== '') {
        echo $chunk;
        $left -= strlen($chunk);
        flush();
    }
    fclose($f);
    return $length - $left;
}

/** The base path from the script's URL: '' at the domain root, else e.g. '/pups'. */
function detectBasePath(): string
{
    if (PHP_SAPI === 'cli-server')
        return '';
    $script = str_replace('\\', '/', $_SERVER['SCRIPT_NAME'] ?? '');
    return str_ends_with($script, '/index.php') ? substr($script, 0, -10) : '';
}

/** Loads config.php (and what the checks detected). Throws \InvalidArgumentException. */
function loadConfig(string $dir): Config
{
    $file = "$dir/config.php";
    if (!is_file($file))
        throw new \InvalidArgumentException('config.php is missing. Copy config.example.php to config.php and fill it in (see README.md).');
    $array = require $file;
    if (!is_array($array))
        throw new \InvalidArgumentException('config.php must return an array (see config.example.php).');
    $array['data_dir'] ??= "$dir/data";
    $detected = json_decode(@file_get_contents($array['data_dir'] . '/detected.json') ?: '[]', true) ?: [];
    return Config::fromArray($array, $detected, detectBasePath());
}

/** The entry point for index.php. */
function run(string $dir): void
{
    $start = microtime(true);
    ini_set('display_errors', '0');
    if (function_exists('apache_setenv'))
        @apache_setenv('no-gzip', '1');
    @ini_set('zlib.output_compression', '0');
    // Large uploads and downloads on slow connections.
    @set_time_limit(300);
    $req = Request::fromGlobals();
    try {
        $config = loadConfig($dir);
        Log::$file = Log::file($config->dataDir);
        $ctx = new Ctx($config);
    } catch (\Throwable $e) {
        http_response_code(500);
        \header('Content-Type: text/plain; charset=utf-8');
        echo "PUPS is not configured correctly:\n\n" . $e->getMessage() . "\n";
        error_log('PUPS: ' . $e->getMessage());
        return;
    }
    $res = handle($req, $ctx);
    $out = emit($res, $req);
    Log::event('http', [
        'method' => $req->method, 'url' => $req->target, 'status' => $res->status, 'ms' => (int) round((microtime(true) - $start) * 1000),
        'in' => $req->header('content-length'), 'out' => $out, 'error' => $res->error, 'ua' => $req->header('user-agent'),
    ]);
    // Webmentions are checked after the response, as they mean fetching documents from other servers.
    if ($ctx->workPending) {
        $how = finishResponse();
        @set_time_limit(60);
        Log::event('mention.worker', ['finish' => $how, 'done' => processQueue($ctx)]);
    }
}
