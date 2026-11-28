<?php
// Sanitizing, untrusted input and size limits, ported from the former Node test server; unit tests.

namespace Pups\Test;

use function Pups\canonicalHref;
use function Pups\escapeUnsafe;
use function Pups\isCspOrigin;
use function Pups\isHostName;
use function Pups\isPublicAddress;
use function Pups\parseWellKnown;
use function Pups\sanitizeText;
use function Pups\visible;

/** A character by code point, so that this file contains no invisible characters. */
function ch(int $cp): string
{
    return mb_chr($cp, 'UTF-8');
}

test('sanitize: cleans self-declared text like Downread', function () {
    eq(sanitizeText(' a' . ch(0x202e) . 'b' . ch(0x200b) . "\n\tc\x07 " . ch(0xfeff), 100), 'ab c');
    $family = ch(0x1f468) . ch(0x200d) . ch(0x1f469) . ch(0x200d) . ch(0x1f467);
    eq(sanitizeText("$family family", 100), "$family family");
    eq(sanitizeText(str_repeat(ch(0x1f600), 4), 3), ch(0x1f600) . ch(0x1f600) . '…');
    eq(sanitizeText(ch(0x200b), 10), null);
    eq(sanitizeText(42, 10), null);
    eq(sanitizeText("a\xffb", 10), null, 'invalid UTF-8');
});

test('sanitize: makes unsafe characters visible or escapes them', function () {
    eq(visible('/a' . ch(0x202e) . 'b'), '/a\\u{202e}b');
    eq(escapeUnsafe("x\x1b[31m" . ch(0x9b)), 'x\\u001b[31m\\u009b');
    eq(visible("a\xffb"), 'a\\u{fffd}b', 'invalid UTF-8');
});

test('sanitize: checks host names and CSP origins strictly', function () {
    eq(isHostName('app.example'), true);
    eq(isHostName('xn--bcher-kva.example'), true);
    foreach (['x;sandbox', "a'b.example", 'a$b.example', '-a.example', 'localhost', 'App.example', "app.example\n"] as $h)
        eq([$h, isHostName($h)], [$h, false]);
    eq(isCspOrigin('https://app.example'), true);
    eq(isCspOrigin('http://127.0.0.1:5173'), true);
    eq(isCspOrigin('https://x;sandbox'), false);
    eq(isCspOrigin('http://app.example'), false);
    eq(isCspOrigin("https://app.example\n"), false);
});

test('untrusted input: sanitizes and encodes the self-declared name on the consent screen and the apps page', function () {
    $t = new T();
    $c = $t->registerClient('app.example', ['client_name' => 'Good' . ch(0x202e) . " App\n<script>alert(1)</script>" . ch(0x200b) . '"x"']);
    $page = $t->get(T::authorizeUrl($c, 'write:/appdata/app.example/', T::pkce()['challenge']));
    eq($page->status, 200);
    contains($page->text, 'Did you mean to log in with “<bdi>Good App &lt;script&gt;alert(1)&lt;/script&gt;&quot;x&quot;</bdi>”?');
    notContains($page->text, '<script>alert');
    notContains($page->text, ch(0x202e));
    notContains($page->text, ch(0x200b));
    $t->connect($c, 'write:/appdata/app.example/');
    $apps = $t->post('/pups/apps', ['password' => PASSWORD]);
    contains($apps->text, '<bdi>Good App &lt;script&gt;');
    notContains($apps->text, ch(0x202e));
});

