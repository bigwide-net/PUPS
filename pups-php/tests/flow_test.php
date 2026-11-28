<?php
// End-to-end tests of the protocol, ported from the former Node test server.

namespace Pups\Test;

test('discovery: links host-meta.json to the configuration document, with CORS', function () {
    $t = new T();
    $hm = $t->get('/.well-known/host-meta.json');
    eq($hm->status, 200);
    eq($hm->header('access-control-allow-origin'), '*');
    eq($hm->json()['links'][0], ['rel' => 'https://bigwide.net/ns/personal-storage', 'type' => 'application/json', 'href' => ORIGIN . '/personal-storage.json']);
    $cfg = $t->get('/personal-storage.json');
    ok(str_starts_with($cfg->header('content-type'), 'application/json'), 'content type');
    eq($cfg->header('access-control-allow-origin'), '*');
    $doc = $cfg->json();
    foreach (['issuer' => ORIGIN, 'authorization_endpoint' => ORIGIN . '/oauth/authorize', 'token_endpoint' => ORIGIN . '/oauth/token',
        'storage_base' => ORIGIN . '/', 'public_base' => ORIGIN . '/', 'spec_version' => '0.1', 'max_upload_bytes' => 26214400,
        'host_meta_endpoint' => ORIGIN . '/pups/host-meta'] as $k => $v)
        eq($doc[$k], $v, $k);
    eq($doc['implementation'], ['name' => 'pups-php', 'version' => \Pups\VERSION]);
    ok(!isset($doc['post_endpoint']), 'no post_endpoint');
    $feed = ['https://bigwide.net/ns/feed'];
    eq($doc['well_known_paths'], [
        ['path' => '/.well-known/following.opml', 'url' => ORIGIN . '/.well-known/following.opml'],
        ['path' => '/.well-known/about.md', 'url' => ORIGIN . '/.well-known/about.md',
            'properties' => array_map(fn($p) => "https://bigwide.net/ns/$p", ['name', 'title', 'summary', 'theme-color', 'language'])],
        ['path' => '/.well-known/contact.vcf', 'url' => ORIGIN . '/.well-known/contact.vcf'],
        ['path' => '/feed.json', 'url' => ORIGIN . '/feed.json', 'rels' => $feed],
        ['path' => '/feed/', 'url' => ORIGIN . '/feed/', 'rels' => $feed],
        ['path' => '/pups/images/', 'url' => ORIGIN . '/pups/images/', 'properties' => ['https://bigwide.net/ns/avatar', 'https://bigwide.net/ns/banner']],
        ['path' => '/pups/pages/', 'url' => ORIGIN . '/pups/pages/', 'rels' => ['https://bigwide.net/ns/webpup-pages'],
            'properties' => ['https://bigwide.net/ns/webpup-footer'], 'link_properties' => ['https://bigwide.net/ns/webpup-hidden', 'https://bigwide.net/ns/webpup-homepage']],
    ]);
    eq($t->get('/.well-known/oauth-authorization-server')->json()['code_challenge_methods_supported'], ['S256']);
    eq($t->req('HEAD', '/personal-storage.json')->status, 200, 'HEAD');
});

test('discovery: answers preflights', function () {
    $t = new T();
    $res = $t->req('OPTIONS', '/appdata/x/a.json');
    eq($res->status, 204);
    contains($res->header('access-control-allow-methods'), 'PUT');
    contains($res->header('access-control-allow-headers'), 'If-Match');
});

test('authorization: runs the full flow with PKCE, iss and me', function () {
    $t = new T();
    $c = $t->registerClient('app.example');
    $p = T::pkce();
    $page = $t->get(T::authorizeUrl($c, 'identify write:/appdata/app.example/', $p['challenge']));
    eq($page->status, 200);
    eq($page->header('set-cookie'), null, 'no cookie');
    eq($page->header('x-frame-options'), 'DENY');
    eq($page->header('access-control-allow-origin'), null, 'no CORS on the consent page');
    contains($page->text, 'New app');
    contains($page->text, '<legend>app.example may then</legend>');
    notContains($page->text, 'outside');
    $res = $t->post('/oauth/authorize', ['request' => hidden($page->text, 'request'), 'decision' => 'approve', 'password' => PASSWORD,
        'scope' => ['identify', 'write:/appdata/app.example/']]);
    eq($res->header('set-cookie'), null, 'no cookie');
    eq($res->status, 303);
    $loc = $res->location();
    eq($loc['_url'], $c['redirectUri']);
    eq($loc['state'], 'xyz');
    eq($loc['iss'], ORIGIN);
    $tok = $t->exchange($c, $loc['code'], $p['verifier']);
    eq($tok->status, 200);
    $body = $tok->json();
    eq([$body['token_type'], $body['expires_in'], $body['scope'], $body['me']], ['Bearer', 3600, 'identify write:/appdata/app.example/', ORIGIN . '/']);
    ok($body['refresh_token'] ?? null, 'refresh token');
    // The second time, the app isn't new any more.
    notContains($t->get(T::authorizeUrl($c, 'identify', $p['challenge']))->text, 'New app');
});

test('authorization: rejects a wrong password and does not issue a code', function () {
    $t = new T();
    [$res] = $t->approve($t->registerClient('app.example'), 'identify', null, 'wrong');
    eq($res->status, 401);
    contains($res->text, 'The confirmation failed');
    eq($res->header('location'), null);
});

test('authorization: treats denial and dropping every scope as access_denied', function () {
    $t = new T();
    $c = $t->registerClient('app.example');
    [$res] = $t->approve($c, 'write:/appdata/app.example/', []);
    eq($res->location()['error'], 'access_denied');
    $page = $t->get(T::authorizeUrl($c, 'identify', T::pkce()['challenge']));
    $res = $t->post('/oauth/authorize', ['request' => hidden($page->text, 'request'), 'decision' => 'deny']);
    eq($res->location()['error'], 'access_denied');
});

