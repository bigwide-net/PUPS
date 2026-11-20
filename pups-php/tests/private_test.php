<?php
// Private areas (RFC-6 "Private areas"): /appdata/<client-host>/private/ and declared paths in /pups/private/.

namespace Pups\Test;

use function Pups\defaultWellKnown;
use function Pups\parseWellKnown;

/** A server that declares the default well-known paths and a private inbox. */
function withInbox(array $config = []): T
{
    return new T($config + ['well_known_paths' => [...defaultWellKnown(ORIGIN), ['path' => '/pups/private/inbox/', 'description' => 'your inbox']]]);
}

/** Every response for a private path, errors included, must not be cached. */
function noStore(Res $res, string $what, string $cacheControl = 'no-store'): void
{
    eq([$what, $res->header('cache-control'), $res->header('vary')], [$what, $cacheControl, 'Authorization']);
    eq($res->header('access-control-allow-origin'), '*', "$what: CORS");
}

test('private areas: an app writes and reads its private folder; nobody else can, and no answer tells whether a file exists', function () {
    $t = new T();
    $tok = $t->connect($t->registerClient('app.example'), 'write:/appdata/app.example/')['access_token'];
    $other = $t->connect($t->registerClient('other.example'), 'write:/appdata/other.example/')['access_token'];
    $identify = $t->connect($t->registerClient('reader.example'), 'identify')['access_token'];
    $file = '/appdata/app.example/private/drafts/a.json';
    $res = $t->put($file, $tok, '{"secret":1}', ['if-none-match' => '*']);
    eq($res->status, 201);
    $etag = $res->header('etag');
    $logged = implode("\n", array_filter(\Pups\Log::$lines, fn($l) => str_contains($l, 'file.created')));
    contains($logged, 'path=/appdata/app.example/private/drafts/a.json');
    notContains($logged, 'url=', 'no public URL for a private file');

    foreach (['GET', 'HEAD'] as $method) {
        $res = $t->req($method, $file, ['authorization' => "Bearer $tok"]);
        eq([$method, $res->status, $res->header('etag'), $res->text], [$method, 200, $etag, $method === 'GET' ? '{"secret":1}' : '']);
        noStore($res, "$method 200", 'private, no-store');
        foreach (['content-type' => 'application/json; charset=utf-8', 'x-content-type-options' => 'nosniff', 'content-security-policy' => 'sandbox'] as $k => $v)
            eq($res->header($k), $v, $k);
    }
    $res = $t->get($file, ['authorization' => "Bearer $tok", 'if-none-match' => $etag]);
    eq($res->status, 304);
    noStore($res, '304', 'private, no-store');

    // The same answers for an existing and a missing file, until the token covers the path.
    foreach ([$file, '/appdata/app.example/private/missing.json'] as $path) {
        foreach ([[], ['authorization' => 'Basic YTpi']] as $h) {
            $res = $t->get($path, $h);
            eq([$path, $res->status, $res->json()['error'], $res->header('www-authenticate')], [$path, 401, 'invalid_token', 'Bearer']);
            noStore($res, "$path without token");
        }
        $res = $t->req('HEAD', $path);
        eq([$res->status, $res->header('www-authenticate')], [401, 'Bearer']);
        noStore($res, 'HEAD without token');
        foreach (['Bearer invalid', 'Bearer'] as $auth) {
            $res = $t->get($path, ['authorization' => $auth]);
            eq([$path, $res->status, $res->json()['error'], $res->header('www-authenticate')], [$path, 401, 'invalid_token', 'Bearer error="invalid_token"']);
            noStore($res, "$path, $auth");
        }
        foreach ([$other, $identify] as $token) {
            $res = $t->get($path, ['authorization' => "Bearer $token"]);
            eq([$path, $res->status, $res->json()['error'], $res->header('www-authenticate')], [$path, 403, 'insufficient_scope', 'Bearer error="insufficient_scope"']);
            noStore($res, "$path, another app");
        }
    }
    $res = $t->get('/appdata/app.example/private/missing.json', ['authorization' => "Bearer $tok"]);
    eq([$res->status, $res->json()['error']], [404, 'not_found']);
    noStore($res, 'missing file');
    // An invalid path in the private area isn't cached either.
    noStore($t->get('/appdata/app.example/private/.hidden.json', ['authorization' => "Bearer $tok"]), 'invalid path');
    // Nor is the service worker refusal; the token is checked first.
    eq($t->get($file, ['service-worker' => 'script'])->status, 401);
    // Another spelling of the path on a case-insensitive disk is private too.
    foreach (['/APPDATA/app.example/PRIVATE/drafts/a.json', '/appdata/app.example/Private/drafts/a.json'] as $path)
        eq([$path, $t->get($path)->status], [$path, 401]);
    // Another app can't write there either.
    eq($t->put('/appdata/app.example/private/b.json', $other, '{}')->status, 403);

    // Public files are unchanged: no token needed, cached with revalidation.
    $t->put('/appdata/app.example/public.json', $tok, '{}');
    $res = $t->get('/appdata/app.example/public.json');
    eq([$res->status, $res->header('cache-control'), $res->header('vary')], [200, 'no-cache', 'Authorization']);
    eq($t->get('/appdata/app.example/private')->status, 404, 'a file named private is public');
    eq($t->get('/appdata/app.example/missing.json')->header('cache-control'), null, 'public 404s as before');
    eq($t->get('/appdata/app.example/public.json', ['authorization' => "Bearer $other"])->header('cache-control'), 'private, no-store');

    // Deleting works as for any file.
    eq($t->req('DELETE', $file, ['authorization' => "Bearer $tok"])->status, 204);
    eq($t->get($file, ['authorization' => "Bearer $tok"])->status, 404);
});

