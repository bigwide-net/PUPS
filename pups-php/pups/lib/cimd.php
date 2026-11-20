<?php

namespace Pups;

/** A client metadata document that can't be used; shown to the owner. */
final class ClientError extends \Exception
{
}

const MAX_DOC_BYTES = 64 * 1024;
const FETCH_TIMEOUT = 5;
const MAX_CACHE_MS = 24 * 3600_000;
const MAX_REDIRECT_URIS = 20;
/** client_name may have this many characters; at most 100 are shown. */
const MAX_NAME_CHARS = 1000;

// --- SSRF protection -------------------------------------------------------------------------

/** Is an IP address public? Private, loopback, link-local, CGNAT, documentation, multicast and reserved ranges are not. */
function isPublicAddress(string $ip): bool
{
    $bin = @inet_pton($ip);
    if ($bin === false)
        return false;
    if (strlen($bin) === 16 && str_starts_with($bin, str_repeat("\0", 10) . "\xff\xff"))
        return isPublicAddress(inet_ntop(substr($bin, 12)));
    $ranges = strlen($bin) === 4
        ? [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
            ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
            ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]
        : [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]];
    foreach ($ranges as [$net, $bits])
        if (inSubnet($bin, inet_pton($net), $bits))
            return false;
    return true;
}

function inSubnet(string $ip, string $net, int $bits): bool
{
    if (strlen($ip) !== strlen($net))
        return false;
    $bytes = intdiv($bits, 8);
    if (substr($ip, 0, $bytes) !== substr($net, 0, $bytes))
        return false;
    $rest = $bits % 8;
    return !$rest || (ord($ip[$bytes]) >> (8 - $rest)) === (ord($net[$bytes]) >> (8 - $rest));
}

/** All IPv4 and IPv6 addresses of a host name. */
function resolveHost(string $host): array
{
    $ips = [];
    if (function_exists('dns_get_record'))
        foreach (@dns_get_record($host, DNS_A | DNS_AAAA) ?: [] as $r)
            $ips[] = $r['ip'] ?? $r['ipv6'];
    // dns_get_record ignores /etc/hosts and is disabled on some hosts.
    foreach (@gethostbynamel($host) ?: [] as $ip)
        $ips[] = $ip;
    return array_values(array_unique(array_filter($ips)));
}

/**
 * A minimal HTTP/1.0 client on PHP streams (no cURL needed). It connects to an address it
 * resolved and checked itself, so DNS rebinding can't get around the address check, and
 * verifies the certificate against the host name.
 * Returns ['status', 'headers' (lowercase name => value), 'body' (null if larger than `maxBytes`)].
 */