test('authorization: shows an error page instead of redirecting for bad clients and redirect URIs', function () {
    $t = new T();
    $challenge = T::pkce()['challenge'];
    $res = $t->get(T::authorizeUrl($t->registerClient('app.example', ['client_uri' => 'https://example/']), 'identify', $challenge));
    eq($res->status, 400);
    contains($res->text, 'client_uri must be an HTTPS URL on the client host');
    $d = $t->registerClient('other.example');
    $res = $t->get(T::authorizeUrl(['redirectUri' => 'https://evil.example/cb'] + $d, 'identify', $challenge));
    eq($res->status, 400);
    eq($res->header('location'), null);
    eq($t->get(T::authorizeUrl(['clientId' => 'https://127.0.0.1/client.json'] + $d, 'identify', $challenge))->status, 400);
    foreach (['https://Other.example/oauth/client.json', 'https://other.example/a/../client.json', 'https://other.example:8443/client.json',
        'https://other.example/client.json?x=1', 'http://other.example/client.json', 'https://other.example/', 'https://user@other.example/c.json',
        'https://alice.pups.test/client.json'] as $id)
        eq([$id, $t->get(T::authorizeUrl(['clientId' => $id] + $d, 'identify', $challenge))->status], [$id, 400]);
});

test('authorization: accepts loopback redirects with any port, not localhost', function () {
    $t = new T();
    $c = $t->registerClient('app.example', ['redirect_uris' => ['http://127.0.0.1/callback']]);
    $challenge = T::pkce()['challenge'];
    $res = $t->get(T::authorizeUrl(['redirectUri' => 'http://127.0.0.1:5173/callback'] + $c, 'identify', $challenge));
    eq($res->status, 200);
    contains($res->text, 'runs on this computer');
    eq($t->get(T::authorizeUrl(['redirectUri' => 'http://localhost:5173/callback'] + $c, 'identify', $challenge))->status, 400);
    eq($t->get(T::authorizeUrl(['redirectUri' => 'http://127.0.0.1:5173/other'] + $c, 'identify', $challenge))->status, 400);
});

test('authorization: rejects plain PKCE and invalid scopes with a redirect', function () {
    $t = new T();
    $c = $t->registerClient('app.example');
    $challenge = T::pkce()['challenge'];
    eq($t->get(T::authorizeUrl($c, 'identify', $challenge, ['code_challenge_method' => 'plain']))->location()['error'], 'invalid_request');
    foreach (['write:/', 'write:/appdata/other.example/', 'write:/appdata/', 'write:/elsewhere/', 'write:/.well-known/host-meta.json'] as $scope)
        eq([$scope, $t->get(T::authorizeUrl($c, $scope, $challenge))->location()['error'] ?? null], [$scope, 'invalid_scope']);
});

test('authorization: rejects a wrong verifier, and a reused code revokes its tokens', function () {
    $t = new T();
    $c = $t->registerClient('app.example');
    [$res] = $t->approve($c, 'write:/appdata/app.example/');
    eq($t->exchange($c, $res->location()['code'], T::pkce()['verifier'])->json()['error'], 'invalid_grant');
    [$res, $verifier] = $t->approve($c, 'write:/appdata/app.example/');
    $code = $res->location()['code'];
    $tok = $t->exchange($c, $code, $verifier);
    eq($tok->status, 200);
    eq($t->put('/appdata/app.example/a.json', $tok->json()['access_token'], '{}')->status, 201);
    eq($t->exchange($c, $code, $verifier)->status, 400);
    eq($t->put('/appdata/app.example/a.json', $tok->json()['access_token'], '{}')->status, 401);
});

test('authorization: expired codes and a consent form answered twice are rejected', function () {
    $t = new T();
    $c = $t->registerClient('app.example');
    [$res, $verifier] = $t->approve($c, 'identify');
    $t->offset = 61_000;
    contains($t->exchange($c, $res->location()['code'], $verifier)->json()['error_description'], 'expired');
    $t->offset = 0;
    $page = $t->get(T::authorizeUrl($c, 'identify', T::pkce()['challenge']));
    $form = ['request' => hidden($page->text, 'request'), 'decision' => 'approve', 'password' => PASSWORD, 'scope' => 'identify'];
    eq($t->post('/oauth/authorize', $form)->status, 303);
    contains($t->post('/oauth/authorize', $form)->text, 'already approved');
});

test('authorization: enforces the granted scope, not the requested one', function () {
    $t = new T();
    $c = $t->registerClient('app.example');
    $tok = $t->connect($c, 'write:/appdata/app.example/ write:/.well-known/about.md', ['write:/appdata/app.example/']);
    eq($tok['scope'], 'write:/appdata/app.example/');
    $res = $t->put('/.well-known/about.md', $tok['access_token'], '# Alice', ['content-type' => 'text/markdown']);
    eq($res->status, 403);
    contains($res->header('www-authenticate'), 'insufficient_scope');
});

test('authorization: gives identify-only grants no refresh token and no write access', function () {
    $t = new T();
    $c = $t->registerClient('app.example');
    $tok = $t->connect($c, 'identify');
    ok(!isset($tok['refresh_token']), 'no refresh token');
    eq($t->put('/appdata/app.example/a.json', $tok['access_token'], '{}')->status, 403);
});

test('authorization: needs an owner, and explains how to set up the server', function () {
    $t = new T(['base_path' => '/pups'], false);
    $c = $t->registerClient('app.example');
    $res = $t->get(str_replace('/oauth/', '/pups/oauth/', T::authorizeUrl($c, 'identify', T::pkce()['challenge'])));
    eq($res->status, 503);
    contains($res->text, '<h1>Set up your server first</h1>');
    contains($res->text, 'log in with <strong>alice.pups.test</strong>');
    contains($res->text, '<a href="/pups/pups/setup">Set it up now</a>. You need the setup secret from <code>config.php</code>');
    contains($res->text, 'go back to the app and log in again');
});