test('private areas: read and write scopes for a declared path in /pups/private/', function () {
    $t = withInbox(['post_fallback' => true]);
    $doc = $t->get('/personal-storage.json')->json();
    eq(array_values(array_filter($doc['well_known_paths'], fn($e) => $e['path'] === '/pups/private/inbox/')), [['path' => '/pups/private/inbox/']]);
    contains(json_encode($t->get('/.well-known/oauth-authorization-server')->json()['scopes_supported'], JSON_UNESCAPED_SLASHES), '"write:/pups/private/inbox/","read:/pups/private/inbox/"');

    $writer = $t->connect($t->registerClient('writer.example'), 'write:/pups/private/inbox/');
    eq($writer['scope'], 'write:/pups/private/inbox/');
    $writer = $writer['access_token'];
    $reader = $t->connect($t->registerClient('reader.example'), 'identify read:/pups/private/inbox/');
    eq($reader['scope'], 'identify read:/pups/private/inbox/');
    $reader = $reader['access_token'];
    $sub = $t->connect($t->registerClient('sub.example'), 'read:/pups/private/inbox/2026/')['access_token'];
    $own = $t->connect($t->registerClient('app.example'), 'write:/appdata/app.example/')['access_token'];

    $file = '/pups/private/inbox/2026/n1.json';
    eq($t->put($file, $writer, '{"n":1}')->status, 201);
    ok(is_file("$t->dataDir/files/pups/private/inbox/2026/n1.json"), 'stored with the other files, which the web server never serves');
    foreach (['writer' => $writer, 'reader' => $reader, 'sub' => $sub] as $who => $token) {
        $res = $t->get($file, ['authorization' => "Bearer $token"]);
        eq([$who, $res->status, $res->text], [$who, 200, '{"n":1}']);
        noStore($res, $who, 'private, no-store');
    }
    $res = $t->get($file, ['authorization' => "Bearer $own"]);
    eq($res->status, 403);
    noStore($res, 'another scope');
    eq($t->get('/pups/private/inbox/n0.json', ['authorization' => "Bearer $sub"])->status, 403, 'outside the narrower read scope');
    eq($t->get('/pups/private/inbox/missing.json', ['authorization' => "Bearer $reader"])->status, 404);
    $res = $t->get($file);
    eq([$res->status, $res->header('www-authenticate')], [401, 'Bearer']);
    noStore($res, 'no token');

    // A read scope never writes: not with PUT or DELETE, not through the POST fallback, not in host-meta.json.
    foreach ([$t->put($file, $reader, '{}'), $t->put('/pups/private/inbox/new.json', $reader, '{}'),
        $t->req('DELETE', $file, ['authorization' => "Bearer $reader"]),
        $t->req('POST', '/pups/post?method=PUT&path=%2Fpups%2Fprivate%2Finbox%2Fx.json', ['authorization' => "Bearer $reader", 'content-type' => 'application/json'], '{}'),
        $t->req('POST', '/pups/post?method=DELETE&path=%2Fpups%2Fprivate%2Finbox%2F2026%2Fn1.json', ['authorization' => "Bearer $reader"])] as $i => $res)
        eq([$i, $res->status, $res->json()['error']], [$i, 403, 'insufficient_scope']);
    eq($t->get($file, ['authorization' => "Bearer $reader"])->text, '{"n":1}', 'unchanged');
    ok(!is_file("$t->dataDir/files/pups/private/inbox/new.json"), 'nothing stored');
    eq($t->hostMeta($reader, ['action' => 'add', 'rel' => 'https://reader.example/rel/x', 'href' => ORIGIN . $file])->status, 403);

    // Read scopes exist only for declared private paths.
    $c = $t->registerClient('app.example');
    $challenge = T::pkce()['challenge'];
    foreach (['read:/pups/private/', 'read:/pups/private/other/', 'read:/pups/private/inboxx/', 'read:/feed/', 'read:/feed.json', 'read:/pups/images/',
        'read:/appdata/app.example/', 'read:/appdata/app.example/private/', 'read:/', 'read:/pups/private/inbox/../x/', 'write:/pups/private/', 'write:/pups/private/other/'] as $scope) {
        $loc = $t->get(T::authorizeUrl($c, $scope, $challenge))->location();
        eq([$scope, $loc['error'] ?? null], [$scope, 'invalid_scope']);
        contains($loc['error_description'], 'private');
    }
    $plain = new T();
    eq($plain->get(T::authorizeUrl($plain->registerClient('app.example'), 'read:/pups/private/inbox/', $challenge))->location()['error'] ?? null, 'invalid_scope', 'not declared by default');
});