test('untrusted input: rejects unsafe URLs and host names in client metadata', function () {
    $t = new T();
    $challenge = T::pkce()['challenge'];
    foreach ([['logo_uri' => 'javascript:alert(1)'], ['logo_uri' => 'https://app.example/a b.png'], ['logo_uri' => 'https://app.example/' . ch(0x202e) . 'gnp.png'],
        ['logo_uri' => 'https://app.example/a"onerror="x.png'], ['redirect_uris' => ['https://app.example;sandbox/cb']], ['redirect_uris' => ['https://app.example/cb#x']],
        ['redirect_uris' => 'https://app.example/cb'], ['token_endpoint_auth_method' => 'client_secret_basic']] as $extra) {
        $c = $t->registerClient('app.example', $extra);
        eq([$extra, $t->get(T::authorizeUrl(['redirectUri' => 'https://app.example;sandbox/cb'] + $c, 'identify', $challenge))->status], [$extra, 400]);
    }
    $res = $t->get(T::authorizeUrl($t->registerClient('x;sandbox.example'), 'identify', $challenge));
    eq($res->status, 400);
    contains($res->text, 'may contain only lowercase letters, digits, hyphens and dots');
    $t->docs['https://bad.example/oauth/client.json'] = ['status' => 200, 'body' => '{not json'];
    contains($t->get(T::authorizeUrl(['clientId' => 'https://bad.example/oauth/client.json', 'redirectUri' => 'https://bad.example/cb'], 'identify', $challenge))->text, 'not valid JSON');
    $t->docs['https://big.example/oauth/client.json'] = ['status' => 200, 'body' => null];
    contains($t->get(T::authorizeUrl(['clientId' => 'https://big.example/oauth/client.json', 'redirectUri' => 'https://big.example/cb'], 'identify', $challenge))->text, 'larger than 64 KB');
    $t->docs['https://moved.example/oauth/client.json'] = ['status' => 301, 'body' => ''];
    contains($t->get(T::authorizeUrl(['clientId' => 'https://moved.example/oauth/client.json', 'redirectUri' => 'https://moved.example/cb'], 'identify', $challenge))->text, 'without redirects');
});

test('untrusted input: keeps the consent page CSP to plain origins', function () {
    $t = new T();
    $c = $t->registerClient('app.example', ['redirect_uris' => ['http://127.0.0.1/cb']]);
    $res = $t->get(T::authorizeUrl(['redirectUri' => 'http://127.0.0.1:5173/cb'] + $c, 'identify', T::pkce()['challenge']));
    contains($res->header('content-security-policy'), "form-action 'self' http://127.0.0.1:5173;");
});

test('untrusted input: rejects invisible characters in paths, scopes and host-meta values; stores canonical hrefs', function () {
    $t = new T(['well_known_paths' => [
        ['path' => '/.well-known/about.md', 'url' => ORIGIN . '/.well-known/about.md', 'properties' => ['https://bigwide.net/ns/name']],
        ['path' => '/feeds/'],
    ]]);
    $c = $t->registerClient('app.example');
    eq($t->get(T::authorizeUrl($c, 'write:/feeds/%E2%80%AEx/', T::pkce()['challenge']))->location()['error'], 'invalid_scope');
    $tok = $t->connect($c, 'write:/appdata/app.example/ write:/.well-known/about.md')['access_token'];
    eq($t->put('/appdata/app.example/%E2%80%AEnosj.json', $tok, '{}')->status, 400);
    eq($t->put('/appdata/app.example/a%E2%81%A6.json', $tok, '{}')->status, 400);
    eq($t->hostMeta($tok, ['action' => 'set-property', 'property' => 'https://bigwide.net/ns/name', 'value' => 'Alice' . ch(0x202e)])->status, 400);
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => 'https://app.example/r' . ch(0x200b), 'href' => ORIGIN . '/appdata/app.example/a.json'])->status, 400);
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => 'https://app.example/r', 'href' => ORIGIN . '/appdata/app.example/a<b>.json'])->status, 201);
    eq($t->get('/.well-known/host-meta.json')->json()['links'][1]['href'], ORIGIN . '/appdata/app.example/a%3Cb%3E.json');
});

test('untrusted input: canonical hrefs', function () {
    eq(canonicalHref('HTTPS://Alice.Pups.Test:443/a b/ü?q=<x>#f g'), 'https://alice.pups.test/a%20b/%C3%BC?q=%3Cx%3E#f%20g');
    eq(canonicalHref('http://alice.pups.test'), 'http://alice.pups.test/');
    eq(canonicalHref('https://alice.pups.test/a%2Fb%zz'), 'https://alice.pups.test/a%2Fb%25zz');
    foreach (['javascript:alert(1)', 'https://u@alice.pups.test/', 'https://alice.pups.test/a/../b', 'https://alice.pups.test\\x', 'ftp://alice.pups.test/'] as $bad)
        throws(fn() => canonicalHref($bad), 'href must be');
});

