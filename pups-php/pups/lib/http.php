<?php

namespace Pups;

/** An error that becomes a JSON response `{"error", "message"}` (RFC-6 "Errors"). */
final class HttpError extends \Exception
{
    public function __construct(public int $status, public string $error, string $message, public array $headers = [])
    {
        parent::__construct($message);
    }
}

function methodNotAllowed(string $allow): HttpError
{
    return new HttpError(405, 'method_not_allowed', 'Method not allowed', ['Allow' => $allow]);
}

/**
 * Size limits, in characters, for every string read from a request. Values over a limit are
 * rejected, never truncated, so nothing is silently changed.
 */
final class Limits
{
    /** client_id, redirect_uri, hrefs and other URLs. */
    const URL = 2048;
    /** The whole scope parameter (at most 20 scopes, see paths.php). */
    const SCOPE = 2048;
    /** OAuth state, echoed back to the app. */
    const STATE = 1024;
    /** Authorization codes, access and refresh tokens (ours have 43 characters). */
    const TOKEN = 256;
    const PASSWORD = 1024;
    /** Signed form fields and passkey responses. */
    const SIGNED = 16384;
    /** Request headers we read: Authorization, If-Match, If-None-Match, Content-Type, Range. */
    const HEADER = 1024;
    /** A request path or the POST fallback's path parameter, before percent-decoding. */
    const RAW_PATH = 2048;
    /** Repeated form fields (scope checkboxes). */
    const REPEATED = 1000;
    /** Everything else: grant_type, decision, action, method, IDs. */
    const SHORT = 256;
    /** Form bodies. */
    const FORM_BYTES = 65536;
    /** host_meta_endpoint bodies. */
    const JSON_BYTES = 16384;
}

/** The request, read from PHP's globals (or built by the tests). */
final class Request
{
    /** @var array<string, string> lowercase header name => value */
    public array $headers;
    private ?array $form = null;

    /** @param resource|null $body */
    public function __construct(public string $method, public string $target, array $headers = [], private $body = null)
    {
        $this->headers = array_change_key_case($headers, CASE_LOWER);
    }

    public static function fromGlobals(): self
    {
        $headers = [];
        foreach ($_SERVER as $k => $v)
            if (str_starts_with($k, 'HTTP_') && is_string($v))
                $headers[strtr(strtolower(substr($k, 5)), '_', '-')] = $v;
        foreach (['CONTENT_TYPE' => 'content-type', 'CONTENT_LENGTH' => 'content-length'] as $k => $name)
            if (isset($_SERVER[$k]) && $_SERVER[$k] !== '')
                $headers[$name] = $_SERVER[$k];
        // Apache under CGI/FastCGI drops Authorization unless .htaccess passes it on; look everywhere.
        $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null;
        if ($auth === null && function_exists('getallheaders'))
            foreach (getallheaders() ?: [] as $k => $v)
                if (strtolower($k) === 'authorization')
                    $auth = $v;
        if ($auth !== null && $auth !== '')
            $headers['authorization'] = $auth;
        return new self($_SERVER['REQUEST_METHOD'] ?? 'GET', $_SERVER['REQUEST_URI'] ?? '/', $headers, fopen('php://input', 'rb'));
    }

    /** The path, still percent-encoded, without the query. */
    public function path(): string
    {
        $p = explode('?', $this->target, 2)[0];
        // An absolute-form request target (http://host/path).
        return preg_match('#^[a-z][a-z0-9+.-]*://[^/]*(/.*)?$#Di', $p, $m) ? ($m[1] ?? '/') : $p;
    }