function httpRequest(string $method, string $url, array $headers = [], string $body = '', array $opts = []): array
{
    if (!preg_match('#^(https?)://([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d+))?(/[^\s\#]*)?$#Di', $url, $m))
        throw new \RuntimeException('Invalid URL');
    [, $scheme, $host] = $m;
    $port = (int) (($m[3] ?? '') ?: ($scheme === 'https' ? 443 : 80));
    $target = ($m[4] ?? '') ?: '/';
    $bare = trim($host, '[]');
    $ips = filter_var($bare, FILTER_VALIDATE_IP) ? [$bare] : resolveHost($host);
    if (!$ips)
        throw new \RuntimeException("$host could not be resolved");
    if (($opts['publicOnly'] ?? false) && array_filter($ips, fn($ip) => !isPublicAddress($ip)))
        throw new \RuntimeException("$host resolves to a non-public address");
    usort($ips, fn($a, $b) => str_contains($a, ':') <=> str_contains($b, ':'));
    $ip = $ips[0];
    $ssl = ['peer_name' => $bare, 'SNI_enabled' => true, 'verify_peer' => true, 'verify_peer_name' => true];
    if ($ca = caBundle($opts['extraCa'] ?? null))
        $ssl['cafile'] = $ca;
    $timeout = $opts['timeout'] ?? FETCH_TIMEOUT;
    $address = ($scheme === 'https' ? 'ssl' : 'tcp') . '://' . (str_contains($ip, ':') ? "[$ip]" : $ip) . ":$port";
    $s = @stream_socket_client($address, $errno, $errstr, $timeout, STREAM_CLIENT_CONNECT, stream_context_create(['ssl' => $ssl]));
    if (!$s)
        throw new \RuntimeException("Connection to $host failed: " . ($errstr ?: 'TLS or network error'));
    stream_set_timeout($s, $timeout);
    $request = "$method $target HTTP/1.0\r\nHost: $host" . (($m[3] ?? '') ? ":$port" : '') . "\r\nConnection: close\r\n";
    foreach ($headers + ['User-Agent' => 'pups-php/' . VERSION] as $k => $v)
        $request .= "$k: $v\r\n";
    if ($body !== '' || in_array($method, ['POST', 'PUT'], true))
        $request .= 'Content-Length: ' . strlen($body) . "\r\n";
    fwrite($s, "$request\r\n$body");
    $max = $opts['maxBytes'] ?? MAX_DOC_BYTES;
    $deadline = microtime(true) + $timeout;
    $data = '';
    while (!feof($s) && strlen($data) <= $max + 16384) {
        if (microtime(true) > $deadline || stream_get_meta_data($s)['timed_out']) {
            fclose($s);
            throw new \RuntimeException('timeout');
        }
        $data .= (string) fread($s, 8192);
    }
    $complete = feof($s);
    fclose($s);
    $split = strpos($data, "\r\n\r\n");
    if ($split === false || !preg_match('#^HTTP/\d(?:\.\d)? (\d{3})#', $data, $sm))
        throw new \RuntimeException('Invalid HTTP response');
    $out = ['status' => (int) $sm[1], 'headers' => [], 'body' => null];
    foreach (array_slice(explode("\r\n", substr($data, 0, $split)), 1) as $line)
        if (str_contains($line, ':')) {
            [$k, $v] = explode(':', $line, 2);
            $out['headers'][strtolower(trim($k))] = trim($v);
        }
    $content = substr($data, $split + 4);
    if (stripos($out['headers']['transfer-encoding'] ?? '', 'chunked') !== false)
        $content = dechunk($content);
    if ($complete && strlen($content) <= $max)
        $out['body'] = $content;
    return $out;
}

function dechunk(string $s): string
{
    $out = '';
    while (preg_match('/^([0-9a-f]+)[^\r]*\r\n/i', $s, $m) && ($n = hexdec($m[1])) > 0) {
        $out .= substr($s, strlen($m[0]), $n);
        $s = substr($s, strlen($m[0]) + $n + 2);
    }
    return $out;
}

/** The default CA bundle plus an extra CA (e.g. mkcert's), as one file in the temp directory. */
function caBundle(?string $extraCa): ?string
{
    if ($extraCa === null)
        return null;
    $default = openssl_get_cert_locations()['default_cert_file'] ?? '';
    $file = sys_get_temp_dir() . '/pups-ca-' . md5($extraCa . filemtime($extraCa)) . '.pem';
    if (!is_file($file))
        file_put_contents($file, (is_readable($default) ? file_get_contents($default) . "\n" : '') . file_get_contents($extraCa));
    return $file;
}

/** Fetches a client metadata document over HTTPS: 5 s timeout, 64 KB limit, no redirects, public addresses only. */
function httpsFetchDoc(Config $c): callable
{
    return function (string $url) use ($c) {
        $r = httpRequest('GET', $url, ['Accept' => 'application/json'], '', ['publicOnly' => !$c->allowPrivateClients, 'extraCa' => $c->extraCa]);
        return ['status' => $r['status'], 'cacheControl' => $r['headers']['cache-control'] ?? null, 'body' => $r['body']];
    };
}

// --- Validation ------------------------------------------------------------------------------

/** URL path and query characters that are already in canonical form (no percent-encoding needed). */
const URL_CHARS = "A-Za-z0-9\\-._~!$&'()*+,;=:@/%";

/**
 * Validates a client_id URL: HTTPS, a domain name, a path, nothing else, and in canonical
 * form. Returns its host.
 */