test('size limits: reject oversized authorization parameters with an error page', function () {
    $t = new T();
    $c = $t->registerClient('app.example');
    $challenge = T::pkce()['challenge'];
    foreach ([['state' => str_repeat('x', 1025)], ['scope' => str_repeat('identify ', 300)]] as $extra) {
        $res = $t->get(T::authorizeUrl($c, 'identify', $challenge, $extra));
        eq($res->status, 400);
        ok(str_starts_with($res->header('content-type'), 'text/html'), 'HTML error page');
        contains($res->text, 'is longer than');
    }
    eq($t->get(T::authorizeUrl($c, implode(' ', array_fill(0, 21, 'identify')), $challenge))->location()['error'], 'invalid_scope');
});

test('size limits: reject oversized client metadata', function () {
    $t = new T();
    $challenge = T::pkce()['challenge'];
    foreach ([['client_name' => str_repeat('n', 1001)], ['redirect_uris' => array_map(fn($i) => "https://app.example/cb$i", range(0, 20))],
        ['logo_uri' => 'https://app.example/' . str_repeat('l', 2048) . '.png']] as $extra)
        eq($t->get(T::authorizeUrl($t->registerClient('app.example', $extra), 'identify', $challenge))->status, 400);
    // A long but allowed name is shortened for display.
    contains($t->get(T::authorizeUrl($t->registerClient('app.example', ['client_name' => str_repeat('n', 1000)]), 'identify', $challenge))->text,
        '<bdi>' . str_repeat('n', 99) . '…</bdi>');
});

test('size limits: reject oversized token requests, forms, headers, paths and host-meta values', function () {
    $t = new T();
    $c = $t->registerClient('app.example');
    $res = $t->post('/oauth/token', ['grant_type' => 'refresh_token', 'client_id' => $c['clientId'], 'refresh_token' => str_repeat('t', 257)]);
    eq($res->status, 400);
    contains($res->json()['message'], 'refresh_token is longer than 256');
    eq($t->post('/oauth/token', ['grant_type' => 'x', 'client_id' => $c['clientId'], 'filler' => str_repeat('f', 70000)])->status, 413);
    eq($t->req('POST', '/oauth/token', ['content-type' => 'application/json'], '{}')->status, 400);
    $tok = $t->connect($c, 'write:/appdata/app.example/')['access_token'];
    eq($t->put('/appdata/app.example/a.json', $tok, '{}', ['if-match' => '"' . str_repeat('e', 1100) . '"'])->status, 400);
    eq($t->put('/appdata/app.example/' . str_repeat('p', 600) . '.json', $tok, '{}')->status, 400);
    eq($t->req('PUT', '/appdata/app.example/a.json', ['authorization' => 'Bearer ' . str_repeat('t', 2000), 'content-type' => 'application/json'], '{}')->status, 401);
    eq($t->hostMeta($tok, ['action' => 'set-property', 'property' => 'https://' . str_repeat('p', 600), 'value' => 'x'])->status, 400);
    eq($t->req('POST', '/pups/host-meta', ['authorization' => "Bearer $tok"], str_repeat(' ', 17000))->status, 413);
});

test('size limits: reject oversized passwords on owner pages with an error page', function () {
    $t = new T();
    $res = $t->post('/pups/apps', ['password' => str_repeat('p', 1025)]);
    eq($res->status, 400);
    contains($res->text, 'password is longer than 1024 characters');
    ok(str_starts_with($res->header('content-type'), 'text/html'), 'HTML error page');
});

test('log: values from requests cannot inject lines or terminal escapes', function () {
    $t = new T();
    \Pups\Log::$lines = [];
    $t->docs['https://x.example/client.json'] = ['status' => 404, 'body' => "nope\n2026 fake.event\x1b[31m" . ch(0x202e)];
    $t->get('/oauth/authorize?client_id=' . rawurlencode('https://x.example/client.json'));
    $log = implode("\n", \Pups\Log::$lines);
    eq(substr_count($log, "\n"), count(\Pups\Log::$lines) - 1, 'one line per entry');
    notContains($log, "\x1b");
    contains($log, 'body="nope\\n2026 fake.event\\u001b[31m\\u202e"');
});