    public function queryString(): string
    {
        return explode('?', $this->target, 2)[1] ?? '';
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    /** @return resource */
    public function stream()
    {
        return $this->body ?? fopen('php://memory', 'rb');
    }

    /** Reads the body up to `max` bytes. Null if it is larger. */
    public function body(int $max): ?string
    {
        if ((int) ($this->header('content-length') ?? 0) > $max)
            return null;
        $data = stream_get_contents($this->stream(), $max + 1);
        return $data === false ? '' : (strlen($data) > $max ? null : $data);
    }

    /** The urlencoded form body (an empty form for other types). Throws 413 above 64 KB. */
    public function form(): array
    {
        if ($this->form !== null)
            return $this->form;
        if (!$this->isForm())
            return $this->form = [];
        $body = $this->body(Limits::FORM_BYTES);
        if ($body === null)
            throw new HttpError(413, 'too_large', 'The request body is too large');
        return $this->form = parseUrlencoded($body);
    }

    public function isForm(): bool
    {
        return strtolower(trim(explode(';', $this->header('content-type') ?? '')[0])) === 'application/x-www-form-urlencoded';
    }

    public function query(): array
    {
        return parseUrlencoded($this->queryString());
    }
}

/**
 * Parses `a=1&b=2&b=3` into ['a' => ['1'], 'b' => ['2', '3']]. Unlike PHP's parse_str, it
 * keeps repeated names (`scope=a&scope=b`) and treats `[` in names as an ordinary character.
 */
function parseUrlencoded(string $s): array
{
    $out = [];
    foreach (explode('&', $s) as $pair)
        if ($pair !== '') {
            [$k, $v] = array_pad(explode('=', $pair, 2), 2, '');
            $out[urldecode($k)][] = urldecode($v);
        }
    return $out;
}

function tooLong(string $name, int $max): HttpError
{
    return new HttpError(400, 'invalid_request', "$name is longer than $max characters");
}

/** A string value with a size limit. Throws 400 if it is longer. Null if empty or missing. */
function limited(?string $value, string $name, int $max): ?string
{
    if ($value === null || $value === '')
        return null;
    if (strlen($value) > $max)
        throw tooLong($name, $max);
    return $value;
}

/** A form field or query parameter that must appear at most once (null if repeated), at most `max` characters long. */
function field(array $params, string $name, int $max = Limits::SHORT): ?string
{
    $v = $params[$name] ?? [];
    return count($v) === 1 ? limited($v[0], $name, $max) : null;
}

/** All values of a repeated field: at most Limits::REPEATED values of at most `max` characters. */
function fields(array $params, string $name, int $max = Limits::SHORT): array
{
    $v = $params[$name] ?? [];
    if (count($v) > Limits::REPEATED)
        throw new HttpError(400, 'invalid_request', 'More than ' . Limits::REPEATED . " values for $name");
    return array_values(array_filter(array_map(fn($x) => limited($x, $name, $max), $v), fn($x) => $x !== null));
}

/** A request header, at most `max` characters long. */
function reqHeader(Request $req, string $name, int $max = Limits::HEADER): ?string
{
    return limited($req->header($name), $name, $max);
}

/** The response. Handlers build it; App::emit() sends it. */
final class Response
{
    /** @var array<string, array{string, string}> lowercase name => [name, value] */
    private array $headers = [];
    public ?string $body = null;
    /** A file to send instead of `body`: [path, offset, length]. */
    public ?array $file = null;
    /** Why the request failed, for the request log line. */
    public ?string $error = null;

    public function __construct(public int $status = 200, array $headers = [], ?string $body = null)
    {
        $this->set($headers);
        $this->body = $body;
    }

    public function set(array $headers): self
    {
        foreach ($headers as $k => $v)
            $this->headers[strtolower($k)] = [$k, (string) $v];
        return $this;
    }

    public function get(string $name): ?string
    {
        return $this->headers[strtolower($name)][1] ?? null;
    }

    public function remove(string $name): void
    {
        unset($this->headers[strtolower($name)]);
    }

    /** @return array<string, string> */
    public function headers(): array
    {
        return array_column($this->headers, 1, 0);
    }

    public function noteError(string $code, string $message): self
    {
        $this->error = "$code: $message";
        return $this;
    }
}

const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE;

function json(mixed $body, int $status = 200, array $headers = []): Response
{
    return new Response($status, ['Content-Type' => 'application/json; charset=utf-8'] + $headers, json_encode($body, JSON_FLAGS));
}

/** JSON documents for people and tools to read (discovery). */
function jsonDocument(mixed $body): Response
{
    return new Response(200, ['Content-Type' => 'application/json; charset=utf-8', 'Cache-Control' => 'no-cache',
        'X-Content-Type-Options' => 'nosniff'], json_encode($body, JSON_FLAGS | JSON_PRETTY_PRINT));
}

function errorResponse(HttpError $e): Response
{
    return json(['error' => $e->error, 'message' => $e->getMessage()], $e->status, $e->headers)->noteError($e->error, $e->getMessage());
}

const EXPOSE_HEADERS = 'ETag, Location, WWW-Authenticate, Retry-After';

/** CORS headers for everything but the owner pages (RFC-6 "CORS"). Safe as a wildcard: auth uses bearer tokens, never cookies. */
function corsHeaders(): array
{
    return ['Access-Control-Allow-Origin' => '*', 'Access-Control-Expose-Headers' => EXPOSE_HEADERS];
}

function preflight(): Response
{
    return new Response(204, corsHeaders() + [
        'Access-Control-Allow-Methods' => 'GET, HEAD, PUT, DELETE, POST, OPTIONS',
        'Access-Control-Allow-Headers' => 'Authorization, Content-Type, If-Match, If-None-Match, Range',
        'Access-Control-Max-Age' => '86400',
    ]);
}