test('refresh: rotates, and reuse of a replaced token revokes the grant', function () {
    $t = new T();
    $c = $t->registerClient('app.example');
    $tok = $t->connect($c, 'write:/appdata/app.example/');
    $r1 = $t->refresh($c, $tok['refresh_token']);
    eq($r1->status, 200);
    eq($r1->json()['me'], ORIGIN . '/');
    ok($r1->json()['refresh_token'] !== $tok['refresh_token'], 'new refresh token');
    // The new access token is used, so the grace period no longer applies.
    eq($t->put('/appdata/app.example/a.json', $r1->json()['access_token'], '{}')->status, 201);
    eq($t->refresh($c, $tok['refresh_token'])->status, 400);
    eq($t->refresh($c, $r1->json()['refresh_token'])->status, 400);
    eq($t->put('/appdata/app.example/a.json', $r1->json()['access_token'], '{}')->status, 401);
});

test('refresh: allows a retry within the grace period while the successors are unused', function () {
    $t = new T();
    $c = $t->registerClient('app.example');
    $tok = $t->connect($c, 'write:/appdata/app.example/');
    $lost = $t->refresh($c, $tok['refresh_token'])->json();
    $retry = $t->refresh($c, $tok['refresh_token']);
    eq($retry->status, 200);
    // The lost tokens are revoked, without revoking the grant.
    eq($t->put('/appdata/app.example/a.json', $lost['access_token'], '{}')->status, 401);
    eq($t->refresh($c, $lost['refresh_token'])->status, 400);
    eq($t->put('/appdata/app.example/a.json', $retry->json()['access_token'], '{}')->status, 201);
    eq($t->refresh($c, $retry->json()['refresh_token'])->status, 200);
});

test('refresh: revokes the grant on reuse after the grace period, and the scope cannot grow', function () {
    $t = new T();
    $c = $t->registerClient('app.example');
    $tok = $t->connect($c, 'write:/appdata/app.example/');
    $r1 = $t->refresh($c, $tok['refresh_token'])->json();
    $t->offset = 61_000;
    eq($t->refresh($c, $tok['refresh_token'])->status, 400);
    eq($t->refresh($c, $r1['refresh_token'])->status, 400);
    $t->offset = 0;
    $tok = $t->connect($c, 'write:/appdata/app.example/');
    $res = $t->post('/oauth/token', ['grant_type' => 'refresh_token', 'refresh_token' => $tok['refresh_token'], 'client_id' => $c['clientId'], 'scope' => 'write:/.well-known/about.md']);
    eq($res->json()['error'], 'invalid_scope');
});

test('refresh: revokes the grant through the revocation endpoint', function () {
    $t = new T();
    $c = $t->registerClient('app.example');
    $tok = $t->connect($c, 'write:/appdata/app.example/');
    eq($t->post('/oauth/revoke', ['token' => $tok['refresh_token'], 'client_id' => $c['clientId']])->status, 200);
    eq($t->put('/appdata/app.example/a.json', $tok['access_token'], '{}')->status, 401);
    eq($t->post('/oauth/revoke', ['token' => 'unknown', 'client_id' => $c['clientId']])->status, 200);
});

test('uploads: create, replace with ETags, serve and delete', function () {
    $t = new T();
    $tok = $t->connect($t->registerClient('app.example'), 'write:/appdata/app.example/')['access_token'];
    $res = $t->put('/appdata/app.example/feed.json', $tok, '{"v":1}', ['if-none-match' => '*', 'content-type' => 'application/feed+json']);
    eq($res->status, 201);
    eq($res->header('location'), ORIGIN . '/appdata/app.example/feed.json');
    $etag = $res->header('etag');
    eq(file_get_contents("$t->dataDir/files/appdata/app.example/feed.json"), '{"v":1}');
    eq($t->put('/appdata/app.example/feed.json', $tok, '{}', ['if-none-match' => '*'])->status, 412);
    $res = $t->put('/appdata/app.example/feed.json', $tok, '{"v":2}', ['if-match' => $etag]);
    eq($res->status, 200);
    ok($res->header('etag') !== $etag, 'new ETag');
    $etag2 = $res->header('etag');
    eq($t->put('/appdata/app.example/feed.json', $tok, '{"v":3}', ['if-match' => $etag])->status, 412);

    $res = $t->get('/appdata/app.example/feed.json');
    eq($res->status, 200);
    eq($res->text, '{"v":2}');
    foreach (['content-type' => 'application/json; charset=utf-8', 'x-content-type-options' => 'nosniff', 'content-security-policy' => 'sandbox',
        'access-control-allow-origin' => '*', 'etag' => $etag2] as $k => $v)
        eq($res->header($k), $v, $k);
    eq($t->get('/appdata/app.example/feed.json', ['if-none-match' => $etag2])->status, 304);
    eq($t->get('/appdata/app.example/feed.json', ['service-worker' => 'script'])->status, 403);
    $res = $t->get('/appdata/app.example/feed.json', ['range' => 'bytes=1-3']);
    eq([$res->status, $res->text, $res->header('content-range')], [206, '"v"', 'bytes 1-3/7']);
    eq($t->get('/appdata/app.example/feed.json', ['range' => 'bytes=-2'])->text, '2}');
    eq($t->get('/appdata/app.example/feed.json', ['range' => 'bytes=9-'])->status, 416);
    eq($t->req('HEAD', '/appdata/app.example/feed.json')->header('content-length'), '7');

    eq($t->req('DELETE', '/appdata/app.example/feed.json', ['authorization' => "Bearer $tok", 'if-match' => $etag])->status, 412);
    eq($t->req('DELETE', '/appdata/app.example/feed.json', ['authorization' => "Bearer $tok"])->status, 204);
    eq($t->get('/appdata/app.example/feed.json')->status, 404);
    eq($t->req('DELETE', '/appdata/app.example/feed.json', ['authorization' => "Bearer $tok"])->status, 404);
});