test('ssrf: classifies addresses', function () {
    foreach (['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'nonsense'] as $a)
        eq([$a, isPublicAddress($a)], [$a, false]);
    foreach (['1.1.1.1', '93.184.215.14', '2606:4700::1111', '::ffff:1.1.1.1'] as $a)
        eq([$a, isPublicAddress($a)], [$a, true]);
});

test('ssrf: the real fetch refuses private addresses', function () {
    $c = (new T())->config;
    throws(fn() => (\Pups\httpsFetchDoc($c))('https://localhost/client.json'), 'non-public address');
});

test('config: validates the origin, the base path and the well-known paths', function () {
    throws(fn() => (new T(['origin' => 'http://alice.example'])), 'must use https');
    throws(fn() => (new T(['origin' => 'https://alice.example/'])), "'origin' must be an origin");
    throws(fn() => (new T(['origin' => 'https://Alice.example'])), "'origin' must be an origin");
    throws(fn() => (new T(['base_path' => '/pups/'])), "'base_path'");
    throws(fn() => (new T(['base_path' => '/../x'])), "'base_path'");
    foreach ([['path' => '/.well-known/host-meta.json'], ['path' => '/.well-known/acme-challenge/x'], ['path' => '/.well-known/pki-validation'],
        ['path' => '/appdata/x.json'], ['path' => '/oauth/x'], ['path' => '/pups/'], ['path' => '/pups/apps'], ['path' => '/pups/imagesx/'], ['path' => '/pups/pagesx/'], ['path' => '/personal-storage.json'], ['path' => '/.hidden/x.json'],
        ['path' => '/a/../b'], ['path' => '/feed/', 'url' => 'https://elsewhere.example/feed/'], ['path' => '/feed/', 'url' => ORIGIN . '/feed'],
        ['path' => '/x.json', 'properties' => ['https://bigwide.net/ns/pups#client']],
        ['path' => '/pups/pages/', 'link_properties' => ['https://bigwide.net/ns/pups#client']]] as $e)
        throws(fn() => parseWellKnown([$e], ORIGIN), $e['path'] === '/.well-known/acme-challenge/x' ? 'single files' : '');
    eq(parseWellKnown([['path' => '/feed/', 'url' => ORIGIN . '/feed/', 'rels' => ['r']]], ORIGIN)[0]['rels'], ['r']);
    eq(parseWellKnown([['path' => '/pups/images/']], ORIGIN)[0]['path'], '/pups/images/');
    eq(parseWellKnown([['path' => '/pups/pages/', 'link_properties' => ['https://bigwide.net/ns/webpup-hidden']]], ORIGIN)[0]['linkProperties'],
        ['https://bigwide.net/ns/webpup-hidden']);
    $images = parseWellKnown(null, ORIGIN)[5];
    eq([$images['path'], $images['urlProperties'], $images['singleRels']], ['/pups/images/', ['https://bigwide.net/ns/avatar', 'https://bigwide.net/ns/banner'], []]);
    $pages = parseWellKnown(null, ORIGIN)[6];
    eq([$pages['path'], $pages['rels'], $pages['linkProperties'], $pages['urlProperties']],
        ['/pups/pages/', ['https://bigwide.net/ns/webpup-pages'], ['https://bigwide.net/ns/webpup-hidden', 'https://bigwide.net/ns/webpup-homepage'], ['https://bigwide.net/ns/webpup-footer']]);
});

test('source files contain no literal control or invisible characters', function () {
    $root = dirname(__DIR__);
    $found = [];
    $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS));
    foreach ($it as $f) {
        $rel = substr($f->getPathname(), strlen($root) + 1);
        // pups/webpup/ is a build of webpup (scripts/sync-webpup.sh): its bundled libraries need such characters.
        if (preg_match('#^(pups/data|pups/webpup|certs|\.git)/#', $rel) || !preg_match('/\.(php|js|css|md|sh|json)$|^\.htaccess$/', $f->getFilename()))
            continue;
        foreach (explode("\n", file_get_contents($f->getPathname())) as $i => $line)
            if (preg_match('/' . \Pups\UNSAFE . '/u', str_replace(["\t", "\r"], '', $line), $m) || !preg_match('//u', $line))
                $found[] = "$rel:" . ($i + 1);
    }
    eq($found, []);
});
