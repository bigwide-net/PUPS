<?php
/**
 * A tiny test framework and the test harness: each T is a fresh server with its own data
 * directory, a fake network for client metadata documents and a clock the test can move.
 * Requests run in-process through Pups\handle(); server_test.php also runs the real thing
 * on PHP's built-in server.
 */

namespace Pups\Test;

use Pups\Config;
use Pups\Ctx;
use Pups\Log;
use Pups\Request;
use function Pups\b64url;
use function Pups\hashPassword;
use function Pups\randomToken;
use function Pups\s256;

require_once __DIR__ . '/../pups/controller.php';

const ORIGIN = 'https://alice.pups.test';
const PASSWORD = 'correct horse battery staple';
const SETUP_SECRET = 'the-setup-secret-for-tests';

// --- Framework -----------------------------------------------------------------------------------

final class Failure extends \Exception
{
}

$GLOBALS['tests'] = [];

function test(string $name, callable $fn): void
{
    $GLOBALS['tests'][] = [$name, $fn];
}

function show(mixed $v): string
{
    return is_string($v) ? json_encode(strlen($v) > 300 ? substr($v, 0, 300) . '…' : $v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE)
        : json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
}

function eq(mixed $actual, mixed $expected, string $what = ''): void
{
    if ($actual !== $expected)
        throw new Failure(($what ? "$what: " : '') . 'expected ' . show($expected) . ', got ' . show($actual));
}

function ok(mixed $cond, string $what): void
{
    if (!$cond)
        throw new Failure($what);
}

function contains(string $haystack, string $needle, string $what = ''): void
{
    if (!str_contains($haystack, $needle))
        throw new Failure(($what ? "$what: " : '') . 'expected to contain ' . show($needle) . ' in ' . show($haystack));
}

function notContains(string $haystack, string $needle, string $what = ''): void
{
    if (str_contains($haystack, $needle))
        throw new Failure(($what ? "$what: " : '') . 'expected not to contain ' . show($needle));
}

function throws(callable $fn, string $messagePart): void
{
    try {
        $fn();
    } catch (\Throwable $e) {
        contains($e->getMessage(), $messagePart);
        return;
    }
    throw new Failure("expected an exception containing " . show($messagePart));
}

function runAll(?string $filter): int
{
    $failed = 0;
    $count = 0;
    foreach ($GLOBALS['tests'] as [$name, $fn]) {
        if ($filter && !str_contains($name, $filter))
            continue;
        $count++;
        Log::$lines = [];
        try {
            $fn();
            echo "  ✓ $name\n";
        } catch (\Throwable $e) {
            $failed++;
            $where = $e instanceof Failure ? basename($e->getTrace()[0]['file'] ?? '') . ':' . ($e->getTrace()[0]['line'] ?? '') : basename($e->getFile()) . ':' . $e->getLine();
            echo "  ✗ $name\n      " . get_class($e) . ': ' . $e->getMessage() . " ($where)\n";
        }
    }
    echo "\n" . ($count - $failed) . " passed, $failed failed\n";
    return $failed ? 1 : 0;
}

// --- Harness ------------------------------------------------------------------------------------

/** A response as the tests see it. */
final class Res
{
    public function __construct(public int $status, public array $headers, public string $text)
    {
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    public function json(): mixed
    {
        return json_decode($this->text, true);
    }

    public function location(): array
    {
        $loc = $this->header('location') ?? '';
        parse_str(parse_url($loc, PHP_URL_QUERY) ?? '', $q);
        return $q + ['_url' => explode('?', $loc)[0]];
    }
}

function tempDir(): string
{
    $dir = sys_get_temp_dir() . '/pups-test-' . randomToken(6);
    mkdir($dir, 0700, true);
    return $dir;
}

/** The value of a hidden form field. */
function hidden(string $html, string $name): string
{
    ok(preg_match('/name="' . preg_quote($name, '/') . '" value="([^"]*)"/', $html, $m), "no field $name in the page");
    return html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5);
}

/** The JSON embedded for owner.js. */
function pageJson(string $html, string $id): ?array
{
    return preg_match('#<script type="application/json" id="' . $id . '">(.*?)</script>#s', $html, $m) ? json_decode($m[1], true) : null;
}

function form(array $pairs): string
{
    $out = [];
    foreach ($pairs as $k => $v)
        foreach ((array) $v as $x)
            $out[] = rawurlencode((string) $k) . '=' . rawurlencode((string) $x);
    return implode('&', $out);
}