test('uploads: fresh reads with a token of any scope bypass caches and see every write', function () {
    $t = new T();
    $c = $t->registerClient('app.example');
    $tok = $t->connect($c, 'write:/appdata/app.example/');
    $identify = $t->connect($t->registerClient('reader.example'), 'identify')['access_token'];
    $etag = $t->put('/appdata/app.example/feed.json', $tok['access_token'], '{"v":1}')->header('etag');

    $public = $t->get('/appdata/app.example/feed.json');
    eq([$public->header('cache-control'), $public->header('vary')], ['no-cache', 'Authorization']);
    foreach ([$tok['access_token'], $identify] as $token)
        foreach (['GET', 'HEAD'] as $method) {
            $res = $t->req($method, '/appdata/app.example/feed.json', ['authorization' => "Bearer $token"]);
            eq([$method, $res->status, $res->header('etag'), $res->header('cache-control')], [$method, 200, $etag, 'private, no-store']);
            eq($res->text, $method === 'GET' ? '{"v":1}' : '');
            foreach (['content-type', 'x-content-type-options', 'content-security-policy', 'access-control-allow-origin', 'last-modified', 'vary', 'content-length'] as $k)
                eq($res->header($k), $public->header($k), $k);
        }
    $fresh = ['authorization' => "Bearer $identify"];
    $res = $t->get('/appdata/app.example/feed.json', $fresh + ['if-none-match' => $etag]);
    eq([$res->status, $res->header('cache-control')], [304, 'private, no-store']);
    eq($t->get('/appdata/app.example/feed.json', $fresh + ['range' => 'bytes=1-3'])->text, '"v"');

    // Read-your-writes, and the ETag is the one If-Match compares with.
    $etag2 = $t->put('/appdata/app.example/feed.json', $tok['access_token'], '{"v":2}', ['if-match' => $etag])->header('etag');
    $res = $t->get('/appdata/app.example/feed.json', $fresh);
    eq([$res->text, $res->header('etag')], ['{"v":2}', $etag2]);
    eq($t->put('/appdata/app.example/feed.json', $tok['access_token'], '{"v":3}', ['if-match' => $res->header('etag')])->status, 200);
    eq($t->get('/appdata/app.example/feed.json', $fresh)->text, '{"v":3}');
    eq($t->get('/appdata/app.example/missing.json', $fresh)->status, 404);
    eq($t->get('/appdata/app.example/feed.json', ['authorization' => 'Basic YTpi'])->header('cache-control'), 'no-cache', 'other schemes');

    // A token in use saves the state at most once a minute, not on every read.
    $state = fn() => file_get_contents("$t->dataDir/state.json");
    $before = $state();
    $t->get('/appdata/app.example/feed.json', $fresh);
    eq($state(), $before, 'state unchanged');
    $t->offset = 61_000;
    $t->get('/appdata/app.example/feed.json', $fresh);
    ok($state() !== $before, 'lastUsedAt saved after a minute');

    // Invalid, expired and revoked tokens never fall back to a public read.
    foreach (['Bearer invalid', 'Bearer', 'Bearer a b'] as $auth) {
        $res = $t->get('/appdata/app.example/feed.json', ['authorization' => $auth]);
        eq([$auth, $res->status, $res->json()['error']], [$auth, 401, 'invalid_token']);
        eq($res->header('www-authenticate'), 'Bearer error="invalid_token"');
        eq($res->header('access-control-allow-origin'), '*');
    }
    eq($t->post('/oauth/revoke', ['token' => $tok['refresh_token'], 'client_id' => $c['clientId']])->status, 200);
    eq($t->req('HEAD', '/appdata/app.example/feed.json', ['authorization' => "Bearer {$tok['access_token']}"])->status, 401, 'revoked');
    $t->offset = 3_601_000;
    eq($t->get('/appdata/app.example/feed.json', $fresh)->status, 401, 'expired');
    eq($t->get('/appdata/app.example/feed.json')->status, 200);
});

test('refresh: a fresh read with the new access token counts as use', function () {
    $t = new T();
    $c = $t->registerClient('app.example');
    $tok = $t->connect($c, 'write:/appdata/app.example/');
    $t->put('/appdata/app.example/a.json', $tok['access_token'], '{}');
    $r1 = $t->refresh($c, $tok['refresh_token'])->json();
    eq($t->get('/appdata/app.example/a.json', ['authorization' => "Bearer {$r1['access_token']}"])->status, 200);
    eq($t->refresh($c, $tok['refresh_token'])->status, 400);
    eq($t->get('/appdata/app.example/a.json', ['authorization' => "Bearer {$r1['access_token']}"])->status, 401);
});