test('private areas: a group of their own on the consent screen and the apps page', function () {
    $t = withInbox();
    $c = $t->registerClient('app.example');
    $page = $t->get(T::authorizeUrl($c, 'identify read:/pups/private/inbox/', T::pkce()['challenge']))->text;
    contains($page, 'value="read:/pups/private/inbox/" checked> <span>Read your private data</span>');
    contains($page, '<li>read your inbox (<code>/pups/private/inbox/</code>)</li>');
    notContains($page, 'Manage your profile');

    $scope = 'write:/.well-known/about.md write:/pups/private/inbox/2026/ read:/pups/private/inbox/';
    $page = $t->get(T::authorizeUrl($c, $scope, T::pkce()['challenge']))->text;
    contains($page, 'value="write:/.well-known/about.md" checked> <span>Manage your profile</span>');
    contains($page, 'value="write:/pups/private/inbox/2026/ read:/pups/private/inbox/" checked> <span>Manage your private data</span>');
    contains($page, '<li>read, create, replace and delete files under <code>/pups/private/inbox/2026/</code></li>');
    contains($page, '<li>read your inbox (<code>/pups/private/inbox/</code>)</li>');
    ok(strpos($page, 'Manage your profile') < strpos($page, 'Manage your private data'), 'private data comes last');

    $t->connect($c, 'identify read:/pups/private/inbox/');
    $apps = $t->post('/pups/apps', ['password' => PASSWORD])->text;
    contains($apps, "<li>Read your private data\n<details>");
    contains($apps, '<li>read your inbox (<code>/pups/private/inbox/</code>)</li>');
});

test('private areas: private files cannot be linked or used as property values in host-meta.json', function () {
    $t = new T();
    $tok = $t->connect($t->registerClient('app.example'), 'write:/appdata/app.example/ write:/pups/images/')['access_token'];
    $t->put('/appdata/app.example/private/a.png', $tok, 'PNG', ['content-type' => 'image/png']);
    $res = $t->hostMeta($tok, ['action' => 'add', 'rel' => 'https://app.example/rel/x', 'href' => ORIGIN . '/appdata/app.example/private/a.png']);
    eq($res->status, 403);
    contains($res->json()['message'], "Private files can't be linked");
    $res = $t->hostMeta($tok, ['action' => 'set-property', 'property' => 'https://bigwide.net/ns/avatar', 'value' => ORIGIN . '/appdata/app.example/private/a.png']);
    eq($res->status, 403);
    contains($res->json()['message'], "Private files can't be linked");
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => 'https://app.example/rel/x', 'href' => ORIGIN . '/appdata/app.example/a.png'])->status, 201, 'public files can');
});

test('private areas: configuration of paths in /pups/private/', function () {
    eq(parseWellKnown([['path' => '/pups/private/inbox/']], ORIGIN)[0]['path'], '/pups/private/inbox/');
    $settings = parseWellKnown([['path' => '/pups/private/settings.json', 'description' => 'your settings']], ORIGIN)[0];
    eq([$settings['path'], $settings['url'], $settings['rels'], $settings['description']], ['/pups/private/settings.json', null, [], 'your settings']);
    foreach (['url' => ORIGIN . '/pups/private/inbox/', 'rels' => ['r'], 'properties' => ['p'], 'link_properties' => ['p'], 'url_properties' => ['p']] as $k => $v)
        throws(fn() => parseWellKnown([['path' => '/pups/private/inbox/', $k => $v]], ORIGIN), 'Private paths have no');
    foreach (['/pups/private/', '/pups/privatex/', '/PUPS/private/inbox/', '/pups/Private/inbox/', '/APPDATA/x/', '/pups/private/.x/'] as $p)
        throws(fn() => parseWellKnown([['path' => $p]], ORIGIN), '');
    eq(array_filter(parseWellKnown(null, ORIGIN), fn($e) => str_contains($e['path'], 'private')), [], 'none by default');
});