final class T
{
    public Ctx $ctx;
    public Config $config;
    public string $dataDir;
    /** client metadata documents by URL: ['status', 'body', 'cacheControl'] */
    public array $docs = [];
    /** Documents for webmention checks by URL: ['status', 'headers' (lowercase names), 'body']. */
    public array $web = [];
    /** URLs fetched for webmention checks, in order. */
    public array $fetched = [];
    /** Added to the clock, in ms. */
    public int $offset = 0;

    /**
     * The built-in mention and comment receiver is off unless a test turns it on
     * (mention_test.php), so that the other tests see host-meta.json and the configuration
     * document as they were before it existed.
     */
    public function __construct(array $config = [], bool $withOwner = true, ?string $dataDir = null)
    {
        Log::$quiet = true;
        $this->dataDir = $dataDir ?? tempDir();
        $this->config = Config::fromArray($config + ['origin' => ORIGIN, 'data_dir' => $this->dataDir, 'setup_secret' => SETUP_SECRET,
            'mentions' => false, 'comments' => false]);
        $this->ctx = new Ctx($this->config, fn(string $url) => $this->docs[$url] ?? ['status' => 404, 'body' => 'not found'],
            fn() => (int) floor(microtime(true) * 1000) + $this->offset, function (string $url) {
                $this->fetched[] = $url;
                return $this->web[$url] ?? ['status' => 404, 'headers' => [], 'body' => 'not found'];
            });
        if ($withOwner && !$this->ctx->state->owner())
            $this->ctx->state->createOwner(hashPassword(PASSWORD), null);
    }

    public function req(string $method, string $target, array $headers = [], string $body = ''): Res
    {
        $stream = fopen('php://memory', 'w+b');
        fwrite($stream, $body);
        rewind($stream);
        if ($body !== '' && !isset(array_change_key_case($headers)['content-length']))
            $headers['content-length'] = (string) strlen($body);
        $r = \Pups\handle(new Request($method, $target, $headers, $stream), $this->ctx);
        $text = $r->body ?? '';
        if ($r->file && $method !== 'HEAD') {
            [$path, $offset, $length] = $r->file;
            $text = (string) file_get_contents($path, false, null, $offset, $length);
        }
        return new Res($r->status, array_change_key_case($r->headers()), $method === 'HEAD' ? '' : $text);
    }

    public function get(string $target, array $headers = []): Res
    {
        return $this->req('GET', $target, $headers);
    }

    public function post(string $target, array|string $form, array $headers = []): Res
    {
        return $this->req('POST', $target, $headers + ['content-type' => 'application/x-www-form-urlencoded'], is_string($form) ? $form : form($form));
    }

    public function put(string $path, string $token, string $body, array $headers = []): Res
    {
        return $this->req('PUT', $path, array_merge(['authorization' => "Bearer $token", 'content-type' => 'application/json'], $headers), $body);
    }

    public function registerClient(string $host, array $extra = []): array
    {
        $clientId = "https://$host/oauth/client.json";
        $redirectUri = "https://$host/callback";
        $this->docs[$clientId] = ['status' => 200, 'body' => json_encode(array_merge(
            ['client_id' => $clientId, 'client_name' => 'Test App', 'redirect_uris' => [$redirectUri]], $extra), JSON_UNESCAPED_SLASHES)];
        return ['clientId' => $clientId, 'redirectUri' => $redirectUri, 'host' => $host];
    }

    public static function pkce(): array
    {
        $verifier = randomToken(32);
        return ['verifier' => $verifier, 'challenge' => s256($verifier)];
    }

    public static function authorizeUrl(array $c, string $scope, string $challenge, array $extra = []): string
    {
        return '/oauth/authorize?' . http_build_query(array_merge([
            'response_type' => 'code', 'client_id' => $c['clientId'], 'redirect_uri' => $c['redirectUri'], 'scope' => $scope, 'state' => 'xyz',
            'code_challenge' => $challenge, 'code_challenge_method' => 'S256',
        ], $extra), '', '&', PHP_QUERY_RFC3986);
    }

    /** Runs the authorization request and approves it. Returns [redirect response, verifier]. */
    public function approve(array $c, string $scope, ?array $grant = null, string $password = PASSWORD): array
    {
        $p = self::pkce();
        $page = $this->get(self::authorizeUrl($c, $scope, $p['challenge']));
        eq($page->status, 200, 'consent page');
        $res = $this->post('/oauth/authorize', ['request' => hidden($page->text, 'request'), 'decision' => 'approve', 'password' => $password,
            'scope' => $grant ?? explode(' ', $scope)]);
        return [$res, $p['verifier']];
    }