test('uploads: reject missing tokens, bad paths and bad types, storing nothing', function () {
    $t = new T(['max_upload_bytes' => 100]);
    $tok = $t->connect($t->registerClient('app.example'), 'write:/appdata/app.example/')['access_token'];
    $res = $t->req('PUT', '/appdata/app.example/a.json', ['content-type' => 'application/json'], '{}');
    eq($res->status, 401);
    eq($res->header('access-control-allow-origin'), '*');
    eq($res->json()['error'], 'invalid_token');
    foreach (['/appdata/app.example/../x.json', '/appdata/app.example/%2e%2e/x.json', '/appdata/app.example/a%5Cb.json',
        '/appdata/app.example/.htaccess', '/appdata/app.example/feed.json.', '/appdata/app.example//a.json', '/appdata/app.example/a%zz.json',
        '/appdata/app.example/a%FF.json', '/appdata/app.example/a%00.json', '/appdata/app.example/a:b.json'] as $p)
        eq([$p, $t->put($p, $tok, '{}')->status], [$p, 400]);
    foreach (['/appdata/app.example/a.php', '/appdata/app.example/a.phtml', '/appdata/app.example/feed.php.json',
        '/appdata/app.example/a.html', '/appdata/app.example/a.js', '/appdata/app.example/a.css', '/appdata/app.example/x.ini'] as $p)
        eq([$p, $t->put($p, $tok, '{}')->status], [$p, 415]);
    eq($t->put('/appdata/app.example/a.json', $tok, '{}', ['content-type' => 'text/html'])->status, 415);
    eq($t->put('/appdata/app.example/a.txt', $tok, "\xff\xfe", ['content-type' => 'text/plain'])->status, 415);
    eq($t->put('/appdata/app.example/a.json', $tok, str_repeat('x', 101))->status, 413);
    eq($t->put('/appdata/app.example/a.json', $tok, str_repeat('x', 101), ['content-length' => '50'])->status, 413, 'body longer than Content-Length says');
    eq($t->put('/appdata/other.example/a.json', $tok, '{}')->status, 403);
    ok(!file_exists("$t->dataDir/files/appdata"), 'nothing stored');
    eq(glob("$t->dataDir/files/.pups-tmp/*"), [], 'no temp files left');
});

test('uploads: a folder or file in the way is a conflict', function () {
    $t = new T();
    $tok = $t->connect($t->registerClient('app.example'), 'write:/appdata/app.example/')['access_token'];
    eq($t->put('/appdata/app.example/a/b.json', $tok, '{}')->status, 201);
    eq($t->put('/appdata/app.example/a', $tok, '{}')->status, 415);
    eq($t->put('/appdata/app.example/b.json', $tok, '{}')->status, 201);
    eq($t->put('/appdata/app.example/b.json/c.json', $tok, '{}')->status, 409);
});

test('uploads: write and serve declared well-known files at the domain root', function () {
    $t = new T();
    $tok = $t->connect($t->registerClient('app.example'), 'write:/.well-known/about.md')['access_token'];
    eq($t->put('/.well-known/about.md', $tok, '# Alice', ['content-type' => 'text/markdown'])->status, 201);
    $got = $t->get('/.well-known/about.md');
    eq($got->text, '# Alice');
    eq($got->header('content-type'), 'text/markdown; charset=utf-8');
    eq($got->header('content-security-policy'), 'sandbox');
});

test('uploads: accept writes through the POST fallback when configured', function () {
    $t = new T(['post_fallback' => true]);
    eq($t->get('/personal-storage.json')->json()['post_endpoint'], ORIGIN . '/pups/post');
    $tok = $t->connect($t->registerClient('app.example'), 'write:/appdata/app.example/')['access_token'];
    $h = ['authorization' => "Bearer $tok", 'content-type' => 'application/json'];
    eq($t->req('POST', '/pups/post?method=PUT&path=%2Fappdata%2Fapp.example%2Fa%20b.json', $h + ['if-none-match' => '*'], '{}')->status, 201);
    ok(is_file("$t->dataDir/files/appdata/app.example/a b.json"), 'decoded exactly once');
    eq($t->req('POST', '/pups/post?method=PUT&path=%2Fappdata%2Fapp.example%2F..%2Fa.json', $h, '{}')->status, 400);
    eq($t->req('POST', '/pups/post?method=DELETE&path=%2Fappdata%2Fapp.example%2Fa%20b.json', ['authorization' => "Bearer $tok"])->status, 204);
    eq((new T())->req('POST', '/pups/post?method=PUT&path=%2Fa.json', $h, '{}')->status, 404, 'not declared');
});

test('uploads: quota and write rate limit', function () {
    $t = new T(['max_storage_bytes' => 10, 'writes_per_minute' => 3]);
    $tok = $t->connect($t->registerClient('app.example'), 'write:/appdata/app.example/')['access_token'];
    eq($t->put('/appdata/app.example/a.json', $tok, '12345678')->status, 201);
    eq($t->put('/appdata/app.example/b.json', $tok, '12345')->status, 507);
    eq($t->put('/appdata/app.example/a.json', $tok, '1234567890')->status, 200, 'replacing counts the difference');
    $res = $t->put('/appdata/app.example/c.json', $tok, '');
    eq($res->status, 429);
    eq($res->header('retry-after'), '60');
    $t->offset = 61_000;
    eq($t->put('/appdata/app.example/a.json', $tok, '1')->status, 200);
});

test('host-meta.json: adds and removes app links, keeps owner entries, and cleans up on revocation', function () {
    $t = new T();
    mkdir("$t->dataDir/files/.well-known", 0755, true);
    file_put_contents("$t->dataDir/files/.well-known/host-meta.json", json_encode(['subject' => 'acct:alice', 'properties' => new \stdClass(),
        'links' => [['rel' => 'https://bigwide.net/ns/personal-storage', 'href' => ORIGIN . '/personal-storage.json'], ['rel' => 'me', 'href' => 'https://x']]]));
    $c = $t->registerClient('app.example');
    $tok = $t->connect($c, 'write:/appdata/app.example/')['access_token'];
    $href = ORIGIN . '/appdata/app.example/feed.json';
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => 'https://app.example/rel/feed', 'href' => $href])->status, 201);
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => 'me', 'href' => $href])->status, 403);
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => 'https://other.example/rel', 'href' => $href])->status, 403);
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => 'https://app.example/rel/feed', 'href' => 'https://evil.example/x.json'])->status, 403);
    $raw = $t->get('/.well-known/host-meta.json')->text;
    contains($raw, '"properties": {}', 'an empty object stays an object');
    $doc = json_decode($raw, true);
    eq($doc['subject'], 'acct:alice');
    eq(count($doc['links']), 3);
    eq($doc['links'][2]['properties']['https://bigwide.net/ns/pups#client'], $c['clientId']);
    eq($t->hostMeta($tok, ['action' => 'remove', 'rel' => 'https://app.example/rel/feed', 'href' => $href])->status, 204);
    eq(count($t->get('/.well-known/host-meta.json')->json()['links']), 2);
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => 'https://app.example/rel/feed', 'href' => $href])->status, 201);

    // Removing the app on the apps page removes its /appdata/ links.
    $page = $t->post('/pups/apps', ['password' => PASSWORD]);
    ok(preg_match('/name="revoke" value="([^"]+)"/', $page->text, $m), 'remove button');
    $res = $t->post('/pups/apps', ['password' => PASSWORD, 'revoke' => $m[1]]);
    contains($res->text, 'app.example can no longer write to your domain');
    eq(count($t->get('/.well-known/host-meta.json')->json()['links']), 2);
    eq($t->put('/appdata/app.example/a.json', $tok, '{}')->status, 401);
});