function parseClientId(string $clientId, Config $c): string
{
    if (!preg_match('#^([a-z][a-z0-9+.-]*):#Di', $clientId, $m) || strtolower($m[1]) !== 'https')
        throw new ClientError('client_id must be an HTTPS URL');
    if (!preg_match('#^https://([^/?\#]*)(/[^?\#]*)?$#D', $clientId, $m))
        throw new ClientError('client_id must not contain user info, a port, a query or a fragment');
    $host = $m[1];
    $path = $m[2] ?? '';
    if (str_contains($host, '@') || preg_match('/:\d*$/D', $host))
        throw new ClientError('client_id must not contain user info, a port, a query or a fragment');
    if ($path === '' || $path === '/')
        throw new ClientError('client_id must have a path');
    if (preg_match('/^\d{1,3}(\.\d{1,3}){3}$/D', $host) || str_starts_with($host, '[') || !str_contains($host, '.') || $host === 'localhost' || str_ends_with($host, '.localhost'))
        throw new ClientError('client_id must be on a domain name');
    if (!isHostName($host))
        throw new ClientError('The host of client_id may contain only lowercase letters, digits, hyphens and dots (IDNs in punycode)');
    if (!preg_match('#^[' . URL_CHARS . ']*$#D', $path) || preg_match('/%(?![0-9A-Fa-f]{2})/', $path)
            || preg_match('#/(\.|%2e){1,2}(/|$)#i', $path))
        throw new ClientError('client_id is not in canonical form (normalized, percent-encoded path)');
    if ($host === $c->host)
        throw new ClientError("client_id can't be on this server's own host");
    return $host;
}

/** client_uri and logo_uri must be on the client host, with or without a leading `www.`. */
function onClientHost(mixed $url, string $clientHost): bool
{
    if (!isCleanUrlString($url) || !preg_match('#^https://([a-z0-9.-]+)(/[' . URL_CHARS . '?]*)?$#D', $url, $m))
        return false;
    $h = $m[1];
    return $h === $clientHost || $h === "www.$clientHost" || (str_starts_with($clientHost, 'www.') && $h === substr($clientHost, 4));
}

/** A loopback redirect URI without its port, or null. */
function loopbackWithoutPort(string $uri): ?string
{
    return preg_match('#^(http://(?:127\.0\.0\.1|\[::1\]))(?::\d{1,5})?(/.*)?$#Ds', $uri, $m) ? $m[1] . ($m[2] ?? '/') : null;
}

function validRedirectUri(mixed $r): bool
{
    return isCleanUrlString($r) && !str_contains($r, '#') && preg_match('#^(?:https://([a-z0-9.-]+)(?::\d{1,5})?|http://(?:127\.0\.0\.1|\[::1\])(?::\d{1,5})?)(/[' . URL_CHARS . '?]*)?$#D', $r, $m)
        && (($m[1] ?? '') === '' || isHostName($m[1]));
}

/** Validates a fetched client metadata document. Returns the client. */
function validateMetadata(mixed $doc, string $clientId, string $clientHost): array
{
    if (!is_array($doc) || ($doc && array_is_list($doc)))
        throw new ClientError('The client metadata document is not a JSON object');
    if (($doc['client_id'] ?? null) !== $clientId)
        throw new ClientError('client_id in the client metadata document does not match its URL');
    $uris = $doc['redirect_uris'] ?? null;
    if (!is_array($uris) || !$uris || !array_is_list($uris) || count($uris) > MAX_REDIRECT_URIS || array_filter($uris, fn($r) => !validRedirectUri($r)))
        throw new ClientError('redirect_uris must be a non-empty array of at most ' . MAX_REDIRECT_URIS . ' HTTPS URLs with a DNS host name, or loopback (http://127.0.0.1, http://[::1]) URLs, without whitespace or control characters, each at most 2048 characters');
    foreach (['client_uri', 'logo_uri'] as $f)
        if (isset($doc[$f]) && !onClientHost($doc[$f], $clientHost))
            throw new ClientError("$f must be an HTTPS URL on the client host $clientHost (optionally with or without www.)");
    $name = $doc['client_name'] ?? null;
    if ($name !== null && (!is_string($name) || preg_match_all('/./su', $name) > MAX_NAME_CHARS))
        throw new ClientError('client_name must be a string of at most ' . MAX_NAME_CHARS . ' characters');
    if (($doc['token_endpoint_auth_method'] ?? 'none') !== 'none')
        throw new ClientError('Only public clients (token_endpoint_auth_method "none") are supported');
    // The name is self-declared text: sanitized for display.
    return [
        'clientId' => $clientId, 'clientHost' => $clientHost, 'redirectUris' => $uris, 'name' => sanitizeText($name, 100),
        'uri' => $doc['client_uri'] ?? null, 'logo' => $doc['logo_uri'] ?? null,
    ];
}