    public function exchange(array $c, string $code, string $verifier): Res
    {
        return $this->post('/oauth/token', ['grant_type' => 'authorization_code', 'code' => $code, 'client_id' => $c['clientId'],
            'redirect_uri' => $c['redirectUri'], 'code_verifier' => $verifier]);
    }

    /** Connects an app: authorization, approval and code exchange. Returns the token response. */
    public function connect(array $c, string $scope, ?array $grant = null): array
    {
        [$res, $verifier] = $this->approve($c, $scope, $grant);
        eq($res->status, 303, 'approval');
        $t = $this->exchange($c, $res->location()['code'], $verifier);
        eq($t->status, 200, 'code exchange');
        return $t->json();
    }

    public function refresh(array $c, string $token): Res
    {
        return $this->post('/oauth/token', ['grant_type' => 'refresh_token', 'refresh_token' => $token, 'client_id' => $c['clientId']]);
    }

    public function hostMeta(string $token, array $body): Res
    {
        return $this->req('POST', '/pups/host-meta', ['authorization' => "Bearer $token", 'content-type' => 'application/json'], json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }
}

// --- A software authenticator for the passkey tests --------------------------------------------------

/** A CBOR byte string (as opposed to a text string). */
final class Bytes
{
    public function __construct(public string $b)
    {
    }
}

function cbor(mixed $v): string
{
    $head = function (int $major, int $n): string {
        if ($n < 24)
            return chr($major << 5 | $n);
        if ($n < 256)
            return chr($major << 5 | 24) . chr($n);
        if ($n < 65536)
            return chr($major << 5 | 25) . pack('n', $n);
        return chr($major << 5 | 26) . pack('N', $n);
    };
    if (is_int($v))
        return $v >= 0 ? $head(0, $v) : $head(1, -1 - $v);
    if ($v instanceof Bytes)
        return $head(2, strlen($v->b)) . $v->b;
    if (is_string($v))
        return $head(3, strlen($v)) . $v;
    if (is_array($v) && array_is_list($v) && $v)
        return $head(4, count($v)) . implode('', array_map(fn($x) => cbor($x), $v));
    if (is_array($v)) {
        $out = $head(5, count($v));
        foreach ($v as $k => $x)
            $out .= cbor($k) . cbor($x);
        return $out;
    }
    throw new \LogicException('Unsupported CBOR value');
}

final class Authenticator
{
    public string $credId;
    private \OpenSSLAsymmetricKey $key;
    public int $counter = 0;

    public function __construct(public string $rpId, public string $origin)
    {
        $this->credId = random_bytes(16);
        $this->key = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
    }

    private function clientData(string $type, string $challenge, ?string $origin = null): string
    {
        return json_encode(['type' => $type, 'challenge' => $challenge, 'origin' => $origin ?? $this->origin, 'crossOrigin' => false], JSON_UNESCAPED_SLASHES);
    }

    /** A registration response for navigator.credentials.create() options, as JSON. */
    public function create(array $options): string
    {
        $ec = openssl_pkey_get_details($this->key)['ec'];
        $cose = cbor([1 => 2, 3 => -7, -1 => 1, -2 => new Bytes(str_pad($ec['x'], 32, "\0", STR_PAD_LEFT)), -3 => new Bytes(str_pad($ec['y'], 32, "\0", STR_PAD_LEFT))]);
        $authData = hash('sha256', $this->rpId, true) . chr(0x45) . pack('N', $this->counter) . str_repeat("\0", 16)
            . pack('n', strlen($this->credId)) . $this->credId . $cose;
        return json_encode(['id' => b64url($this->credId), 'rawId' => b64url($this->credId), 'type' => 'public-key', 'response' => [
            'clientDataJSON' => b64url($this->clientData('webauthn.create', $options['challenge'])),
            'attestationObject' => b64url(cbor(['fmt' => 'none', 'attStmt' => [], 'authData' => new Bytes($authData)])),
            'transports' => ['internal'],
        ]]);
    }

    /** An assertion for navigator.credentials.get() options, as JSON. */
    public function get(array $options, ?string $origin = null, int $flags = 0x05): string
    {
        $this->counter++;
        $authData = hash('sha256', $this->rpId, true) . chr($flags) . pack('N', $this->counter);
        $clientData = $this->clientData('webauthn.get', $options['challenge'], $origin);
        openssl_sign($authData . hash('sha256', $clientData, true), $sig, $this->key, OPENSSL_ALGO_SHA256);
        return json_encode(['id' => b64url($this->credId), 'rawId' => b64url($this->credId), 'type' => 'public-key', 'response' => [
            'clientDataJSON' => b64url($clientData), 'authenticatorData' => b64url($authData), 'signature' => b64url($sig),
        ]]);
    }
}