test('host-meta.json: sets only declared properties of granted well-known paths', function () {
    $t = new T();
    $c = $t->registerClient('app.example');
    $tok = $t->connect($c, 'write:/appdata/app.example/')['access_token'];
    eq($t->hostMeta($tok, ['action' => 'set-property', 'property' => 'https://bigwide.net/ns/name', 'value' => 'Alice'])->status, 403);
    $tok = $t->connect($c, 'write:/.well-known/about.md')['access_token'];
    eq($t->hostMeta($tok, ['action' => 'set-property', 'property' => 'https://bigwide.net/ns/name', 'value' => 'Alice'])->status, 201);
    eq($t->hostMeta($tok, ['action' => 'set-property', 'property' => 'https://bigwide.net/ns/name', 'value' => "a\x01"])->status, 400);
    eq($t->hostMeta($tok, ['action' => 'set-property', 'property' => 'https://bigwide.net/ns/pups#x', 'value' => 'a'])->status, 403);
    eq($t->get('/.well-known/host-meta.json')->json()['properties'], ['https://bigwide.net/ns/name' => 'Alice']);
    eq($t->hostMeta($tok, ['action' => 'nope'])->status, 400);
    eq($t->req('POST', '/pups/host-meta', ['authorization' => "Bearer $tok"], '[1]')->status, 400);
});

test('host-meta.json: refuses to change an invalid file', function () {
    $t = new T();
    mkdir("$t->dataDir/files/.well-known", 0755, true);
    file_put_contents("$t->dataDir/files/.well-known/host-meta.json", '{ not json');
    $tok = $t->connect($t->registerClient('app.example'), 'write:/appdata/app.example/')['access_token'];
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => 'https://app.example/rel', 'href' => ORIGIN . '/appdata/app.example/a.json'])->status, 409);
    eq(file_get_contents("$t->dataDir/files/.well-known/host-meta.json"), '{ not json');
});

test('host-meta.json: registers feeds with the default well-known paths', function () {
    $t = new T();
    $c = $t->registerClient('app.example');
    $rel = 'https://bigwide.net/ns/feed';
    $page = $t->get(T::authorizeUrl($c, 'write:/feed.json write:/feed/ write:/pups/images/ write:/pups/pages/', T::pkce()['challenge']));
    contains($page->text, '<li>your feed (<code>/feed.json</code>)</li>');
    contains($page->text, '<li>the files of your feed, and your other feeds (<code>/feed/</code>)</li>');
    contains($page->text, '<li>your site&apos;s profile images (<code>/pups/images/</code>)</li>');
    contains($page->text, '<li>your site&apos;s pages (<code>/pups/pages/</code>)</li>');
    $tok = $t->connect($c, 'write:/feed/')['access_token'];
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => $rel, 'href' => ORIGIN . '/feed/photos.json', 'type' => 'application/feed+json'])->status, 201);
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => $rel, 'href' => ORIGIN . '/feed.json'])->status, 403);
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => 'https://bigwide.net/ns/other', 'href' => ORIGIN . '/feed/photos.json'])->status, 403);
    $tok = $t->connect($c, 'write:/feed.json')['access_token'];
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => $rel, 'href' => ORIGIN . '/feed.json', 'type' => 'application/feed+json'])->status, 201);
    $links = array_values(array_filter($t->get('/.well-known/host-meta.json')->json()['links'], fn($l) => $l['rel'] === $rel));
    eq(array_column($links, 'href'), [ORIGIN . '/feed/photos.json', ORIGIN . '/feed.json']);
});

test('host-meta.json: sets the profile properties of about.md', function () {
    $t = new T();
    $tok = $t->connect($t->registerClient('app.example'), 'write:/.well-known/about.md')['access_token'];
    foreach (['title' => 'Notes', 'summary' => 'About me', 'theme-color' => '#336699', 'language' => 'en'] as $p => $value)
        eq($t->hostMeta($tok, ['action' => 'set-property', 'property' => "https://bigwide.net/ns/$p", 'value' => $value])->status, 201, $p);
    eq($t->hostMeta($tok, ['action' => 'set-property', 'property' => 'https://bigwide.net/ns/avatar', 'value' => ORIGIN . '/pups/images/a.png'])->status, 403);
    eq(count($t->get('/.well-known/host-meta.json')->json()['properties']), 4);
});