function cacheMs(?string $cacheControl): int
{
    if (!$cacheControl || preg_match('/no-store|no-cache|private/i', $cacheControl))
        return 0;
    return preg_match('/max-age=(\d+)/i', $cacheControl, $m) ? min((int) $m[1] * 1000, MAX_CACHE_MS) : 0;
}

/**
 * Loads client metadata documents, with a cache in data/clients.json that follows
 * Cache-Control (at most 24 hours).
 */
final class ClientLoader
{
    /** @var callable(string): array */
    private $fetch;

    public function __construct(private Config $config, private State $state, ?callable $fetch = null)
    {
        $this->fetch = $fetch ?? httpsFetchDoc($config);
    }

    private function cacheFile(): string
    {
        return $this->config->dataDir . '/clients.json';
    }

    public function load(string $clientId): array
    {
        $host = parseClientId($clientId, $this->config);
        $now = $this->state->now();
        $cache = json_decode(@file_get_contents($this->cacheFile()) ?: '{}', true) ?: [];
        $cached = $cache[$clientId] ?? null;
        if ($cached && $cached['expiresAt'] > $now) {
            Log::event('cimd.cached', ['clientId' => $clientId, 'expires' => gmdate('c', intdiv($cached['expiresAt'], 1000))]);
            return validateMetadata($cached['doc'], $clientId, $host);
        }
        try {
            $res = ($this->fetch)($clientId);
        } catch (\Throwable $e) {
            Log::event('cimd.fetch-failed', ['clientId' => $clientId, 'error' => $e->getMessage()]);
            throw new ClientError("The client metadata document at $clientId could not be fetched: {$e->getMessage()}");
        }
        Log::event('cimd.fetched', ['clientId' => $clientId, 'status' => $res['status'], 'cacheControl' => $res['cacheControl'] ?? null, 'body' => $res['body']]);
        if ($res['status'] >= 300 && $res['status'] < 400)
            throw new ClientError('The client metadata document must be served without redirects');
        if ($res['status'] !== 200)
            throw new ClientError("Fetching the client metadata document returned HTTP {$res['status']}");
        if ($res['body'] === null)
            throw new ClientError('The client metadata document is larger than 64 KB');
        try {
            $doc = json_decode($res['body'], true, 64, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new ClientError('The client metadata document is not valid JSON');
        }
        try {
            $client = validateMetadata($doc, $clientId, $host);
        } catch (ClientError $e) {
            Log::event('cimd.invalid', ['clientId' => $clientId, 'error' => $e->getMessage()]);
            throw $e;
        }
        if ($ttl = cacheMs($res['cacheControl'] ?? null)) {
            // Anyone can make the server fetch documents, so the cache keeps only the newest 50.
            $cache = array_slice(array_filter($cache, fn($e) => $e['expiresAt'] > $now), -49, null, true);
            unset($cache[$clientId]);
            $cache[$clientId] = ['doc' => $doc, 'expiresAt' => $now + $ttl];
            writeAtomic($this->cacheFile(), json_encode($cache, JSON_FLAGS));
        }
        return $client;
    }
}

/** Exact match; for loopback redirect URIs the port is ignored (RFC 8252). */
function redirectUriAllowed(array $client, string $redirectUri): bool
{
    if (in_array($redirectUri, $client['redirectUris'], true))
        return true;
    $req = validRedirectUri($redirectUri) ? loopbackWithoutPort($redirectUri) : null;
    if ($req === null)
        return false;
    foreach ($client['redirectUris'] as $r)
        if (loopbackWithoutPort($r) === $req)
            return true;
    return false;
}