test('host-meta.json: profile images in /pups/images/ and their URL properties', function () {
    $t = new T();
    $tok = $t->connect($t->registerClient('app.example'), 'write:/pups/images/')['access_token'];
    $res = $t->put('/pups/images/x.png', $tok, 'PNG', ['content-type' => 'image/png']);
    eq([$res->status, $res->header('location')], [201, ORIGIN . '/pups/images/x.png']);
    ok(is_file("$t->dataDir/files/pups/images/x.png"), 'stored');
    $got = $t->get('/pups/images/x.png');
    eq([$got->status, $got->text, $got->header('content-type'), $got->header('x-content-type-options'), $got->header('content-security-policy'),
        $got->header('access-control-allow-origin')], [200, 'PNG', 'image/png', 'nosniff', 'sandbox', '*']);
    $avatar = 'https://bigwide.net/ns/avatar';
    $banner = 'https://bigwide.net/ns/banner';
    eq($t->hostMeta($tok, ['action' => 'set-property', 'property' => $avatar, 'value' => ORIGIN . '/pups/images/x.png'])->status, 201);
    eq($t->hostMeta($tok, ['action' => 'set-property', 'property' => $banner, 'value' => ORIGIN . '/pups/images/sub/b.jpg'])->status, 201);
    foreach ([ORIGIN . '/feed/x.png', ORIGIN . '/pups/x.png', 'https://evil.example/pups/images/x.png'] as $value)
        eq($t->hostMeta($tok, ['action' => 'set-property', 'property' => $avatar, 'value' => $value])->status, 403, $value);
    eq($t->hostMeta($tok, ['action' => 'set-property', 'property' => 'https://bigwide.net/ns/name', 'value' => 'Alice'])->status, 403);
    eq($t->get('/.well-known/host-meta.json')->json()['properties'], [$avatar => ORIGIN . '/pups/images/x.png', $banner => ORIGIN . '/pups/images/sub/b.jpg']);
    // Nothing else under /pups/ is writable, and the server's own routes still work.
    foreach (['/pups/x.png', '/pups/imagesx/a.png', '/pups/assets/a.png'] as $p)
        eq($t->put($p, $tok, 'PNG', ['content-type' => 'image/png'])->status, 403, $p);
    eq($t->put('/pups/apps', $tok, 'PNG', ['content-type' => 'image/png'])->status, 405);
    eq($t->get('/pups/assets/owner.css')->status, 200);
    eq($t->get('/pups/apps')->status, 200);
});

test('host-meta.json: publishes pages with titles, hidden flags and a footer, and orders them', function () {
    $t = new T();
    $pages = 'https://bigwide.net/ns/webpup-pages';
    $hidden = 'https://bigwide.net/ns/webpup-hidden';
    $client = 'https://bigwide.net/ns/pups#client';
    $page = fn(string $n) => ORIGIN . "/pups/pages/$n.md";
    @mkdir("$t->dataDir/files/.well-known", 0777, true);
    file_put_contents("$t->dataDir/files/.well-known/host-meta.json", json_encode(['links' => [['rel' => $pages, 'href' => $page('owner')], ['rel' => 'me', 'href' => 'https://x']]]));
    $c = $t->registerClient('app.example');
    $tok = $t->connect($c, 'write:/pups/pages/')['access_token'];
    eq($t->put('/pups/pages/now.md', $tok, '# Now', ['content-type' => 'text/markdown'])->status, 201);
    eq($t->get('/pups/pages/now.md')->text, '# Now');
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => $pages, 'href' => $page('now'), 'type' => 'text/markdown'])->status, 201);
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => $pages, 'href' => $page('imprint'), 'titles' => ['default' => 'Imprint', 'de' => 'Impressum'],
        'properties' => [$hidden => 'true']])->status, 201);
    // Undeclared link properties, the ownership marker, bad titles
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => $pages, 'href' => $page('x'), 'properties' => ['https://bigwide.net/ns/other' => 'x']])->status, 403);
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => $pages, 'href' => $page('x'), 'properties' => [$client => 'https://evil.example/']])->status, 403);
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => $pages, 'href' => $page('x'), 'titles' => ['default' => str_repeat('a', 256)]])->status, 400);
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => $pages, 'href' => $page('x'), 'titles' => ['not a tag' => 'x']])->status, 400);
    // Changing the app's own link replaces titles and properties; the owner's can't be changed.
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => $pages, 'href' => $page('now'), 'type' => 'text/markdown', 'titles' => ['default' => 'Now']])->status, 201);
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => $pages, 'href' => $page('owner'), 'titles' => ['default' => 'Mine']])->status, 409);
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => $pages, 'href' => $page('owner')])->status, 201);
    eq($t->get('/.well-known/host-meta.json')->json()['links'], [
        ['rel' => $pages, 'href' => $page('owner')],
        ['rel' => 'me', 'href' => 'https://x'],
        ['rel' => $pages, 'href' => $page('now'), 'type' => 'text/markdown', 'titles' => ['default' => 'Now'], 'properties' => [$client => $c['clientId']]],
        ['rel' => $pages, 'href' => $page('imprint'), 'titles' => ['default' => 'Imprint', 'de' => 'Impressum'], 'properties' => [$hidden => 'true', $client => $c['clientId']]],
    ]);
    // The footer
    $footer = 'https://bigwide.net/ns/webpup-footer';
    eq($t->hostMeta($tok, ['action' => 'set-property', 'property' => $footer, 'value' => $page('footer')])->status, 201);
    eq($t->hostMeta($tok, ['action' => 'set-property', 'property' => $footer, 'value' => ORIGIN . '/feed/footer.md'])->status, 403);
    // Order: all links of the rel, each once, in their slots; the owner's link moves too.
    foreach ([[$page('now'), $page('owner')], [$page('now'), $page('now'), $page('owner'), $page('imprint')], [$page('now'), $page('owner'), $page('imprint'), $page('x')]] as $hrefs)
        eq($t->hostMeta($tok, ['action' => 'order', 'rel' => $pages, 'hrefs' => $hrefs])->status, 409, json_encode($hrefs));
    eq($t->hostMeta($tok, ['action' => 'order', 'rel' => 'https://bigwide.net/ns/feed', 'hrefs' => []])->status, 403);
    eq($t->hostMeta($tok, ['action' => 'order', 'rel' => $pages, 'hrefs' => [$page('imprint'), $page('owner'), $page('now')]])->status, 204);
    $links = $t->get('/.well-known/host-meta.json')->json()['links'];
    eq(array_column($links, 'href'), [$page('imprint'), 'https://x', $page('owner'), $page('now')]);
    eq($links[2], ['rel' => $pages, 'href' => $page('owner')]);
});

test('apps page: needs the password to view and to change, and never sets a cookie', function () {
    $t = new T();
    $t->connect($t->registerClient('app.example'), 'write:/appdata/app.example/');
    $res = $t->get('/pups/apps');
    eq($res->header('set-cookie'), null);
    notContains($res->text, 'app.example');
    $res = $t->post('/pups/apps', ['password' => 'nope']);
    eq($res->status, 401);
    notContains($res->text, 'app.example');
    $res = $t->post('/pups/apps', ['password' => PASSWORD]);
    eq($res->header('set-cookie'), null);
    contains($res->text, 'app.example');
    ok(preg_match('/name="revoke" value="([^"]+)"/', $res->text, $m), 'remove button');
    // A removal without the password shows nothing (unlike the former Node server, which showed the list).
    $res = $t->post('/pups/apps', ['revoke' => $m[1]]);
    eq($res->status, 401);
    notContains($res->text, 'app.example');
    eq(count($t->ctx->state->activeGrants()), 1);
});

test('apps page: can delete the files of a removed app, and remove links and properties', function () {
    $t = new T();
    $tok = $t->connect($t->registerClient('app.example'), 'write:/appdata/app.example/ write:/.well-known/about.md')['access_token'];
    $t->put('/appdata/app.example/a.json', $tok, '{}');
    $t->hostMeta($tok, ['action' => 'set-property', 'property' => 'https://bigwide.net/ns/name', 'value' => 'Alice']);
    $t->hostMeta($tok, ['action' => 'add', 'rel' => 'https://app.example/r', 'href' => ORIGIN . '/appdata/app.example/a.json']);
    $page = $t->post('/pups/apps', ['password' => PASSWORD]);
    contains($page->text, 'https://bigwide.net/ns/name');
    $res = $t->post('/pups/apps', ['password' => PASSWORD, 'remove_property' => 'https://bigwide.net/ns/name']);
    contains($res->text, 'The property was removed');
    $res = $t->post('/pups/apps', ['password' => PASSWORD, 'remove_link' => json_encode(['https://app.example/r', ORIGIN . '/appdata/app.example/a.json'], JSON_UNESCAPED_SLASHES)]);
    contains($res->text, 'The link was removed');
    eq(count($t->get('/.well-known/host-meta.json')->json()['links']), 1);
    ok(preg_match('/name="revoke_delete" value="([^"]+)"/', $res->text, $m), 'delete button');
    contains($t->post('/pups/apps', ['password' => PASSWORD, 'revoke_delete' => $m[1]])->text, 'Deleted 1 of its files');
    ok(!file_exists("$t->dataDir/files/appdata/app.example"), 'folder deleted');
});

test('persistence: keeps grants and tokens across restarts, storing only hashes', function () {
    $first = new T();
    $tok = $first->connect($first->registerClient('app.example'), 'write:/appdata/app.example/');
    $second = new T([], true, $first->dataDir);
    eq($second->put('/appdata/app.example/a.json', $tok['access_token'], '{}')->status, 201);
    $state = file_get_contents("$first->dataDir/state.json");
    notContains($state, $tok['access_token']);
    notContains($state, $tok['refresh_token']);
});

test('consent: identity, then one checkbox each for app data, feeds and profile, with the details collapsed', function () {
    $t = new T();
    $c = $t->registerClient('app.example');
    $scope = 'identify write:/appdata/app.example/ write:/feed.json write:/feed/photos.json write:/.well-known/following.opml write:/.well-known/about.md write:/pups/images/';
    $page = $t->get(T::authorizeUrl($c, $scope, T::pkce()['challenge']))->text;
    contains($page, '<input type="checkbox" checked disabled> <span>Learn that you are <strong>alice.pups.test</strong></span>');
    contains($page, '<input type="hidden" name="scope" value="identify">');
    contains($page, 'value="write:/appdata/app.example/" checked> <span>Store its own data</span>');
    contains($page, 'value="write:/feed.json write:/feed/photos.json write:/.well-known/following.opml" checked> <span>Manage your feeds</span>');
    contains($page, 'value="write:/.well-known/about.md write:/pups/images/" checked> <span>Manage your profile</span>');
    contains($page, '<li>its own folder (<code>/appdata/app.example/</code>)</li>');
    contains($page, '<li><code>/feed/photos.json</code></li>');
    contains($page, '<li>the list of people you follow (<code>/.well-known/following.opml</code>)</li>');
    contains($page, 'Add links to your <code>host-meta.json</code>: <code>https://bigwide.net/ns/feed</code>');
    contains($page, 'Set in your <code>host-meta.json</code>: <code>https://bigwide.net/ns/name</code>');
    eq([substr_count($page, '<details>'), substr_count($page, 'name="scope"'), str_contains($page, 'will learn your domain')], [3, 4, false]);

    // Dropping the feeds and the app data keeps identity and the profile.
    $tok = $t->connect($c, $scope, ['identify', 'write:/.well-known/about.md write:/pups/images/']);
    eq($tok['scope'], 'identify write:/.well-known/about.md write:/pups/images/');
});

test('apps page: the permissions are grouped as on the consent screen', function () {
    $t = new T();
    $t->connect($t->registerClient('app.example'), 'identify write:/appdata/app.example/ write:/feed.json write:/.well-known/about.md');
    $page = $t->post('/pups/apps', ['password' => PASSWORD])->text;
    contains($page, '<li>Learn that you are <strong>alice.pups.test</strong></li>');
    contains($page, "<li>Store its own data\n<details>");
    contains($page, "<li>Manage your feeds\n<details>");
    contains($page, '<li>your feed (<code>/feed.json</code>)</li>');
    contains($page, 'Set in your <code>host-meta.json</code>: <code>https://bigwide.net/ns/name</code>');
    eq(str_contains($page, 'Create, replace and delete your'), false);
});
